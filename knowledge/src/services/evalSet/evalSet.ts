import { createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  EVAL_ACTIVE_SIZE,
  EVAL_CANDIDATE_TTL_DAYS,
  EVAL_CLUSTER_SIMILARITY,
  EVAL_MAX_CANDIDATES,
  EVAL_SUGGEST_SESSIONS,
  type EvalQuestionAction,
  type EvalQuestionStatus,
} from '../../contract.js';
import type {
  EvalQuestionPatch,
  EvalQuestionRecord,
  EvalRepository,
} from '../../db/api/evalRepository.js';
import { ConflictError } from '../../db/api/repository.js';
import type { Embedder } from '../embedding/index.js';
import { SerialQueue } from '../ingestion/queue.js';
import { CANNED_EVAL_QUESTIONS } from './canned.js';
import { redactQuestion } from './redact.js';

/**
 * The evolving chat eval set (#85): which questions it holds, and how visitor
 * questions reach it.
 *
 * - **Clustering.** A recorded question reuses the embedding retrieval just
 *   made for it and is compared with the owner's candidate and active
 *   questions. At or above `clusterSimilarity` it joins the nearest one
 *   (bumping its hit count, distinct sessions and last-asked time); below,
 *   it starts a `candidate`. Retired questions are never matched.
 * - **Promotion is the owner's.** Recording never changes a question's
 *   status: session ids are chosen by the client, so ask counts can be
 *   gamed. A candidate asked in `suggestSessions` distinct sessions, and not
 *   off-topic, is only suggested to the owner.
 * - **Eviction** happens only as part of an owner promotion: the active,
 *   unpinned questions asked least recently are retired to make room. If
 *   every active question is pinned, the promotion is refused.
 * - **Off-topic.** A new candidate is flagged off-topic when the corpus has
 *   chunks but the best one is below `offTopicSimilarity`; the owner can set
 *   or clear the flag.
 * - **Purge.** Candidates, and retired visitor questions, not asked for
 *   `candidateTtlDays` are deleted, and an owner keeps at most
 *   `maxCandidates` candidates.
 */

export interface EvalSettings {
  activeSize: number;
  clusterSimilarity: number;
  /** A UI hint: candidates asked in this many distinct sessions are suggested for promotion. */
  suggestSessions: number;
  /** An active question whose best chunk is below this is a knowledge gap. */
  gapSimilarity: number;
  /** A new question whose best chunk is below this is flagged off-topic. */
  offTopicSimilarity: number;
  candidateTtlDays: number;
  maxCandidates: number;
}

/**
 * Thresholds for OpenAI's text-embedding-3-small, where a relevant chunk
 * usually scores 0.3 to 0.6. Other embedders (the offline `hashing` one)
 * score differently; `EVAL_GAP_SIMILARITY` and `EVAL_OFF_TOPIC_SIMILARITY`
 * override the two that depend on it.
 */
export const DEFAULT_EVAL_SETTINGS: EvalSettings = {
  activeSize: EVAL_ACTIVE_SIZE,
  clusterSimilarity: EVAL_CLUSTER_SIMILARITY,
  suggestSessions: EVAL_SUGGEST_SESSIONS,
  gapSimilarity: 0.3,
  offTopicSimilarity: 0.15,
  candidateTtlDays: EVAL_CANDIDATE_TTL_DAYS,
  maxCandidates: EVAL_MAX_CANDIDATES,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Purging is cheap but not free; once an hour per owner is plenty for a 90-day rule. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** Questions waiting to be recorded beyond this are dropped (and logged). */
export const MAX_WAITING_RECORDS = 100;

export interface RecordInput {
  ownerId: string;
  /** The visitor's current question, as sent (it is redacted here). */
  question: string;
  sessionId: string;
  /** The query embedding retrieval already computed. */
  embedding: number[];
  /** The best retrieved chunk's similarity; null when the corpus returned nothing. */
  topSimilarity: number | null;
}

export interface RecordOutcome {
  kind: 'joined' | 'created';
  question: EvalQuestionRecord;
}

export interface ActionOutcome {
  question: EvalQuestionRecord;
  /** The questions a promotion retired to make room. */
  evicted: EvalQuestionRecord[];
}

/** The question does not exist, or belongs to someone else. Maps to 404. */
export class EvalQuestionNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super('Eval question not found');
    this.name = 'EvalQuestionNotFoundError';
  }
}

export interface EvalSetDeps {
  repo: EvalRepository;
  embedder: Embedder;
  log: FastifyBaseLogger;
  settings?: Partial<EvalSettings>;
  /** The clock; tests pin it. */
  now?: () => Date;
}

export interface EvalSet {
  readonly settings: EvalSettings;
  /** Seeds the canned questions when the owner has no eval question yet. */
  ensureSeeded(ownerId: string): Promise<void>;
  /** Records one visitor question as a candidate (new or bumped); never promotes. */
  record(input: RecordInput): Promise<RecordOutcome>;
  /**
   * `record`, in the background and one at a time, so a slow write never
   * delays the retrieval answer and two near-duplicates arriving together
   * cannot both start a cluster. Failures are logged.
   */
  enqueueRecord(input: RecordInput): void;
  /** The owner's questions, after purging stale ones (at most hourly; a failure is logged). */
  list(ownerId: string): Promise<EvalQuestionRecord[]>;
  /** Deletes stale candidates and retired visitor questions. Returns how many. */
  purge(ownerId: string): Promise<number>;
  /** One of the owner's controls. Throws a 404 or 409 error when it cannot apply. */
  act(ownerId: string, id: string, action: EvalQuestionAction): Promise<ActionOutcome>;
  idle(): Promise<void>;
  stop(): Promise<number>;
}

/** Session ids are random, but the service still keeps only a hash of them. */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

const PIN_CONFLICT = 'Only active questions can be pinned. Promote it first.';
const FULL_CONFLICT =
  'Every active question is pinned. Unpin or retire one, then promote this one.';
const CHANGED_CONFLICT = 'The question changed meanwhile. Reload and try again.';

export function createEvalSet(deps: EvalSetDeps): EvalSet {
  const settings: EvalSettings = { ...DEFAULT_EVAL_SETTINGS, ...deps.settings };
  const now = deps.now ?? (() => new Date());
  const { repo, embedder, log } = deps;
  const lastPurge = new Map<string, number>();
  const seeded = new Set<string>();

  // Questions waiting to be recorded. The backend's chat is rate-limited, so
  // this stays small; the cap only stops a flood from growing it unbounded.
  let waiting = 0;
  const queue = new SerialQueue<RecordInput & { id: string }>(
    async (item) => {
      waiting--;
      await record(item);
    },
    (item, error) => log.warn({ err: error, ownerId: item.ownerId }, 'Could not record question'),
  );

  async function ensureSeeded(ownerId: string): Promise<void> {
    // Once an owner has questions they always will (canned ones are never
    // purged), so the check runs once per owner and process.
    if (seeded.has(ownerId)) return;
    // Cheap check first, so the canned questions are embedded only once.
    if ((await repo.listQuestions(ownerId)).length > 0) {
      seeded.add(ownerId);
      return;
    }
    const texts = [...CANNED_EVAL_QUESTIONS];
    const vectors = await embedder.embed(texts);
    const canned = texts.map((question, i) => {
      const embedding = vectors[i];
      if (!embedding) throw new Error('Embedder returned too few vectors for the canned questions');
      return { question, embedding };
    });
    if (await repo.seedIfEmpty(ownerId, canned, now())) {
      log.info({ ownerId, count: canned.length }, 'Seeded the eval set');
    }
    seeded.add(ownerId);
  }

  async function purge(ownerId: string): Promise<number> {
    const at = now();
    const before = new Date(at.getTime() - settings.candidateTtlDays * DAY_MS);
    const purged = await repo.purgeStale(ownerId, before);
    // Only after it worked, so a failure is retried on the next call.
    lastPurge.set(ownerId, at.getTime());
    if (purged > 0) log.info({ ownerId, purged }, 'Purged stale eval questions');
    return purged;
  }

  /** Housekeeping must never fail a recording or the owner's view. */
  async function maybePurge(ownerId: string): Promise<void> {
    const last = lastPurge.get(ownerId);
    if (last !== undefined && now().getTime() - last < PURGE_INTERVAL_MS) return;
    try {
      await purge(ownerId);
    } catch (error) {
      log.warn({ ownerId, err: error }, 'Could not purge stale eval questions');
    }
  }

  async function record(input: RecordInput): Promise<RecordOutcome> {
    const { ownerId } = input;
    await ensureSeeded(ownerId);
    await maybePurge(ownerId);

    const at = now();
    const sessionHash = hashSessionId(input.sessionId);
    const stored = redactQuestion(input.question);
    // The retrieval embedding is reused unless redaction or truncation changed
    // the text: what is stored must not carry what was masked.
    let embedding = input.embedding;
    if (stored !== input.question.trim()) {
      const [redacted] = await embedder.embed([stored]);
      if (!redacted) throw new Error('Embedder returned no vector for the question');
      embedding = redacted;
    }

    const nearest = await repo.nearestQuestion(ownerId, embedding);
    // A cluster purged between the lookup and the write is simply started again.
    const joined =
      nearest && nearest.similarity >= settings.clusterSimilarity
        ? await repo.recordAsk(nearest.question.id, sessionHash, at)
        : null;
    if (joined) return { kind: 'joined', question: joined };
    const created = await repo.createCandidate({
      ownerId,
      question: stored,
      embedding,
      offTopic: input.topSimilarity !== null && input.topSimilarity < settings.offTopicSimilarity,
      sessionHash,
      now: at,
      maxCandidates: settings.maxCandidates,
    });
    return { kind: 'created', question: created };
  }

  /** A status-guarded update: 404 when gone, 409 (with `conflict`) when the status moved. */
  async function update(
    ownerId: string,
    id: string,
    patch: EvalQuestionPatch,
    onlyIf?: readonly EvalQuestionStatus[],
    conflict = CHANGED_CONFLICT,
  ): Promise<ActionOutcome> {
    const outcome = await repo.updateQuestion(ownerId, id, patch, onlyIf);
    switch (outcome.status) {
      case 'not-found':
        throw new EvalQuestionNotFoundError();
      case 'conflict':
        throw new ConflictError(conflict);
      case 'updated':
        return { question: outcome.question, evicted: [] };
    }
  }

  async function act(
    ownerId: string,
    id: string,
    action: EvalQuestionAction,
  ): Promise<ActionOutcome> {
    switch (action) {
      case 'pin':
        return update(ownerId, id, { pinned: true }, ['active'], PIN_CONFLICT);
      case 'unpin':
        return update(ownerId, id, { pinned: false });
      case 'retire':
        return update(ownerId, id, { status: 'retired', pinned: false });
      case 'promote': {
        const outcome = await repo.promote(ownerId, id, settings.activeSize);
        switch (outcome.status) {
          case 'not-found':
            throw new EvalQuestionNotFoundError();
          case 'full':
            throw new ConflictError(FULL_CONFLICT);
          case 'promoted':
            if (outcome.evicted.length > 0) {
              log.info(
                { questionId: id, evicted: outcome.evicted.map((q) => q.id) },
                'Promoted an eval question; retired the least recently asked',
              );
            }
            return { question: outcome.question, evicted: outcome.evicted };
        }
        break;
      }
      case 'off-topic': {
        // An off-topic question has no place in the active set. Each update
        // is guarded by the status it assumes; a promotion landing between
        // the two is caught by the second guard.
        try {
          return await update(ownerId, id, { offTopic: true, status: 'retired', pinned: false }, [
            'active',
          ]);
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
        }
        return update(ownerId, id, { offTopic: true }, ['candidate', 'retired']);
      }
      case 'on-topic':
        return update(ownerId, id, { offTopic: false });
    }
    throw new Error(`Unknown eval question action: ${String(action)}`);
  }

  return {
    settings,
    ensureSeeded,
    record,
    enqueueRecord(input) {
      if (waiting >= MAX_WAITING_RECORDS) {
        log.warn({ ownerId: input.ownerId }, 'Too many questions waiting; not recording this one');
        return;
      }
      if (queue.enqueue({ ...input, id: randomUUID() })) waiting++;
    },
    async list(ownerId) {
      await maybePurge(ownerId);
      return repo.listQuestions(ownerId);
    },
    purge,
    act,
    idle: () => queue.idle(),
    async stop() {
      const dropped = await queue.stop();
      waiting = 0;
      return dropped;
    },
  };
}
