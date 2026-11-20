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
  /** `example`: one of the chat widget's example questions, seeded pinned (#205). */
  origin: 'canned' | 'visitor' | 'example';
  pinned: boolean;
  offTopic: boolean;
  hitCount: number;
  distinctSessions: number;
  /** Clicks on the chat example (origin `example`); apart from `hitCount`. */
  exampleClicks: number;
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
  suggestSessions: number;
  maxCandidates: number;
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
const isNullableString = (value: unknown) => value === null || typeof value === 'string';
const isNullableBoolean = (value: unknown) => value === null || typeof value === 'boolean';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isOneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

/** A question as sent; `exampleClicks` is missing from a knowledge service that predates it. */
type WireQuestion = Omit<EvalQuestion, 'exampleClicks'> & { exampleClicks?: number };

const isQuestion = (value: unknown): value is WireQuestion =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.question === 'string' &&
  isOneOf(['candidate', 'active', 'retired'], value.status) &&
  isOneOf(['canned', 'visitor', 'example'], value.origin) &&
  (value.exampleClicks === undefined || typeof value.exampleClicks === 'number') &&
  typeof value.pinned === 'boolean' &&
  typeof value.offTopic === 'boolean' &&
  typeof value.hitCount === 'number' &&
  typeof value.distinctSessions === 'number' &&
  typeof value.lastAskedAt === 'string' &&
  typeof value.createdAt === 'string';

const isDiff = (value: unknown): value is EvalResultDiff =>
  isRecord(value) &&
  isOneOf(['new', 'unchanged', 'changed'], value.change) &&
  nullableNumber(value.previousTopSimilarity) &&
  nullableNumber(value.topSimilarityDelta) &&
  typeof value.chunksChanged === 'boolean' &&
  isNullableBoolean(value.previousGap) &&
  typeof value.answerChanged === 'boolean';

const isResult = (value: unknown): value is EvalResult =>
  isRecord(value) &&
  isNullableString(value.questionId) &&
  typeof value.question === 'string' &&
  isNullableString(value.answer) &&
  isStringArray(value.chunkIds) &&
  nullableNumber(value.topSimilarity) &&
  typeof value.gap === 'boolean' &&
  (value.diff === null || isDiff(value.diff));

const isRemoved = (value: unknown) =>
  isRecord(value) && isNullableString(value.questionId) && typeof value.question === 'string';

const isRun = (value: unknown): value is EvalRun =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.corpusVersion === 'number' &&
  isOneOf(['corpus', 'manual'], value.trigger) &&
  isOneOf(['running', 'completed', 'failed'], value.status) &&
  isNullableString(value.error) &&
  typeof value.startedAt === 'string' &&
  isNullableString(value.finishedAt) &&
  (value.previous === null ||
    (isRecord(value.previous) &&
      typeof value.previous.id === 'string' &&
      typeof value.previous.corpusVersion === 'number')) &&
  Array.isArray(value.results) &&
  value.results.every(isResult) &&
  Array.isArray(value.removed) &&
  value.removed.every(isRemoved);

const isSettings = (value: unknown): value is EvalSettings =>
  isRecord(value) &&
  typeof value.activeSize === 'number' &&
  typeof value.clusterSimilarity === 'number' &&
  typeof value.offTopicSimilarity === 'number' &&
  typeof value.maxCandidates === 'number' &&
  typeof value.suggestSessions === 'number' &&
  typeof value.gapSimilarity === 'number' &&
  typeof value.candidateTtlDays === 'number' &&
  typeof value.answering === 'boolean';

const toQuestion = (q: WireQuestion): EvalQuestion => ({
  ...q,
  exampleClicks: q.exampleClicks ?? 0,
});

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
    questions: data.questions.map(toQuestion),
    latestRun: data.latestRun,
    running: data.running,
  };
}

/** `POST /knowledge/eval/questions/:id`. */
export function parseEvalQuestionResponse(data: unknown): {
  question: EvalQuestion;
  /** The questions a promotion retired to make room. */
  evicted: EvalQuestion[];
} {
  if (
    !isRecord(data) ||
    !isQuestion(data.question) ||
    !Array.isArray(data.evicted) ||
    !data.evicted.every(isQuestion)
  ) {
    return invalid('eval question');
  }
  return { question: toQuestion(data.question), evicted: data.evicted.map(toQuestion) };
}
