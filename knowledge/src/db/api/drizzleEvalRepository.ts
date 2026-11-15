import { and, asc, cosineDistance, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { KnowledgeDb, KnowledgeExecutor, KnowledgeTx } from '../index.js';
import { evalQuestionSessions, evalQuestions, evalResults, evalRuns } from '../schema.js';
import type {
  EvalQuestionRecord,
  EvalRepository,
  EvalRunRecord,
  EvalRunWithResults,
  PromoteOutcome,
  UpdateOutcome,
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
  retiredAt: evalQuestions.retiredAt,
  createdAt: evalQuestions.createdAt,
};

/** `retired_at` for a status change: set on becoming retired, kept if already retired, else cleared. */
function retiredAtFor(
  current: EvalQuestionRecord,
  status: EvalQuestionRecord['status'],
  now: Date,
): Date | null {
  if (status !== 'retired') return null;
  return current.status === 'retired' ? current.retiredAt : now;
}

/** Least recently asked first; ties go to the oldest, then the lowest id, so the order is total. */
const leastRecentlyAsked = [
  asc(evalQuestions.lastAskedAt),
  asc(evalQuestions.createdAt),
  asc(evalQuestions.id),
];

/**
 * Serializes the owner's eval-set writes that read before they write
 * (seeding, promotion, status-guarded updates), for the rest of the transaction. A different key
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
        .where(
          and(
            eq(evalQuestions.ownerId, ownerId),
            inArray(evalQuestions.status, ['candidate', 'active']),
          ),
        )
        .orderBy(distance)
        .limit(1);
      if (!row) return null;
      const { distance: d, ...question } = row;
      return { question, similarity: 1 - Number(d) };
    },

    async createCandidate(input) {
      return db.transaction(async (tx) => {
        // The promotion lock: the cap below never races an owner promoting a candidate.
        await lockEvalSet(tx, input.ownerId);
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

        // The cap: the least recently asked candidates beyond it go.
        const excess = await tx
          .select({ id: evalQuestions.id })
          .from(evalQuestions)
          .where(
            and(eq(evalQuestions.ownerId, input.ownerId), eq(evalQuestions.status, 'candidate')),
          )
          .orderBy(
            desc(evalQuestions.lastAskedAt),
            desc(evalQuestions.createdAt),
            desc(evalQuestions.id),
          )
          .offset(input.maxCandidates);
        if (excess.length > 0) {
          // Still a candidate at delete time, belt and braces with the lock.
          await tx.delete(evalQuestions).where(
            and(
              inArray(
                evalQuestions.id,
                excess.map((e) => e.id),
              ),
              eq(evalQuestions.status, 'candidate'),
            ),
          );
        }
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

    async promote(ownerId, id, maxActive, now): Promise<PromoteOutcome> {
      return db.transaction(async (tx) => {
        await lockEvalSet(tx, ownerId);
        const target = await findQuestion(tx, ownerId, id);
        if (!target) return { status: 'not-found' };
        if (target.status === 'active') {
          return { status: 'promoted', question: target, evicted: [] };
        }

        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(evalQuestions)
          .where(and(eq(evalQuestions.ownerId, ownerId), eq(evalQuestions.status, 'active')));
        // Room for one more: down to maxActive - 1 before it joins, even if
        // the set somehow grew past its size.
        const needed = Math.max(0, (count?.n ?? 0) - maxActive + 1);
        let evicted: EvalQuestionRecord[] = [];
        if (needed > 0) {
          const victims = await tx
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
            .limit(needed);
          if (victims.length < needed) return { status: 'full' };
          evicted = await tx
            .update(evalQuestions)
            .set({ status: 'retired', retiredAt: now })
            .where(
              inArray(
                evalQuestions.id,
                victims.map((v) => v.id),
              ),
            )
            .returning(questionColumns);
        }

        const [promoted] = await tx
          .update(evalQuestions)
          .set({ status: 'active', offTopic: false, retiredAt: null })
          .where(eq(evalQuestions.id, id))
          .returning(questionColumns);
        if (!promoted) throw new Error('eval question promotion returned no row');
        return { status: 'promoted', question: promoted, evicted };
      });
    },

    async updateQuestion(ownerId, id, patch, onlyIf, now): Promise<UpdateOutcome> {
      return db.transaction(async (tx) => {
        // The same lock as promotion, so the status checked here is the one written over.
        await lockEvalSet(tx, ownerId);
        const current = await findQuestion(tx, ownerId, id);
        if (!current) return { status: 'not-found' };
        if (onlyIf && !onlyIf.includes(current.status)) {
          return { status: 'conflict', question: current };
        }
        if (Object.keys(patch).length === 0) return { status: 'updated', question: current };
        const set =
          patch.status === undefined
            ? patch
            : { ...patch, retiredAt: retiredAtFor(current, patch.status, now) };
        const [row] = await tx
          .update(evalQuestions)
          .set(set)
          .where(eq(evalQuestions.id, id))
          .returning(questionColumns);
        if (!row) throw new Error('eval question update returned no row');
        return { status: 'updated', question: row };
      });
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

    async purgeStale(ownerId, before) {
      const deleted = await db
        .delete(evalQuestions)
        .where(
          and(
            eq(evalQuestions.ownerId, ownerId),
            or(
              and(eq(evalQuestions.status, 'candidate'), lt(evalQuestions.lastAskedAt, before)),
              and(
                eq(evalQuestions.status, 'retired'),
                eq(evalQuestions.origin, 'visitor'),
                lt(evalQuestions.retiredAt, before),
              ),
            ),
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
      return db.transaction(async (tx) => {
        // Only a run still `running`: one abandoned at boot stays failed.
        const closed = await tx
          .update(evalRuns)
          .set({ status: outcome.status, error: outcome.error, finishedAt: sql`now()` })
          .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, 'running')))
          .returning({ id: evalRuns.id });
        if (closed.length === 0) return false;
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
        return true;
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
