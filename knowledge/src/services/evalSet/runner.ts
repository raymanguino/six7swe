import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_RETRIEVE_K, type EvalRunTrigger } from '../../contract.js';
import type { EvalRepository, EvalResultRecord } from '../../db/api/evalRepository.js';
import type { KnowledgeRepository } from '../../db/api/repository.js';
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
 * (a failed first ingest, for one, does not change the corpus).
 *
 * Not durable: a run cut off by a restart is marked failed on the next boot
 * (`abandonRunning`), and the next corpus change or the owner runs it again.
 */

const RUN_FAILED = 'The eval run failed unexpectedly. Run it again.';
export const RUN_INTERRUPTED = 'Interrupted by a restart. Run it again.';

export interface EvalRunnerDeps {
  evalRepo: EvalRepository;
  repo: Pick<KnowledgeRepository, 'search' | 'getVersion'>;
  evalSet: Pick<EvalSet, 'ensureSeeded' | 'settings'>;
  answerer: EvalAnswerer | null;
  log: FastifyBaseLogger;
  /** Chunks retrieved per question; the chat's default. */
  k?: number;
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
  /** Runs one now, outside the queue; tests and the queue's worker use it. */
  run(ownerId: string, trigger: EvalRunTrigger): Promise<void>;
  idle(): Promise<void>;
  stop(): Promise<number>;
}

export function createEvalRunner(deps: EvalRunnerDeps): EvalRunner {
  const { evalRepo, repo, evalSet, answerer, log } = deps;
  const k = deps.k ?? DEFAULT_RETRIEVE_K;

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

  async function answer(question: string, chunks: Parameters<EvalAnswerer['answer']>[1]) {
    if (!answerer) return null;
    try {
      return await answerer.answer(question, chunks);
    } catch (error) {
      const detail = error instanceof ModelError ? error.detail : undefined;
      log.warn({ err: error, detail }, 'Eval answer failed; recording retrieval only');
      return null;
    }
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
      const results: EvalResultRecord[] = [];
      for (const q of questions) {
        const chunks = await repo.search(ownerId, q.embedding, k);
        const topSimilarity = chunks[0]?.similarity ?? null;
        results.push({
          questionId: q.id,
          question: q.question,
          answer: await answer(q.question, chunks),
          chunkIds: chunks.map((c) => c.chunkId),
          topSimilarity,
          gap: topSimilarity === null || topSimilarity < evalSet.settings.gapSimilarity,
        });
      }
      await evalRepo.finishRun(runRecord.id, { status: 'completed', error: null, results });
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
      await evalRepo.finishRun(runRecord.id, { status: 'failed', error: RUN_FAILED, results: [] });
    }
  }

  return {
    answering: answerer !== null,
    request,
    corpusChanged(ownerId) {
      request(ownerId, 'corpus');
    },
    isRunning: (ownerId) => queue.has(ownerId),
    run,
    idle: () => queue.idle(),
    async stop() {
      const dropped = await queue.stop();
      waiting.clear();
      return dropped;
    },
  };
}
