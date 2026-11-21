/**
 * Measures a local branch against the QA review's diff budget.
 *
 * Pure domain logic: the caller runs `git diff` and passes its output in.
 * The QA agent reads a pull request's files from the GitHub API; this turns
 * a local unified diff into the same `ChangedFile` shape and runs it
 * through the same `prepareReviewDiff`, so "fits" here means the reviewer
 * would read every file there.
 */

import {
  LOCKFILES,
  prepareReviewDiff,
  type ChangedFile,
  type DiffBudget,
  type DiffCoverage,
} from './diff';
import { describeCoverage, SIZE_ADVISORY_THRESHOLD, sizeAdvisory } from './review';

const SECTION_PREFIX = 'diff --git ';

/**
 * Undoes git's quoting of an unusual path (`"a/with \"quote\""`).
 *
 * With `core.quotePath=false` git only quotes paths holding control
 * characters, quotes or backslashes, so the common escapes are enough.
 */
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }

  return path.slice(1, -1).replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      default:
        return char;
    }
  });
}

/** The path on a `---` / `+++` line, without its `a/` or `b/` prefix; null for /dev/null. */
function markerPath(value: string): string | null {
  // git appends a tab to the marker line when the path contains a space.
  const path = unquote(value.replace(/\t$/, ''));
  if (path === '/dev/null') {
    return null;
  }

  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/**
 * The path from a `diff --git a/P b/P` line, when both sides are the same.
 *
 * Only used for a section with no `---`/`+++` lines and no rename (a binary
 * file or a mode change). A path with spaces makes the line ambiguous in
 * general, but when both sides are equal its length settles it.
 */
function sectionPath(line: string): string | null {
  const rest = line.slice(SECTION_PREFIX.length);
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length <= 0) {
    return null;
  }

  const oldPath = rest.slice(2, 2 + length);
  const newPath = rest.slice(length + 5);
  return rest.startsWith('a/') &&
    rest.slice(length + 2, length + 5) === ' b/' &&
    oldPath === newPath
    ? oldPath
    : null;
}

function parseSection(lines: readonly string[]): ChangedFile {
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  const hunks = firstHunk === -1 ? [] : lines.slice(firstHunk);

  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let added = false;
  let removed = false;

  for (const line of header) {
    if (line.startsWith('--- ')) {
      oldPath = markerPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      newPath = markerPath(line.slice(4));
    } else if (line.startsWith('rename from ')) {
      renameFrom = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      renameTo = unquote(line.slice('rename to '.length));
    } else if (line.startsWith('new file mode')) {
      added = true;
    } else if (line.startsWith('deleted file mode')) {
      removed = true;
    }
  }

  const filename = renameTo ?? newPath ?? oldPath ?? sectionPath(lines[0] ?? '') ?? '(unknown)';
  const status = added ? 'added' : removed ? 'removed' : renameTo ? 'renamed' : 'modified';

  let additions = 0;
  let deletions = 0;
  for (const line of hunks) {
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  const file: ChangedFile = { filename, status, additions, deletions };
  if (renameFrom !== null && renameTo !== null) {
    file.previousFilename = renameFrom;
  }
  if (hunks.length > 0) {
    // GitHub's `patch` is the hunks alone, from the first `@@`, with no
    // trailing newline.
    file.patch = hunks.join('\n');
  }

  return file;
}

/**
 * Turns `git diff` output into the files a pull request would list.
 *
 * Expects the output of `git diff --no-color --no-ext-diff -M`, ideally
 * with `-c core.quotePath=false`. Each file's `patch` matches what the
 * GitHub API returns for it: the hunks only.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  // The output ends with a newline, which leaves one empty line behind. A
  // real empty context line is a single space, so this is never content.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith(SECTION_PREFIX)) {
      sections.push([line]);
    } else {
      sections[sections.length - 1]?.push(line);
    }
  }

  return sections.map(parseSection);
}

function isLockfile(filename: string): boolean {
  return LOCKFILES.includes(filename.slice(filename.lastIndexOf('/') + 1));
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
  const shownNames = new Set(shown.map((file) => file.filename));
  const patched = files.filter((file) => file.patch !== undefined && !isLockfile(file.filename));

  const notShown = patched.filter((file) => !shownNames.has(file.filename));
  const shortened = patched.filter(
    (file) => shownNames.has(file.filename) && (file.patch?.length ?? 0) > budget.perFileChars,
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
