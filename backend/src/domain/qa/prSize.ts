/**
 * Measures a local branch against the QA review's diff budget.
 *
 * Pure domain logic. The files come from `parseUnifiedDiff` (`gitDiff.ts`)
 * and run through the same `prepareReviewDiff`, so "fits" here means the
 * reviewer would read every file there.
 */

import {
  LOCKFILES,
  prepareReviewDiff,
  type ChangedFile,
  type DiffBudget,
  type DiffCoverage,
} from './diff';
import { describeCoverage, SIZE_ADVISORY_THRESHOLD, sizeAdvisory } from './review';

/**
 * Whether the review withholds a file's patch on purpose, mirroring
 * `isPatchWithheld` in `diff.ts` (kept private there: that file runs the
 * review, so changing it puts a pull request under manual review).
 */
function isWithheld(file: ChangedFile, budget: DiffBudget): boolean {
  const base = file.filename.slice(file.filename.lastIndexOf('/') + 1);
  return budget.skipPatchesFor.includes(file.filename) || LOCKFILES.includes(base);
}

/** One key per changed file: two files can share a name only across a rename. */
function fileKey(file: { filename: string; previousFilename?: string }): string {
  return `${file.filename}\u0000${file.previousFilename ?? ''}`;
}

function chars(n: number): string {
  return n.toLocaleString('en-US');
}

export interface PrSizeReport {
  /** True when the QA review would read every file (no file omitted). */
  fits: boolean;
  coverage: DiffCoverage;
  /** Files with a patch that the budget would keep from the reviewer. */
  notShown: ChangedFile[];
  /** Files shown, but with their patch cut at the per-file budget. */
  shortened: ChangedFile[];
  text: string;
}

/**
 * Says whether a set of changed files fits the QA review's diff budget.
 *
 * "Fits" uses the review's own test: a file omitted from the diff is what
 * turns the review gate into `manual-review` and adds the split advisory.
 * A patch cut at the per-file budget is reported but does not fail the
 * check: splitting the pull request does not shorten that file's diff.
 */
export function measurePrSize(
  files: readonly ChangedFile[],
  budget: DiffBudget,
  base: string,
): PrSizeReport {
  const { coverage, shown } = prepareReviewDiff(files, budget);
  const shownKeys = new Set(shown.map(fileKey));
  const patched = files.filter((file) => file.patch !== undefined && !isWithheld(file, budget));

  const notShown = patched.filter((file) => !shownKeys.has(fileKey(file)));
  const shortened = patched.filter(
    (file) => shownKeys.has(fileKey(file)) && (file.patch?.length ?? 0) > budget.perFileChars,
  );
  const fits = coverage.omittedFiles <= SIZE_ADVISORY_THRESHOLD;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const share = Math.round((coverage.patchChars / budget.totalChars) * 100);

  const lines = [
    `Base: ${base} · ${files.length} files changed, +${additions} -${deletions}`,
    `Patch text: ${chars(coverage.patchChars)} characters (${share}% of the ${chars(budget.totalChars)} review budget; ${chars(budget.perFileChars)} per file; lockfiles excluded)`,
    describeCoverage(coverage),
    '',
  ];

  if (fits) {
    lines.push('FITS: the QA review would read every file.');
    if (share >= 75) {
      lines.push('Near the limit: more changes on this branch may push files out of the review.');
    }
  } else {
    lines.push(
      `OVER BUDGET: ${notShown.length} of ${files.length} files would not be shown to the QA reviewer, and its gate would ask for a manual review.`,
    );
    const advice = sizeAdvisory(coverage, SIZE_ADVISORY_THRESHOLD);
    if (advice !== null) {
      lines.push(advice.split('\n').slice(1).join(' '));
    }
    lines.push('', 'Not shown to the reviewer:');
    for (const file of notShown) {
      lines.push(
        `  ${file.filename} (+${file.additions} -${file.deletions}, ${chars(file.patch?.length ?? 0)} chars)`,
      );
    }
  }

  if (shortened.length > 0) {
    lines.push('', `Shortened to ${chars(budget.perFileChars)} characters (the rest is hidden):`);
    for (const file of shortened) {
      lines.push(`  ${file.filename} (${chars(file.patch?.length ?? 0)} chars)`);
    }
  }

  return { fits, coverage, notShown, shortened, text: lines.join('\n') };
}
