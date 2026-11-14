import type { EvalResultDiff } from '../../contract.js';
import type { EvalResultRecord } from '../../db/api/evalRepository.js';

/** Similarities are compared at the precision they are shown with. */
const round = (n: number) => Math.round(n * 10_000) / 10_000;

export interface RunDiff {
  /** One entry per current result, in the same order; null without a previous run. */
  diffs: Array<EvalResultDiff | null>;
  /** Previous results whose question this run no longer asks. */
  removed: EvalResultRecord[];
}

/** Matches by question id; a result whose question was purged falls back to its text. */
function keyOf(result: EvalResultRecord): string {
  return result.questionId ? `id:${result.questionId}` : `text:${result.question}`;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** How each result moved since the previous run (at an older corpus version). */
export function diffRuns(
  current: EvalResultRecord[],
  previous: EvalResultRecord[] | null,
): RunDiff {
  if (!previous) return { diffs: current.map(() => null), removed: [] };

  const before = new Map(previous.map((r) => [keyOf(r), r]));
  const seen = new Set<string>();
  const diffs = current.map((result): EvalResultDiff => {
    const key = keyOf(result);
    seen.add(key);
    const old = before.get(key);
    if (!old) {
      return {
        change: 'new',
        previousTopSimilarity: null,
        topSimilarityDelta: null,
        chunksChanged: false,
        previousGap: null,
        answerChanged: false,
      };
    }
    const delta =
      result.topSimilarity === null || old.topSimilarity === null
        ? null
        : round(result.topSimilarity - old.topSimilarity);
    const chunksChanged = !sameIds(result.chunkIds, old.chunkIds);
    const answerChanged = (result.answer ?? null) !== (old.answer ?? null);
    const similarityChanged =
      (result.topSimilarity === null) !== (old.topSimilarity === null) ||
      (delta !== null && delta !== 0);
    return {
      change:
        chunksChanged || answerChanged || similarityChanged || result.gap !== old.gap
          ? 'changed'
          : 'unchanged',
      previousTopSimilarity: old.topSimilarity === null ? null : round(old.topSimilarity),
      topSimilarityDelta: delta,
      chunksChanged,
      previousGap: old.gap,
      answerChanged,
    };
  });
  const removed = previous.filter((r) => !seen.has(keyOf(r)));
  return { diffs, removed };
}
