import { randomUUID } from 'node:crypto';
import type {
  EvalQuestionRecord,
  EvalQuestionWithEmbedding,
  EvalRepository,
  EvalResultRecord,
  EvalRunRecord,
  EvalRunWithResults,
} from '../../db/api/evalRepository.js';

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const STATUS_ORDER = { active: 0, candidate: 1, retired: 2 } as const;

/**
 * An in-memory EvalRepository with the same observable behaviour as the
 * Drizzle one (both pass `evalRepositoryContract.ts`).
 */
export function createMemoryEvalRepository(): EvalRepository & {
  questions: Map<string, EvalQuestionWithEmbedding>;
  sessions: Map<string, Set<string>>;
  runs: Map<string, EvalRunWithResults>;
} {
  const questions = new Map<string, EvalQuestionWithEmbedding>();
  const sessions = new Map<string, Set<string>>();
  const runs = new Map<string, EvalRunWithResults>();
  // Insertion order breaks timestamp ties, as the database's clock almost always does.
  const runSeq = new Map<string, number>();
  let seq = 0;

  const strip = ({ embedding: _embedding, ...record }: EvalQuestionWithEmbedding) => {
    void _embedding;
    return { ...record };
  };
  const ownerQuestions = (ownerId: string) =>
    [...questions.values()].filter((q) => q.ownerId === ownerId);
  const lru = (a: EvalQuestionRecord, b: EvalQuestionRecord) =>
    a.lastAskedAt.getTime() - b.lastAskedAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id);
  const newestRun = (list: EvalRunWithResults[]) =>
    list.sort(
      (a, b) =>
        b.startedAt.getTime() - a.startedAt.getTime() ||
        (runSeq.get(b.id) ?? 0) - (runSeq.get(a.id) ?? 0),
    )[0] ?? null;
  const copyRun = (run: EvalRunWithResults | null) =>
    run && { ...run, results: run.results.map((r) => ({ ...r, chunkIds: [...r.chunkIds] })) };

  return {
    questions,
    sessions,
    runs,

    async seedIfEmpty(ownerId, canned, now) {
      if (canned.length === 0 || ownerQuestions(ownerId).length > 0) return false;
      for (const q of canned) {
        const id = randomUUID();
        questions.set(id, {
          id,
          ownerId,
          question: q.question,
          embedding: q.embedding,
          status: 'active',
          origin: 'canned',
          pinned: false,
          offTopic: false,
          hitCount: 0,
          distinctSessions: 0,
          lastAskedAt: now,
          createdAt: now,
        });
      }
      return true;
    },

    async nearestQuestion(ownerId, embedding) {
      let best: { question: EvalQuestionRecord; similarity: number } | null = null;
      for (const q of ownerQuestions(ownerId)) {
        const similarity = cosine(q.embedding, embedding);
        if (!best || similarity > best.similarity) best = { question: strip(q), similarity };
      }
      return best;
    },

    async createCandidate(input) {
      const id = randomUUID();
      const record: EvalQuestionWithEmbedding = {
        id,
        ownerId: input.ownerId,
        question: input.question,
        embedding: input.embedding,
        status: 'candidate',
        origin: 'visitor',
        pinned: false,
        offTopic: input.offTopic,
        hitCount: 1,
        distinctSessions: 1,
        lastAskedAt: input.now,
        createdAt: input.now,
      };
      questions.set(id, record);
      sessions.set(id, new Set([input.sessionHash]));
      return strip(record);
    },

    async recordAsk(id, sessionHash, now) {
      const q = questions.get(id);
      if (!q) return null;
      const seen = sessions.get(id) ?? new Set<string>();
      const isNew = !seen.has(sessionHash);
      seen.add(sessionHash);
      sessions.set(id, seen);
      const updated: EvalQuestionWithEmbedding = {
        ...q,
        hitCount: q.hitCount + 1,
        distinctSessions: q.distinctSessions + (isNew ? 1 : 0),
        lastAskedAt: now > q.lastAskedAt ? now : q.lastAskedAt,
      };
      questions.set(id, updated);
      return strip(updated);
    },

    async promote(ownerId, id, maxActive) {
      const target = questions.get(id);
      if (!target || target.ownerId !== ownerId) return { status: 'not-found' };
      if (target.status === 'active') {
        return { status: 'promoted', question: strip(target), evicted: null };
      }
      const active = ownerQuestions(ownerId).filter((q) => q.status === 'active');
      let evicted: EvalQuestionRecord | null = null;
      if (active.length >= maxActive) {
        const victim = active.filter((q) => !q.pinned && q.id !== id).sort(lru)[0];
        if (!victim) return { status: 'full' };
        const retired = { ...victim, status: 'retired' as const };
        questions.set(victim.id, retired);
        evicted = strip(retired);
      }
      const promoted = { ...target, status: 'active' as const, offTopic: false };
      questions.set(id, promoted);
      return { status: 'promoted', question: strip(promoted), evicted };
    },

    async updateQuestion(ownerId, id, patch) {
      const q = questions.get(id);
      if (!q || q.ownerId !== ownerId) return null;
      const updated = { ...q, ...patch };
      questions.set(id, updated);
      return strip(updated);
    },

    async getQuestion(ownerId, id) {
      const q = questions.get(id);
      return q && q.ownerId === ownerId ? strip(q) : null;
    },

    async listQuestions(ownerId) {
      return ownerQuestions(ownerId)
        .sort(
          (a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            b.lastAskedAt.getTime() - a.lastAskedAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map(strip);
    },

    async listActiveWithEmbeddings(ownerId) {
      return ownerQuestions(ownerId)
        .filter((q) => q.status === 'active')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .map((q) => ({ ...q, embedding: [...q.embedding] }));
    },

    async purgeCandidates(ownerId, before) {
      let count = 0;
      for (const q of ownerQuestions(ownerId)) {
        if (q.status === 'candidate' && q.lastAskedAt < before) {
          questions.delete(q.id);
          sessions.delete(q.id);
          for (const run of runs.values()) {
            for (const r of run.results) if (r.questionId === q.id) r.questionId = null;
          }
          count++;
        }
      }
      return count;
    },

    async createRun(ownerId, corpusVersion, trigger) {
      const run: EvalRunWithResults = {
        id: randomUUID(),
        ownerId,
        corpusVersion,
        trigger,
        status: 'running',
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        results: [],
      };
      runs.set(run.id, run);
      runSeq.set(run.id, ++seq);
      const { results: _results, ...record } = run;
      void _results;
      return record;
    },

    async finishRun(runId, outcome) {
      const run = runs.get(runId);
      if (!run) return;
      runs.set(runId, {
        ...run,
        status: outcome.status,
        error: outcome.error,
        finishedAt: new Date(),
        results: outcome.results.map((r: EvalResultRecord) => ({
          ...r,
          chunkIds: [...r.chunkIds],
        })),
      });
    },

    async abandonRunning(reason) {
      let count = 0;
      for (const run of runs.values()) {
        if (run.status === 'running') {
          runs.set(run.id, { ...run, status: 'failed', error: reason, finishedAt: new Date() });
          count++;
        }
      }
      return count;
    },

    async getLatestRun(ownerId) {
      return copyRun(newestRun([...runs.values()].filter((r) => r.ownerId === ownerId)));
    },

    async getPreviousCompletedRun(ownerId, corpusVersion) {
      return copyRun(
        newestRun(
          [...runs.values()].filter(
            (r) =>
              r.ownerId === ownerId && r.status === 'completed' && r.corpusVersion < corpusVersion,
          ),
        ),
      );
    },

    async getLatestCompletedRun(ownerId): Promise<EvalRunRecord | null> {
      const run = newestRun(
        [...runs.values()].filter((r) => r.ownerId === ownerId && r.status === 'completed'),
      );
      if (!run) return null;
      const { results: _results, ...record } = run;
      void _results;
      return record;
    },
  };
}
