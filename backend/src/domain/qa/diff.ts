/**
 * Diff preparation for the review model.
 *
 * Pure domain logic: no IO, no framework imports. A raw pull request diff is
 * far too large for the model - `pnpm-lock.yaml` alone can be enormous - so
 * the diff is trimmed to a budget here and the output says explicitly what
 * was left out. A model that is told what it did not see does not report on
 * code it never read.
 */

export interface ChangedFile {
  filename: string;
  /**
   * The path the file had before a rename or a move.
   *
   * GitHub reports the new path in `filename` and the old one in
   * `previous_filename`. A pull request that moves a protected file out of
   * a protected directory is still a change to that protected file, so both
   * paths have to be checked.
   */
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface DiffBudget {
  /** Maximum characters kept for a single file's patch. */
  perFileChars: number;
  /** Maximum characters kept across all files combined. */
  totalChars: number;
  /** Files whose patch is skipped but still listed. */
  skipPatchesFor: readonly string[];
}

/**
 * How much of the diff the review model is shown.
 *
 * The per-file budget keeps one large file from crowding out the rest; the
 * total budget bounds the whole prompt. Both are generous enough that a
 * normal pull request is shown in full. The calibration report compares
 * pull request sizes against `totalChars`, so it lives here, once.
 */
export const REVIEW_DIFF_BUDGET: DiffBudget = {
  perFileChars: 8_000,
  totalChars: 60_000,
  skipPatchesFor: [],
};

/**
 * Lockfiles are listed but never patched.
 *
 * They are noise for a review - they are generated, they are usually the
 * bulk of the diff, and reading them teaches the model nothing. The match
 * is on the file name, so a nested lockfile is skipped too.
 */
export const LOCKFILES: readonly string[] = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

/**
 * The prefix every notice the builder emits carries.
 *
 * The notices tell the model that it did not see everything, which makes
 * them a signal an attacker would want to forge: a pull request that
 * claims its own diff was truncated gets the model to look less
 * carefully. The prefix is distinctive so the prompt can tell a real
 * notice from a fake one, and so a notice inside the reviewed content is
 * recognisable as forged.
 *
 * **The placement is part of the contract.** A genuine notice appears in
 * one of exactly two places: on the line immediately after a "### " file
 * header, or in the summary block that follows `DIFF_SUMMARY_MARKER` at
 * the end of the diff. A line inside a patch always starts with "+", "-"
 * or a space, so it can never be mistaken for one, and `displayPath`
 * keeps an author-chosen path from breaking a header onto a second line.
 * The review prompt states this rule, and `buildBlocks` is what keeps it
 * true.
 */
export const DIFF_NOTICE_PREFIX = '[six7swe:';

/**
 * The marker that introduces the summary block.
 *
 * It gives the trailing notices a delimiter of their own, so "a notice
 * in the summary" is a position that can be pointed at rather than a
 * guess about where the file list ends.
 */
export const DIFF_SUMMARY_MARKER = `${DIFF_NOTICE_PREFIX} summary]`;

/** Marker written in place of a patch that was deliberately not included. */
export const PATCH_SKIPPED_MARKER = `${DIFF_NOTICE_PREFIX} patch not included]`;

/**
 * Marker written for a file that has no patch at all.
 *
 * Pure renames, mode changes and binary files have no diff. That is not
 * truncation: there was nothing to show in the first place.
 */
export const NO_PATCH_MARKER = `${DIFF_NOTICE_PREFIX} no patch available]`;

function isLockfile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  return LOCKFILES.includes(base);
}

/**
 * Characters that end a line, or that a model may read as ending one: the
 * C0 controls (which include "\n" and "\r"), DEL, NEL, and the Unicode
 * line and paragraph separators.
 */
// eslint-disable-next-line no-control-regex
const LINE_BREAKING_CHARACTERS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;

/**
 * Renders a path so that it always stays on one line.
 *
 * A path is chosen by the pull request author, and git allows a newline
 * in one. Written as it is, a file named "a.ts\n[six7swe: patch not
 * included]" would put a forged notice on the line right after a file
 * header, which is exactly where the prompt says a genuine one sits.
 * Each line-breaking character is written as a visible \u escape instead.
 */
export function displayPath(path: string): string {
  return path.replace(
    LINE_BREAKING_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function header(file: ChangedFile): string {
  const previous = file.previousFilename
    ? ` (moved from ${displayPath(file.previousFilename)})`
    : '';
  return `### ${displayPath(file.filename)}${previous} (${file.status}) +${file.additions} -${file.deletions}`;
}

/**
 * Every path a pull request touches.
 *
 * For a renamed file this is both the new path and the old one. Anything
 * that reasons about "which paths did this pull request change" has to see
 * both, otherwise moving a protected file out of a protected directory
 * hides the change.
 */
export function allTouchedPaths(files: readonly ChangedFile[]): string[] {
  const paths: string[] = [];

  for (const file of files) {
    paths.push(file.filename);
    if (file.previousFilename) {
      paths.push(file.previousFilename);
    }
  }

  return paths;
}

/**
 * The line numbers a patch touches, in the new revision of the file.
 *
 * Read from the hunk headers of a unified diff: `@@ -1,3 +10,4 @@` covers
 * lines 10 to 13 of the new file. A finding that points at a line outside
 * that set points at code the model cannot have read.
 */
export function hunkLineNumbers(patch: string): Set<number> {
  const lines = new Set<number>();
  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

  let match = hunkHeader.exec(patch);
  while (match !== null) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);

    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }

    match = hunkHeader.exec(patch);
  }

  return lines;
}

interface DiffBlock {
  text: string;
  /** The patch was deliberately withheld (lockfile, or explicitly skipped). */
  skipped: boolean;
  /** The file has no patch at all (binary, rename, mode change). */
  missing: boolean;
  /** The patch was cut short to fit the per-file budget. */
  shortened: boolean;
}

function buildBlocks(files: readonly ChangedFile[], budget: DiffBudget): DiffBlock[] {
  const blocks: DiffBlock[] = [];

  for (const file of files) {
    const patch = file.patch ?? '';

    if (budget.skipPatchesFor.includes(file.filename) || isLockfile(file.filename)) {
      blocks.push({
        text: `${header(file)}\n${PATCH_SKIPPED_MARKER}`,
        skipped: true,
        missing: false,
        shortened: false,
      });
      continue;
    }

    if (patch.length === 0) {
      blocks.push({
        text: `${header(file)}\n${NO_PATCH_MARKER}`,
        skipped: false,
        missing: true,
        shortened: false,
      });
      continue;
    }

    const shortened = patch.length > budget.perFileChars;
    const text = shortened ? patch.slice(0, budget.perFileChars) : patch;

    // The notice goes immediately after the header, before the patch, so
    // that every notice the builder emits sits in the same place: on the
    // line right after a file header. The prompt tells the model that is
    // the only place a genuine notice can appear, which is what makes a
    // forged notice inside the reviewed content recognisable as forged.
    //
    // Placing it after the patch instead would put a genuine notice in
    // the middle of the diff, where the model is told to look for a
    // forgery, and it would report the tooling's own notice as an
    // attempt to steer the review.
    blocks.push({
      text: shortened
        ? `${header(file)}\n${DIFF_NOTICE_PREFIX} patch shortened to ${budget.perFileChars} characters]\n${text}`
        : `${header(file)}\n${text}`,
      skipped: false,
      missing: false,
      shortened,
    });
  }

  return blocks;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * The summary notices that close the diff: what was omitted, withheld,
 * shortened or had no patch. Empty when the model saw everything.
 */
function buildNotices(kept: readonly DiffBlock[], omitted: number): string[] {
  const notices: string[] = [];

  if (omitted > 0) {
    notices.push(
      `${DIFF_NOTICE_PREFIX} ${omitted} ${plural(omitted, 'file', 'files')} omitted from this diff]`,
    );
  }

  const skipped = kept.filter((block) => block.skipped).length;
  if (skipped > 0) {
    notices.push(
      `${DIFF_NOTICE_PREFIX} ${skipped} ${plural(skipped, 'patch', 'patches')} not included]`,
    );
  }

  const shortened = kept.filter((block) => block.shortened).length;
  if (shortened > 0) {
    notices.push(
      `${DIFF_NOTICE_PREFIX} ${shortened} ${plural(shortened, 'patch', 'patches')} shortened]`,
    );
  }

  const missing = kept.filter((block) => block.missing).length;
  if (missing > 0) {
    notices.push(
      `${DIFF_NOTICE_PREFIX} ${missing} ${plural(missing, 'file', 'files')} have no patch]`,
    );
  }

  if (notices.length === 0) {
    return notices;
  }

  // The summary is introduced by its own marker so that "a notice in the
  // summary" is a position the model can point at, rather than a guess
  // about where the file list ends.
  return [DIFF_SUMMARY_MARKER, ...notices];
}

/**
 * How much of the pull request the model was shown.
 *
 * These are the numbers the builder itself used, returned alongside the
 * text, so the review body and the run stats cannot drift from what the
 * model actually saw.
 *
 * Lockfiles and files with no patch are listed on purpose and are not
 * omissions: there was nothing worth showing.
 */
export interface DiffCoverage {
  /** Files in the pull request. */
  totalFiles: number;
  /** Files dropped from the diff because the total budget ran out. */
  omittedFiles: number;
  /** Files shown, but with the patch cut to `perFileChars`. */
  shortenedPatches: number;
  /**
   * Patch characters before any budget, lockfiles and skipped files
   * excluded. Unlike the diff length, which is capped at `totalChars`, this
   * shows how far over budget a pull request was.
   */
  patchChars: number;
}

export interface ReviewDiff {
  text: string;
  coverage: DiffCoverage;
}

/**
 * Builds the model-ready diff for a pull request, with its coverage.
 *
 * Every file is listed in order with a short status header. Lockfiles are
 * listed without their patch, remaining patches are truncated to
 * `perFileChars`, and the whole thing is truncated to `totalChars`.
 * Whenever something is dropped the output says so, so the model can tell
 * the difference between "no problems here" and "never looked here".
 *
 * A file that does not fit the remaining budget is skipped and the ones
 * after it are still considered. Dropping every remaining file because the
 * first one was large would hide the small files behind it.
 */
export function prepareReviewDiff(files: readonly ChangedFile[], budget: DiffBudget): ReviewDiff {
  const blocks = buildBlocks(files, budget);

  const patchChars = files
    .filter((file) => !budget.skipPatchesFor.includes(file.filename) && !isLockfile(file.filename))
    .reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);

  const kept: DiffBlock[] = [];
  let used = 0;
  let omitted = 0;

  for (const block of blocks) {
    const cost = block.text.length + (kept.length > 0 ? 1 : 0);

    if (used + cost > budget.totalChars) {
      omitted += 1;
      continue;
    }

    kept.push(block);
    used += cost;
  }

  const result = (text: string): ReviewDiff => ({
    text,
    coverage: {
      totalFiles: files.length,
      omittedFiles: omitted,
      shortenedPatches: kept.filter((block) => block.shortened).length,
      patchChars,
    },
  });

  for (;;) {
    const notices = buildNotices(kept, omitted);
    const noticeText = notices.join('\n');
    const body = kept.map((block) => block.text).join('\n');
    const combined =
      body.length === 0 ? noticeText : noticeText.length > 0 ? `${body}\n${noticeText}` : body;

    if (combined.length <= budget.totalChars) {
      return result(combined);
    }

    if (kept.length === 0) {
      // Nothing fits, but the notices are the most valuable part of the
      // output: they are what tells the model it did not see everything.
      return result(noticeText.slice(0, budget.totalChars));
    }

    kept.pop();
    omitted += 1;
  }
}

/** The model-ready diff text alone. See `prepareReviewDiff`. */
export function buildReviewDiff(files: readonly ChangedFile[], budget: DiffBudget): string {
  return prepareReviewDiff(files, budget).text;
}
