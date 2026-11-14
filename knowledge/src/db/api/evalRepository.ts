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
 * The rules that decide *whether* something happens (clustering, promotion
 * eligibility, gap flags) live in `services/evalSet/`. The repository keeps
 * the ones that must be atomic: counting distinct sessions, and promoting a
 * question while retiring the least recently asked unpinned one.
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
}

export type PromoteOutcome =
  /** Active now; `evicted` is the question retired to make room, if one was. */
  | { status: 'promoted'; question: EvalQuestionRecord; evicted: EvalQuestionRecord | null }
  /** The active set is full and every active question is pinned. */
  | { status: 'full' }
  | { status: 'not-found' };

export interface EvalQuestionPatch {
  status?: EvalQuestionStatus;
  pinned?: boolean;
  offTopic?: boolean;
}

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

  /** The owner's question closest to the embedding (any status), or null when there is none. */
  nearestQuestion(
    ownerId: string,
    embedding: number[],
  ): Promise<{ question: EvalQuestionRecord; similarity: number } | null>;

  /** A new `candidate` cluster, asked once, from one session. */
  createCandidate(input: NewVisitorQuestion): Promise<EvalQuestionRecord>;

  /**
   * Records one more ask of a cluster: bumps `hit_count`, sets
   * `last_asked_at`, and bumps `distinct_sessions` when this session had not
   * asked it before. Null when the question no longer exists.
   */
  recordAsk(id: string, sessionHash: string, now: Date): Promise<EvalQuestionRecord | null>;

  /**
   * Makes the question active and clears its off-topic flag, atomically with
   * retiring the active, unpinned question asked least recently (ties: the
   * oldest, then the lowest id) when the active set already holds
   * `maxActive`. An already active question is returned unchanged.
   */
  promote(ownerId: string, id: string, maxActive: number): Promise<PromoteOutcome>;

  /** Null when the question does not exist or belongs to someone else. */
  updateQuestion(
    ownerId: string,
    id: string,
    patch: EvalQuestionPatch,
  ): Promise<EvalQuestionRecord | null>;

  getQuestion(ownerId: string, id: string): Promise<EvalQuestionRecord | null>;

  /** Active, then candidates, then retired; most recently asked first within each. */
  listQuestions(ownerId: string): Promise<EvalQuestionRecord[]>;

  /** The active questions with their embeddings, oldest first, for a run. */
  listActiveWithEmbeddings(ownerId: string): Promise<EvalQuestionWithEmbedding[]>;

  /** Deletes candidates last asked before `before`. Returns how many. */
  purgeCandidates(ownerId: string, before: Date): Promise<number>;

  createRun(
    ownerId: string,
    corpusVersion: number,
    trigger: EvalRunTrigger,
  ): Promise<EvalRunRecord>;

  /** Stores the results and closes the run, atomically. */
  finishRun(runId: string, outcome: FinishRun): Promise<void>;

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
