import type { EvalQuestion, EvalQuestionAction, EvalResult, EvalRun } from './evalTypes';
import type { EvalSetState } from './useEvalSet';

/**
 * The evolving chat eval set (#85): the latest run against the corpus, with
 * knowledge gaps and what changed since the previous version, then the
 * active questions, the visitor candidates with their counts, and the retired
 * ones. The owner can pin, retire and promote questions, and flag one
 * off-topic. Only the owner promotes: visitor session ids are client-chosen,
 * so counts only mark a candidate as suggested.
 */

const BUTTON =
  'rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';

const formatSimilarity = (value: number | null) => (value === null ? '—' : value.toFixed(2));

function formatDelta(delta: number | null): string | null {
  if (delta === null || delta === 0) return null;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;
}

const formatDate = (iso: string) => new Date(iso).toLocaleString();

function Badge({ tone, children }: { tone: 'red' | 'amber' | 'green' | 'gray'; children: string }) {
  const tones = {
    red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
    gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ResultRow({ result }: { result: EvalResult }) {
  const delta = formatDelta(result.diff?.topSimilarityDelta ?? null);
  const fixed = result.diff?.previousGap === true && !result.gap;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-sm text-gray-900 dark:text-white">{result.question}</span>
        <span className="text-xs tabular-nums text-gray-600 dark:text-gray-300">
          top {formatSimilarity(result.topSimilarity)}
          {delta && <span className="ml-1">({delta})</span>}
        </span>
        {result.gap && <Badge tone="red">gap</Badge>}
        {fixed && <Badge tone="green">gap closed</Badge>}
        {result.diff?.change === 'new' && <Badge tone="gray">new</Badge>}
        {result.diff?.chunksChanged && <Badge tone="amber">chunks changed</Badge>}
        {/* Informational: model answers vary between runs on the same chunks. */}
        {result.diff?.answerChanged && <Badge tone="gray">answer reworded</Badge>}
      </div>
      {result.answer && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
            Answer ({result.chunkIds.length} chunks)
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
            {result.answer}
          </p>
        </details>
      )}
    </li>
  );
}

function LatestRun({ run }: { run: EvalRun }) {
  const gaps = run.results.filter((r) => r.gap).length;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Corpus version {run.corpusVersion},{' '}
        {run.trigger === 'manual' ? 'run by you' : 'after a corpus change'},{' '}
        {formatDate(run.startedAt)}.{' '}
        {run.status === 'completed' && (
          <>
            {gaps === 0 ? 'No knowledge gaps.' : `${gaps} knowledge gap${gaps === 1 ? '' : 's'}.`}{' '}
            {run.previous
              ? `Compared with version ${run.previous.corpusVersion}.`
              : 'No earlier version to compare with.'}
          </>
        )}
      </p>
      {run.status === 'failed' && (
        <p className="text-sm text-red-700 dark:text-red-300">{run.error ?? 'The run failed.'}</p>
      )}
      {run.results.length > 0 && (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {run.results.map((result, i) => (
            <ResultRow key={result.questionId ?? `${i}:${result.question}`} result={result} />
          ))}
        </ul>
      )}
      {run.removed.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          No longer asked: {run.removed.map((r) => r.question).join('; ')}
        </p>
      )}
    </div>
  );
}

interface QuestionListProps {
  title: string;
  empty: string;
  questions: EvalQuestion[];
  busy: string | null;
  actions: (q: EvalQuestion) => Array<{ action: EvalQuestionAction; label: string }>;
  onAct: (q: EvalQuestion, action: EvalQuestionAction) => void;
  /** Marks questions worth the owner's look (a hint; nothing is promoted automatically). */
  suggested?: (q: EvalQuestion) => boolean;
}

function QuestionList({
  title,
  empty,
  questions,
  busy,
  actions,
  onAct,
  suggested,
}: QuestionListProps) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
        {title} ({questions.length})
      </h4>
      {questions.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-200 dark:divide-gray-700">
          {questions.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="flex-1 text-sm text-gray-900 dark:text-white">{q.question}</span>
              <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                {q.origin === 'canned'
                  ? 'canned'
                  : `${q.hitCount} asks, ${q.distinctSessions} session${q.distinctSessions === 1 ? '' : 's'}`}
              </span>
              {q.origin === 'example' && (
                <span
                  className="text-xs tabular-nums text-indigo-600 dark:text-indigo-300"
                  title="Clicks on this chat example. Counted apart from typed asks."
                >
                  {q.exampleClicks} example click{q.exampleClicks === 1 ? '' : 's'}
                </span>
              )}
              {suggested?.(q) && <Badge tone="amber">suggested</Badge>}
              {q.pinned && <Badge tone="green">pinned</Badge>}
              {q.offTopic && <Badge tone="gray">off-topic</Badge>}
              {actions(q).map(({ action, label }) => (
                <button
                  key={action}
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() => onAct(q, action)}
                >
                  {label}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EvalSetPanel({ evalSet }: { evalSet: EvalSetState }) {
  const { state, loading, error, notice, busy, lastEvicted, runNow, act } = evalSet;
  const questions = state?.questions ?? [];
  const settings = state?.settings;
  const isSuggested = (q: EvalQuestion) =>
    settings !== undefined && !q.offTopic && q.distinctSessions >= settings.suggestSessions;
  const active = questions.filter((q) => q.status === 'active');
  // Suggested candidates first; otherwise most recently asked first, as listed.
  const candidates = questions
    .filter((q) => q.status === 'candidate')
    .sort((a, b) => Number(isSuggested(b)) - Number(isSuggested(a)));
  const retired = questions.filter((q) => q.status === 'retired');

  return (
    <section className="space-y-6 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Chat eval set</h3>
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
            {settings
              ? `Up to ${settings.activeSize} questions, re-run whenever the documents change. Visitor questions collect here as candidates; one asked in ${settings.suggestSessions} or more separate sessions is marked suggested. Only you promote: promoting replaces the least recently asked question that is not pinned. A question whose best chunk scores below ${settings.gapSimilarity.toFixed(2)} is a knowledge gap. Candidates not asked for ${settings.candidateTtlDays} days are dropped, and at most ${settings.maxCandidates} are kept. The chat's example questions are pinned here; clicks on them are counted separately from typed asks and never become candidates.`
              : 'The questions the chat is checked against.'}
            {settings &&
              !settings.answering &&
              ' No answering model is configured, so runs record retrieval only.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runNow()}
          disabled={busy !== null || state?.running === true}
          className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {state?.running ? 'Running…' : 'Run now'}
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
      {lastEvicted.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Retired to make room: {lastEvicted.map((q) => `“${q.question}”`).join(', ')}
        </p>
      )}

      {loading && !state ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Latest run</h4>
            {state?.latestRun ? (
              <LatestRun run={state.latestRun} />
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No run yet. One starts when a document finishes processing, or run it now.
              </p>
            )}
          </div>

          <QuestionList
            title="Active"
            empty="No active questions."
            questions={active}
            busy={busy}
            onAct={(q, a) => void act(q, a)}
            actions={(q) => [
              q.pinned ? { action: 'unpin', label: 'Unpin' } : { action: 'pin', label: 'Pin' },
              { action: 'retire', label: 'Retire' },
              { action: 'off-topic', label: 'Off-topic' },
            ]}
          />
          <QuestionList
            title="Candidates"
            empty="No visitor questions waiting."
            questions={candidates}
            busy={busy}
            suggested={isSuggested}
            onAct={(q, a) => void act(q, a)}
            actions={(q) => [
              { action: 'promote', label: 'Promote' },
              q.offTopic
                ? { action: 'on-topic', label: 'On-topic' }
                : { action: 'off-topic', label: 'Off-topic' },
            ]}
          />
          {retired.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-gray-900 dark:text-white">
                Retired ({retired.length})
              </summary>
              <div className="mt-2">
                <QuestionList
                  title="Retired"
                  empty=""
                  questions={retired}
                  busy={busy}
                  onAct={(q, a) => void act(q, a)}
                  actions={() => [{ action: 'promote', label: 'Promote' }]}
                />
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
