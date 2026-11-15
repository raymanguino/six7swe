import type {
  EvalQuestionOrigin,
  EvalQuestionStatus,
  EvalRunStatus,
  EvalRunTrigger,
} from '../../contract.js';

/**
 * Persistence for the evolving chat eval set (#85). Kept apart from the
 * document repository: questions and runs never touch the corpus version.
 *
 * The rules that decide *whether* something happens (clustering, gap flags,
 * which owner action applies) live in `services/evalSet/`. The repository
 * keeps the ones that must be atomic: counting distinct sessions, capping
 * candidates, promoting a question while retiring the least recently asked
 * unpinned ones, and status-guarded updates. Promotion and updates of one
 * owner's set are serialized, so an owner action never lands on a question
 * that a concurrent promotion just retired.
 */

export interface EvalQuestionRecord {
  id: string;
  ownerId: string;
  question: string;
  status: EvalQuestionStatus;
  origin: EvalQuestionOrigin;
  pinned: boolean;
  offTopic: boolean;
  hitCount: number;
  distinctSessions: number;
  lastAskedAt: Date;
  createdAt: Date;
}

export interface EvalQuestionWithEmbedding extends EvalQuestionRecord {
  embedding: number[];
}

export interface NewCannedQuestion {
  question: string;
  embedding: number[];
}

export interface NewVisitorQuestion {
  ownerId: string;
  /** Already redacted and truncated. */
  question: string;
  embedding: number[];
  offTopic: boolean;
  sessionHash: string;
  now: Date;
  /** After the insert, the owner's least recently asked candidates beyond this are deleted. */
  maxCandidates: number;
}

export type PromoteOutcome =
  /** Active now; `evicted` are the questions retired to make room (usually none or one). */
  | { status: 'promoted'; question: EvalQuestionRecord; evicted: EvalQuestionRecord[] }
  /** The active set is full and not enough active questions are unpinned to make room. */
  | { status: 'full' }
  | { status: 'not-found' };

export interface EvalQuestionPatch {
  status?: EvalQuestionStatus;
  pinned?: boolean;
  offTopic?: boolean;
}

export type UpdateOutcome =
  | { status: 'updated'; question: EvalQuestionRecord }
  /** The question's status is not one of `onlyIf`; nothing was written. */
  | { status: 'conflict'; question: EvalQuestionRecord }
  | { status: 'not-found' };

export interface EvalRunRecord {
  id: string;
  ownerId: string;
  corpusVersion: number;
  trigger: EvalRunTrigger;
  status: EvalRunStatus;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface EvalResultRecord {
  questionId: string | null;
  question: string;
  answer: string | null;
  chunkIds: string[];
  topSimilarity: number | null;
  gap: boolean;
}

export interface EvalRunWithResults extends EvalRunRecord {
  /** In the order they were run. */
  results: EvalResultRecord[];
}

export interface FinishRun {
  status: Exclude<EvalRunStatus, 'running'>;
  error: string | null;
  results: EvalResultRecord[];
}

export interface EvalRepository {
  /**
   * Inserts the canned questions as active, unless the owner has any eval
   * question at all (of any status). Returns true when it seeded. Two calls
   * at once seed once.
   */
  seedIfEmpty(ownerId: string, questions: NewCannedQuestion[], now: Date): Promise<boolean>;

  /**
   * The owner's candidate or active question closest to the embedding, or
   * null when there is none. Retired questions are never matched, so a
   * question like a retired one starts (or bumps) a candidate instead of
   * disappearing into it.
   */
  nearestQuestion(
    ownerId: string,
    embedding: number[],
  ): Promise<{ question: EvalQuestionRecord; similarity: number } | null>;

  /**
   * A new `candidate` cluster, asked once, from one session. Then trims the
   * owner's candidates to `maxCandidates`, least recently asked first.
   */
  createCandidate(input: NewVisitorQuestion): Promise<EvalQuestionRecord>;

  /**
   * Records one more ask of a cluster: bumps `hit_count`, sets
   * `last_asked_at`, and bumps `distinct_sessions` when this session had not
   * asked it before. Never changes the status. Null when the question no
   * longer exists.
   */
  recordAsk(id: string, sessionHash: string, now: Date): Promise<EvalQuestionRecord | null>;

  /**
   * Makes the question active and clears its off-topic flag. In the same
   * transaction, retires the active, unpinned questions asked least recently
   * (ties: the oldest, then the lowest id) until the active set has room for
   * it under `maxActive`. An already active question is returned unchanged.
   */
  promote(ownerId: string, id: string, maxActive: number): Promise<PromoteOutcome>;

  /**
   * Applies the patch, provided the question's status is one of `onlyIf`
   * (any status when omitted), checked and written atomically with respect
   * to promotions.
   */
  updateQuestion(
    ownerId: string,
    id: string,
    patch: EvalQuestionPatch,
    onlyIf?: readonly EvalQuestionStatus[],
  ): Promise<UpdateOutcome>;

  getQuestion(ownerId: string, id: string): Promise<EvalQuestionRecord | null>;

  /** Active, then candidates, then retired; most recently asked first within each. */
  listQuestions(ownerId: string): Promise<EvalQuestionRecord[]>;

  /** The active questions with their embeddings, oldest first, for a run. */
  listActiveWithEmbeddings(ownerId: string): Promise<EvalQuestionWithEmbedding[]>;

  /**
   * Deletes candidates, and retired visitor questions, last asked before
   * `before`. Canned questions and active ones stay. Returns how many.
   */
  purgeStale(ownerId: string, before: Date): Promise<number>;

  createRun(
    ownerId: string,
    corpusVersion: number,
    trigger: EvalRunTrigger,
  ): Promise<EvalRunRecord>;

  /**
   * Stores the results and closes the run, atomically, only while it is
   * still `running`: a run abandoned at boot is never overwritten by the
   * instance that started it. Returns false when nothing was written.
   */
  finishRun(runId: string, outcome: FinishRun): Promise<boolean>;

  /** Marks runs a previous process left `running` as failed. Returns how many. */
  abandonRunning(reason: string): Promise<number>;

  /** The owner's newest run (by start time), whatever its status. */
  getLatestRun(ownerId: string): Promise<EvalRunWithResults | null>;

  /** The newest completed run at a corpus version below `corpusVersion`. */
  getPreviousCompletedRun(
    ownerId: string,
    corpusVersion: number,
  ): Promise<EvalRunWithResults | null>;

  /** The newest completed run, for skipping a corpus-triggered run at an unchanged version. */
  getLatestCompletedRun(ownerId: string): Promise<EvalRunRecord | null>;
}
