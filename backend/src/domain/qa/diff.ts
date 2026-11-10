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
 */
export const DIFF_NOTICE_PREFIX = '[six7swe:';

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

function header(file: ChangedFile): string {
  const previous = file.previousFilename ? ` (moved from ${file.previousFilename})` : '';
  return `### ${file.filename}${previous} (${file.status}) +${file.additions} -${file.deletions}`;
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

    blocks.push({
      text: shortened
        ? `${header(file)}\n${text}\n${DIFF_NOTICE_PREFIX} patch shortened to ${budget.perFileChars} characters]`
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
 * The prefix every notice the builder emits carries.
 *
 * The notices tell the model that it did not see everything, which makes
 * them a signal an attacker would want to forge: a pull request that
 * claims its own diff was truncated gets the model to look less
 * carefully. The prefix is distinctive so the prompt can tell a real
 * notice from a fake one, and so a notice inside the reviewed content is
 * recognisable as forged.
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

  return notices;
}

/**
 * Builds the model-ready diff text for a pull request.
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
export function buildReviewDiff(files: readonly ChangedFile[], budget: DiffBudget): string {
  const blocks = buildBlocks(files, budget);

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

  for (;;) {
    const notices = buildNotices(kept, omitted);
    const noticeText = notices.join('\n');
    const body = kept.map((block) => block.text).join('\n');
    const combined =
      body.length === 0 ? noticeText : noticeText.length > 0 ? `${body}\n${noticeText}` : body;

    if (combined.length <= budget.totalChars) {
      return combined;
    }

    if (kept.length === 0) {
      // Nothing fits, but the notices are the most valuable part of the
      // output: they are what tells the model it did not see everything.
      return noticeText.slice(0, budget.totalChars);
    }

    kept.pop();
    omitted += 1;
  }
}
