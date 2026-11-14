import { createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  EVAL_ACTIVE_SIZE,
  EVAL_CANDIDATE_TTL_DAYS,
  EVAL_CLUSTER_SIMILARITY,
  EVAL_PROMOTE_SESSIONS,
  type EvalQuestionAction,
} from '../../contract.js';
import type { EvalQuestionRecord, EvalRepository } from '../../db/api/evalRepository.js';
import { ConflictError } from '../../db/api/repository.js';
import type { Embedder } from '../embedding/index.js';
import { SerialQueue } from '../ingestion/queue.js';
import { CANNED_EVAL_QUESTIONS } from './canned.js';
import { redactQuestion } from './redact.js';

/**
 * The evolving chat eval set (#85): which questions it holds, and how visitor
 * questions get in.
 *
 * - **Clustering.** A recorded question reuses the embedding retrieval just
 *   made for it and is compared with the owner's existing questions. At or
 *   above `clusterSimilarity` it joins the nearest one (bumping its hit count,
 *   distinct sessions and last-asked time); below, it starts a `candidate`.
 * - **Promotion.** A candidate asked in `promoteSessions` distinct sessions,
 *   and not flagged off-topic, becomes `active`.
 * - **Eviction.** When the active set is full, the active, unpinned question
 *   asked least recently is `retired` to make room. If every active question
 *   is pinned, the candidate waits.
 * - **Off-topic.** A new candidate is flagged off-topic when the corpus has
 *   chunks but the best one is below `offTopicSimilarity`; the owner can set
 *   or clear the flag. Retired questions are never promoted automatically; the
 *   owner can promote any question.
 * - **Purge.** Candidates not asked for `candidateTtlDays` are deleted.
 */

export interface EvalSettings {
  activeSize: number;
  clusterSimilarity: number;
  promoteSessions: number;
  /** An active question whose best chunk is below this is a knowledge gap. */
  gapSimilarity: number;
  /** A new question whose best chunk is below this is flagged off-topic. */
  offTopicSimilarity: number;
  candidateTtlDays: number;
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
  promoteSessions: EVAL_PROMOTE_SESSIONS,
  gapSimilarity: 0.3,
  offTopicSimilarity: 0.15,
  candidateTtlDays: EVAL_CANDIDATE_TTL_DAYS,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Purging is cheap but not free; once an hour per owner is plenty for a 90-day rule. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

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
  /** True when this ask promoted the question to active. */
  promoted: boolean;
  evicted: EvalQuestionRecord | null;
}

export interface ActionOutcome {
  question: EvalQuestionRecord;
  evicted: EvalQuestionRecord | null;
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
  /** Records one visitor question; see the module comment for the rules. */
  record(input: RecordInput): Promise<RecordOutcome>;
  /**
   * `record`, in the background and one at a time, so a slow write never
   * delays the retrieval answer and two near-duplicates arriving together
   * cannot both start a cluster. Failures are logged.
   */
  enqueueRecord(input: RecordInput): void;
  /** The owner's questions, after purging expired candidates (at most hourly). */
  list(ownerId: string): Promise<EvalQuestionRecord[]>;
  /** Deletes candidates not asked within the TTL. Returns how many. */
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

export function createEvalSet(deps: EvalSetDeps): EvalSet {
  const settings: EvalSettings = { ...DEFAULT_EVAL_SETTINGS, ...deps.settings };
  const now = deps.now ?? (() => new Date());
  const { repo, embedder, log } = deps;
  const lastPurge = new Map<string, number>();

  const queue = new SerialQueue<RecordInput & { id: string }>(
    async (item) => {
      await record(item);
    },
    (item, error) => log.warn({ err: error, ownerId: item.ownerId }, 'Could not record question'),
  );

  async function ensureSeeded(ownerId: string): Promise<void> {
    // Cheap check first, so the canned questions are embedded only once.
    if ((await repo.listQuestions(ownerId)).length > 0) return;
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
  }

  async function purge(ownerId: string): Promise<number> {
    lastPurge.set(ownerId, Date.now());
    const before = new Date(now().getTime() - settings.candidateTtlDays * DAY_MS);
    const purged = await repo.purgeCandidates(ownerId, before);
    if (purged > 0) log.info({ ownerId, purged }, 'Purged stale eval candidates');
    return purged;
  }

  async function maybePurge(ownerId: string): Promise<void> {
    const last = lastPurge.get(ownerId);
    if (last !== undefined && Date.now() - last < PURGE_INTERVAL_MS) return;
    await purge(ownerId);
  }

  async function promote(ownerId: string, id: string): Promise<ActionOutcome | null> {
    const outcome = await repo.promote(ownerId, id, settings.activeSize);
    switch (outcome.status) {
      case 'not-found':
        throw new EvalQuestionNotFoundError();
      case 'full':
        return null;
      case 'promoted':
        return { question: outcome.question, evicted: outcome.evicted };
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
    let question =
      nearest && nearest.similarity >= settings.clusterSimilarity
        ? await repo.recordAsk(nearest.question.id, sessionHash, at)
        : null;
    const kind: RecordOutcome['kind'] = question ? 'joined' : 'created';
    question ??= await repo.createCandidate({
      ownerId,
      question: stored,
      embedding,
      offTopic: input.topSimilarity !== null && input.topSimilarity < settings.offTopicSimilarity,
      sessionHash,
      now: at,
    });

    if (
      question.status === 'candidate' &&
      !question.offTopic &&
      question.distinctSessions >= settings.promoteSessions
    ) {
      const promoted = await promote(ownerId, question.id);
      if (promoted) {
        log.info(
          { questionId: question.id, evicted: promoted.evicted?.id ?? null },
          'Promoted a visitor question to the eval set',
        );
        return { kind, question: promoted.question, promoted: true, evicted: promoted.evicted };
      }
    }
    return { kind, question, promoted: false, evicted: null };
  }

  async function update(
    ownerId: string,
    id: string,
    patch: Parameters<EvalRepository['updateQuestion']>[2],
  ): Promise<ActionOutcome> {
    const question = await repo.updateQuestion(ownerId, id, patch);
    if (!question) throw new EvalQuestionNotFoundError();
    return { question, evicted: null };
  }

  async function act(
    ownerId: string,
    id: string,
    action: EvalQuestionAction,
  ): Promise<ActionOutcome> {
    const current = await repo.getQuestion(ownerId, id);
    if (!current) throw new EvalQuestionNotFoundError();
    switch (action) {
      case 'pin':
        if (current.status !== 'active') {
          throw new ConflictError('Only active questions can be pinned. Promote it first.');
        }
        return update(ownerId, id, { pinned: true });
      case 'unpin':
        return update(ownerId, id, { pinned: false });
      case 'retire':
        return update(ownerId, id, { status: 'retired', pinned: false });
      case 'promote': {
        const promoted = await promote(ownerId, id);
        if (!promoted) {
          throw new ConflictError(
            'Every active question is pinned. Unpin or retire one, then promote this one.',
          );
        }
        return promoted;
      }
      case 'off-topic':
        // An off-topic question has no place in the active set.
        return update(
          ownerId,
          id,
          current.status === 'active'
            ? { offTopic: true, status: 'retired', pinned: false }
            : { offTopic: true },
        );
      case 'on-topic':
        return update(ownerId, id, { offTopic: false });
    }
  }

  return {
    settings,
    ensureSeeded,
    record,
    enqueueRecord(input) {
      queue.enqueue({ ...input, id: randomUUID() });
    },
    async list(ownerId) {
      await maybePurge(ownerId);
      return repo.listQuestions(ownerId);
    },
    purge,
    act,
    idle: () => queue.idle(),
    stop: () => queue.stop(),
  };
}
