import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_RETRIEVE_K, type EvalRunTrigger } from '../../contract.js';
import type {
  EvalQuestionWithEmbedding,
  EvalRepository,
  EvalResultRecord,
} from '../../db/api/evalRepository.js';
import type { KnowledgeRepository, RetrievedChunk } from '../../db/api/repository.js';
import { SerialQueue } from '../ingestion/queue.js';
import { ModelError } from '../llm/minimax.js';
import type { EvalAnswerer } from './answerer.js';
import type { EvalSet } from './evalSet.js';

/**
 * Runs the active eval questions against the corpus (#85): for each, the
 * chunks retrieval returns (reusing the question's stored embedding), the
 * best similarity, a gap flag when that is below the gap threshold, and an
 * answer when an answering model is configured.
 *
 * A run is queued on every corpus change and on the owner's request. Runs go
 * one at a time, at most one waiting per owner: a burst of uploads costs one
 * run at the end, at the version it then reads. A corpus-triggered run is
 * skipped when the newest completed run is already at the current version
 * (a failed first ingest, for one, does not change the corpus). Within a run,
 * a few questions are worked on at once; results keep the questions' order.
 *
 * Not durable: a run cut off by a restart is marked failed on the next boot
 * (`abandonRunning`), and the next corpus change or the owner runs it again.
 */

const RUN_FAILED = 'The eval run failed unexpectedly. Run it again.';
export const RUN_INTERRUPTED = 'Interrupted by a restart. Run it again.';
/** One answer may take this long; then the question records retrieval only. */
export const DEFAULT_ANSWER_TIMEOUT_MS = 60_000;
/** Questions worked on at once: enough to hide model latency, few enough for rate limits. */
export const DEFAULT_RUN_CONCURRENCY = 3;

export interface EvalRunnerDeps {
  evalRepo: EvalRepository;
  repo: Pick<KnowledgeRepository, 'search' | 'getVersion'>;
  evalSet: Pick<EvalSet, 'ensureSeeded' | 'settings'>;
  answerer: EvalAnswerer | null;
  log: FastifyBaseLogger;
  /** Chunks retrieved per question; the chat's default. */
  k?: number;
  answerTimeoutMs?: number;
  concurrency?: number;
}

export interface EvalRunner {
  /** False when no answering model is configured: runs record retrieval only. */
  readonly answering: boolean;
  /** Queues a run for the owner unless one is already waiting. Returns false when none was added. */
  request(ownerId: string, trigger: EvalRunTrigger): boolean;
  /** Called after anything that may have changed the corpus. */
  corpusChanged(ownerId: string): void;
  /** True while a run for the owner is waiting or in progress. */
  isRunning(ownerId: string): boolean;
  idle(): Promise<void>;
  stop(): Promise<number>;
}

class AnswerTimeoutError extends Error {
  constructor(ms: number) {
    super(`The answer took longer than ${ms} ms`);
    this.name = 'AnswerTimeoutError';
  }
}

/**
 * `run` over `items` with at most `limit` at once; results in the items'
 * order. The first failure aborts `controller`: no worker takes another item
 * after it, and work in flight sees the signal (an answer's model call stops).
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  controller: AbortController,
  run: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (!controller.signal.aborted && next < items.length) {
      const i = next++;
      try {
        results[i] = await run(items[i] as T, controller.signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

export function createEvalRunner(deps: EvalRunnerDeps): EvalRunner {
  const { evalRepo, repo, evalSet, answerer, log } = deps;
  const k = deps.k ?? DEFAULT_RETRIEVE_K;
  const answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
  const concurrency = deps.concurrency ?? DEFAULT_RUN_CONCURRENCY;

  // The trigger of the run waiting for each owner. A manual request while a
  // corpus run waits upgrades it, so the owner's run is never skipped.
  const waiting = new Map<string, EvalRunTrigger>();
  const queue = new SerialQueue<{ id: string }>(
    ({ id }) => {
      const trigger = waiting.get(id) ?? 'corpus';
      waiting.delete(id);
      return run(id, trigger);
    },
    ({ id }, error) => log.error({ ownerId: id, err: error }, 'Eval runner crashed'),
  );

  function request(ownerId: string, trigger: EvalRunTrigger): boolean {
    if (queue.isWaiting(ownerId)) {
      if (trigger === 'manual') waiting.set(ownerId, 'manual');
      return false;
    }
    if (!queue.enqueue({ id: ownerId })) return false;
    waiting.set(ownerId, trigger);
    return true;
  }

  /**
   * The answer, or null on failure or after `answerTimeoutMs`. The signal
   * (the run's, plus the timeout) reaches the model call, so a timed-out or
   * abandoned answer stops instead of running on; the race only covers an
   * answerer that ignores it.
   */
  async function answer(
    question: string,
    chunks: RetrievedChunk[],
    runSignal: AbortSignal,
  ): Promise<string | null> {
    if (!answerer) return null;
    const signal = AbortSignal.any([runSignal, AbortSignal.timeout(answerTimeoutMs)]);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        answerer.answer(question, chunks, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AnswerTimeoutError(answerTimeoutMs)),
            answerTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (runSignal.aborted) throw error;
      const detail = error instanceof ModelError ? error.detail : undefined;
      log.warn({ err: error, detail }, 'Eval answer failed; recording retrieval only');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function evaluate(
    ownerId: string,
    q: EvalQuestionWithEmbedding,
    signal: AbortSignal,
  ): Promise<EvalResultRecord> {
    const chunks = await repo.search(ownerId, q.embedding, k);
    const topSimilarity = chunks[0]?.similarity ?? null;
    return {
      questionId: q.id,
      question: q.question,
      answer: await answer(q.question, chunks, signal),
      chunkIds: chunks.map((c) => c.chunkId),
      topSimilarity,
      gap: topSimilarity === null || topSimilarity < evalSet.settings.gapSimilarity,
    };
  }

  async function run(ownerId: string, trigger: EvalRunTrigger): Promise<void> {
    const version = await repo.getVersion(ownerId);
    if (trigger === 'corpus') {
      const latest = await evalRepo.getLatestCompletedRun(ownerId);
      if (latest && latest.corpusVersion === version) return;
    }
    await evalSet.ensureSeeded(ownerId);

    const started = Date.now();
    const runRecord = await evalRepo.createRun(ownerId, version, trigger);
    try {
      const questions = await evalRepo.listActiveWithEmbeddings(ownerId);
      const results = await mapBounded(questions, concurrency, new AbortController(), (q, signal) =>
        evaluate(ownerId, q, signal),
      );
      const stored = await evalRepo.finishRun(runRecord.id, {
        status: 'completed',
        error: null,
        results,
      });
      if (!stored) {
        log.warn({ runId: runRecord.id }, 'Eval run was closed meanwhile; results dropped');
        return;
      }
      log.info(
        {
          runId: runRecord.id,
          version,
          trigger,
          questions: results.length,
          gaps: results.filter((r) => r.gap).length,
          ms: Date.now() - started,
        },
        'Eval run completed',
      );
    } catch (error) {
      log.warn({ runId: runRecord.id, err: error }, 'Eval run failed');
      try {
        await evalRepo.finishRun(runRecord.id, {
          status: 'failed',
          error: RUN_FAILED,
          results: [],
        });
      } catch (closeError) {
        // The run stays `running` until the next boot marks it failed.
        log.error({ runId: runRecord.id, err: closeError }, 'Could not record the failed eval run');
      }
    }
  }

  return {
    answering: answerer !== null,
    request,
    corpusChanged(ownerId) {
      request(ownerId, 'corpus');
    },
    isRunning: (ownerId) => queue.has(ownerId),
    idle: () => queue.idle(),
    async stop() {
      const dropped = await queue.stop();
      waiting.clear();
      return dropped;
    },
  };
}
