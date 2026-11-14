/**
 * The evolving chat eval set's wire types (#85), as the backend's
 * `/knowledge/eval*` proxy relays them. They mirror `EvalStateResponseSchema`
 * and friends in `@six7swe/knowledge-types`; see `types.ts` for why the
 * frontend keeps its own copy. The guards below check the shape at runtime.
 */

export type EvalQuestionStatus = 'candidate' | 'active' | 'retired';
export type EvalQuestionAction = 'pin' | 'unpin' | 'retire' | 'promote' | 'off-topic' | 'on-topic';

export interface EvalQuestion {
  id: string;
  question: string;
  status: EvalQuestionStatus;
  origin: 'canned' | 'visitor';
  pinned: boolean;
  offTopic: boolean;
  hitCount: number;
  distinctSessions: number;
  lastAskedAt: string;
  createdAt: string;
}

export interface EvalResultDiff {
  change: 'new' | 'unchanged' | 'changed';
  previousTopSimilarity: number | null;
  topSimilarityDelta: number | null;
  chunksChanged: boolean;
  previousGap: boolean | null;
  answerChanged: boolean;
}

export interface EvalResult {
  questionId: string | null;
  question: string;
  answer: string | null;
  chunkIds: string[];
  topSimilarity: number | null;
  gap: boolean;
  diff: EvalResultDiff | null;
}

export interface EvalRun {
  id: string;
  corpusVersion: number;
  trigger: 'corpus' | 'manual';
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  previous: { id: string; corpusVersion: number } | null;
  results: EvalResult[];
  removed: Array<{ questionId: string | null; question: string }>;
}

export interface EvalSettings {
  activeSize: number;
  clusterSimilarity: number;
  promoteSessions: number;
  gapSimilarity: number;
  offTopicSimilarity: number;
  candidateTtlDays: number;
  answering: boolean;
}

export interface EvalState {
  settings: EvalSettings;
  questions: EvalQuestion[];
  latestRun: EvalRun | null;
  running: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const nullableNumber = (value: unknown) => value === null || typeof value === 'number';
const nullableString = (value: unknown) => value === null || typeof value === 'string';

const isQuestion = (value: unknown): value is EvalQuestion =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.question === 'string' &&
  (value.status === 'candidate' || value.status === 'active' || value.status === 'retired') &&
  (value.origin === 'canned' || value.origin === 'visitor') &&
  typeof value.pinned === 'boolean' &&
  typeof value.offTopic === 'boolean' &&
  typeof value.hitCount === 'number' &&
  typeof value.distinctSessions === 'number' &&
  typeof value.lastAskedAt === 'string';

const isDiff = (value: unknown): value is EvalResultDiff =>
  isRecord(value) &&
  (value.change === 'new' || value.change === 'unchanged' || value.change === 'changed') &&
  nullableNumber(value.previousTopSimilarity) &&
  nullableNumber(value.topSimilarityDelta) &&
  typeof value.chunksChanged === 'boolean' &&
  typeof value.answerChanged === 'boolean';

const isResult = (value: unknown): value is EvalResult =>
  isRecord(value) &&
  nullableString(value.questionId) &&
  typeof value.question === 'string' &&
  nullableString(value.answer) &&
  Array.isArray(value.chunkIds) &&
  nullableNumber(value.topSimilarity) &&
  typeof value.gap === 'boolean' &&
  (value.diff === null || isDiff(value.diff));

const isRun = (value: unknown): value is EvalRun =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.corpusVersion === 'number' &&
  typeof value.status === 'string' &&
  nullableString(value.error) &&
  typeof value.startedAt === 'string' &&
  (value.previous === null ||
    (isRecord(value.previous) && typeof value.previous.corpusVersion === 'number')) &&
  Array.isArray(value.results) &&
  value.results.every(isResult) &&
  Array.isArray(value.removed);

const isSettings = (value: unknown): value is EvalSettings =>
  isRecord(value) &&
  typeof value.activeSize === 'number' &&
  typeof value.promoteSessions === 'number' &&
  typeof value.gapSimilarity === 'number' &&
  typeof value.candidateTtlDays === 'number' &&
  typeof value.answering === 'boolean';

function invalid(what: string): never {
  throw new Error(`Unexpected ${what} response from the server`);
}

/** `GET /knowledge/eval`. */
export function parseEvalState(data: unknown): EvalState {
  if (
    !isRecord(data) ||
    !isSettings(data.settings) ||
    !Array.isArray(data.questions) ||
    !data.questions.every(isQuestion) ||
    !(data.latestRun === null || isRun(data.latestRun)) ||
    typeof data.running !== 'boolean'
  ) {
    return invalid('eval set');
  }
  return {
    settings: data.settings,
    questions: data.questions,
    latestRun: data.latestRun,
    running: data.running,
  };
}

/** `POST /knowledge/eval/questions/:id`. */
export function parseEvalQuestionResponse(data: unknown): {
  question: EvalQuestion;
  evicted: EvalQuestion | null;
} {
  if (
    !isRecord(data) ||
    !isQuestion(data.question) ||
    !(data.evicted === null || isQuestion(data.evicted))
  ) {
    return invalid('eval question');
  }
  return { question: data.question, evicted: data.evicted };
}
