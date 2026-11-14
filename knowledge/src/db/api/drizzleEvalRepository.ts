import { and, asc, cosineDistance, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { KnowledgeDb, KnowledgeExecutor, KnowledgeTx } from '../index.js';
import { evalQuestionSessions, evalQuestions, evalResults, evalRuns } from '../schema.js';
import type {
  EvalQuestionRecord,
  EvalRepository,
  EvalRunRecord,
  EvalRunWithResults,
  PromoteOutcome,
} from './evalRepository.js';

/** Every question column except the embedding, which is large. */
const questionColumns = {
  id: evalQuestions.id,
  ownerId: evalQuestions.ownerId,
  question: evalQuestions.question,
  status: evalQuestions.status,
  origin: evalQuestions.origin,
  pinned: evalQuestions.pinned,
  offTopic: evalQuestions.offTopic,
  hitCount: evalQuestions.hitCount,
  distinctSessions: evalQuestions.distinctSessions,
  lastAskedAt: evalQuestions.lastAskedAt,
  createdAt: evalQuestions.createdAt,
};

/** Least recently asked first; ties go to the oldest, then the lowest id, so the order is total. */
const leastRecentlyAsked = [
  asc(evalQuestions.lastAskedAt),
  asc(evalQuestions.createdAt),
  asc(evalQuestions.id),
];

/**
 * Serializes the owner's eval-set writes that read before they write
 * (seeding, promotion), for the rest of the transaction. A different key
 * from the document repository's lock, so the two never wait on each other.
 */
async function lockEvalSet(tx: KnowledgeTx, ownerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`eval:${ownerId}`}))`);
}

async function findQuestion(
  executor: KnowledgeExecutor,
  ownerId: string,
  id: string,
): Promise<EvalQuestionRecord | null> {
  const [row] = await executor
    .select(questionColumns)
    .from(evalQuestions)
    .where(and(eq(evalQuestions.ownerId, ownerId), eq(evalQuestions.id, id)))
    .limit(1);
  return row ?? null;
}

async function withResults(
  executor: KnowledgeExecutor,
  run: EvalRunRecord | undefined,
): Promise<EvalRunWithResults | null> {
  if (!run) return null;
  const results = await executor
    .select({
      questionId: evalResults.questionId,
      question: evalResults.question,
      answer: evalResults.answer,
      chunkIds: evalResults.chunkIds,
      topSimilarity: evalResults.topSimilarity,
      gap: evalResults.gap,
    })
    .from(evalResults)
    .where(eq(evalResults.runId, run.id))
    .orderBy(asc(evalResults.ordinal));
  return { ...run, results };
}

export function createDrizzleEvalRepository(db: KnowledgeDb): EvalRepository {
  return {
    async seedIfEmpty(ownerId, questions, now) {
      if (questions.length === 0) return false;
      return db.transaction(async (tx) => {
        await lockEvalSet(tx, ownerId);
        const [existing] = await tx
          .select({ id: evalQuestions.id })
          .from(evalQuestions)
          .where(eq(evalQuestions.ownerId, ownerId))
          .limit(1);
        if (existing) return false;
        await tx.insert(evalQuestions).values(
          questions.map((q) => ({
            ownerId,
            question: q.question,
            embedding: q.embedding,
            status: 'active' as const,
            origin: 'canned' as const,
            lastAskedAt: now,
          })),
        );
        return true;
      });
    },

    async nearestQuestion(ownerId, embedding) {
      const distance = cosineDistance(evalQuestions.embedding, embedding);
      const [row] = await db
        .select({ ...questionColumns, distance: sql<number>`${distance}` })
        .from(evalQuestions)
        .where(eq(evalQuestions.ownerId, ownerId))
        .orderBy(distance)
        .limit(1);
      if (!row) return null;
      const { distance: d, ...question } = row;
      return { question, similarity: 1 - Number(d) };
    },

    async createCandidate(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(evalQuestions)
          .values({
            ownerId: input.ownerId,
            question: input.question,
            embedding: input.embedding,
            status: 'candidate',
            origin: 'visitor',
            offTopic: input.offTopic,
            hitCount: 1,
            distinctSessions: 1,
            lastAskedAt: input.now,
          })
          .returning(questionColumns);
        if (!row) throw new Error('eval question insert returned no row');
        await tx
          .insert(evalQuestionSessions)
          .values({ questionId: row.id, sessionHash: input.sessionHash });
        return row;
      });
    },

    async recordAsk(id, sessionHash, now) {
      return db.transaction(async (tx) => {
        // The update below locks the row, so concurrent asks are counted one at a time.
        const [exists] = await tx
          .select({ id: evalQuestions.id })
          .from(evalQuestions)
          .where(eq(evalQuestions.id, id))
          .for('update');
        if (!exists) return null;
        const inserted = await tx
          .insert(evalQuestionSessions)
          .values({ questionId: id, sessionHash })
          .onConflictDoNothing()
          .returning({ questionId: evalQuestionSessions.questionId });
        const [row] = await tx
          .update(evalQuestions)
          .set({
            hitCount: sql`${evalQuestions.hitCount} + 1`,
            distinctSessions: sql`${evalQuestions.distinctSessions} + ${inserted.length}`,
            // Asks can be recorded out of order; the clock never moves back.
            lastAskedAt: sql`greatest(${evalQuestions.lastAskedAt}, ${now.toISOString()}::timestamptz)`,
          })
          .where(eq(evalQuestions.id, id))
          .returning(questionColumns);
        return row ?? null;
      });
    },

    async promote(ownerId, id, maxActive): Promise<PromoteOutcome> {
      return db.transaction(async (tx) => {
        await lockEvalSet(tx, ownerId);
        const target = await findQuestion(tx, ownerId, id);
        if (!target) return { status: 'not-found' };
        if (target.status === 'active') {
          return { status: 'promoted', question: target, evicted: null };
        }

        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(evalQuestions)
          .where(and(eq(evalQuestions.ownerId, ownerId), eq(evalQuestions.status, 'active')));
        let evicted: EvalQuestionRecord | null = null;
        if ((count?.n ?? 0) >= maxActive) {
          const [victim] = await tx
            .select({ id: evalQuestions.id })
            .from(evalQuestions)
            .where(
              and(
                eq(evalQuestions.ownerId, ownerId),
                eq(evalQuestions.status, 'active'),
                eq(evalQuestions.pinned, false),
                ne(evalQuestions.id, id),
              ),
            )
            .orderBy(...leastRecentlyAsked)
            .limit(1);
          if (!victim) return { status: 'full' };
          const [retired] = await tx
            .update(evalQuestions)
            .set({ status: 'retired' })
            .where(eq(evalQuestions.id, victim.id))
            .returning(questionColumns);
          evicted = retired ?? null;
        }

        const [promoted] = await tx
          .update(evalQuestions)
          .set({ status: 'active', offTopic: false })
          .where(eq(evalQuestions.id, id))
          .returning(questionColumns);
        if (!promoted) throw new Error('eval question promotion returned no row');
        return { status: 'promoted', question: promoted, evicted };
      });
    },

    async updateQuestion(ownerId, id, patch) {
      if (Object.keys(patch).length === 0) return findQuestion(db, ownerId, id);
      const [row] = await db
        .update(evalQuestions)
        .set(patch)
        .where(and(eq(evalQuestions.ownerId, ownerId), eq(evalQuestions.id, id)))
        .returning(questionColumns);
      return row ?? null;
    },

    async getQuestion(ownerId, id) {
      return findQuestion(db, ownerId, id);
    },

    async listQuestions(ownerId) {
      return db
        .select(questionColumns)
        .from(evalQuestions)
        .where(eq(evalQuestions.ownerId, ownerId))
        .orderBy(
          sql`case ${evalQuestions.status} when 'active' then 0 when 'candidate' then 1 else 2 end`,
          desc(evalQuestions.lastAskedAt),
          asc(evalQuestions.id),
        );
    },

    async listActiveWithEmbeddings(ownerId) {
      return db
        .select({ ...questionColumns, embedding: evalQuestions.embedding })
        .from(evalQuestions)
        .where(and(eq(evalQuestions.ownerId, ownerId), eq(evalQuestions.status, 'active')))
        .orderBy(asc(evalQuestions.createdAt), asc(evalQuestions.id));
    },

    async purgeCandidates(ownerId, before) {
      const deleted = await db
        .delete(evalQuestions)
        .where(
          and(
            eq(evalQuestions.ownerId, ownerId),
            eq(evalQuestions.status, 'candidate'),
            lt(evalQuestions.lastAskedAt, before),
          ),
        )
        .returning({ id: evalQuestions.id });
      return deleted.length;
    },

    async createRun(ownerId, corpusVersion, trigger) {
      const [row] = await db
        .insert(evalRuns)
        .values({ ownerId, corpusVersion, trigger })
        .returning();
      if (!row) throw new Error('eval run insert returned no row');
      return row;
    },

    async finishRun(runId, outcome) {
      await db.transaction(async (tx) => {
        if (outcome.results.length > 0) {
          await tx.insert(evalResults).values(
            outcome.results.map((r, ordinal) => ({
              runId,
              ordinal,
              questionId: r.questionId,
              question: r.question,
              answer: r.answer,
              chunkIds: r.chunkIds,
              topSimilarity: r.topSimilarity,
              gap: r.gap,
            })),
          );
        }
        await tx
          .update(evalRuns)
          .set({ status: outcome.status, error: outcome.error, finishedAt: sql`now()` })
          .where(eq(evalRuns.id, runId));
      });
    },

    async abandonRunning(reason) {
      const rows = await db
        .update(evalRuns)
        .set({ status: 'failed', error: reason, finishedAt: sql`now()` })
        .where(eq(evalRuns.status, 'running'))
        .returning({ id: evalRuns.id });
      return rows.length;
    },

    async getLatestRun(ownerId) {
      const [run] = await db
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.ownerId, ownerId))
        .orderBy(desc(evalRuns.startedAt), desc(evalRuns.id))
        .limit(1);
      return withResults(db, run);
    },

    async getPreviousCompletedRun(ownerId, corpusVersion) {
      const [run] = await db
        .select()
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.ownerId, ownerId),
            eq(evalRuns.status, 'completed'),
            lt(evalRuns.corpusVersion, corpusVersion),
          ),
        )
        .orderBy(desc(evalRuns.startedAt), desc(evalRuns.id))
        .limit(1);
      return withResults(db, run);
    },

    async getLatestCompletedRun(ownerId) {
      const [run] = await db
        .select()
        .from(evalRuns)
        .where(and(eq(evalRuns.ownerId, ownerId), eq(evalRuns.status, 'completed')))
        .orderBy(desc(evalRuns.startedAt), desc(evalRuns.id))
        .limit(1);
      return run ?? null;
    },
  };
}
