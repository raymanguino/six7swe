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
 * bulk of the diff, and reading them teaches the model nothing.
 */
export const LOCKFILES: readonly string[] = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

/** Marker written in place of a patch that was deliberately not included. */
export const PATCH_SKIPPED_MARKER = '[patch not included]';

function isLockfile(filename: string): boolean {
  return LOCKFILES.includes(filename);
}

function header(file: ChangedFile): string {
  return `### ${file.filename} (${file.status}) +${file.additions} -${file.deletions}`;
}

/**
 * Builds the model-ready diff text for a pull request.
 *
 * Every file is listed in order with a short status header. Lockfiles are
 * listed without their patch, remaining patches are truncated to
 * `perFileChars`, and the whole thing is truncated to `totalChars`. Whenever
 * something is dropped the output says so, so the model can tell the
 * difference between "no problems here" and "never looked here".
 */
export function buildReviewDiff(files: readonly ChangedFile[], budget: DiffBudget): string {
  const blocks: string[] = [];
  let skippedPatches = 0;
  let shortenedPatches = 0;

  for (const file of files) {
    const patch = file.patch ?? '';
    const skip = budget.skipPatchesFor.includes(file.filename) || isLockfile(file.filename);

    if (skip || patch.length === 0) {
      skippedPatches += 1;
      blocks.push(`${header(file)}\n${PATCH_SKIPPED_MARKER}`);
      continue;
    }

    const shortened = patch.length > budget.perFileChars;
    const text = shortened ? patch.slice(0, budget.perFileChars) : patch;
    if (shortened) {
      shortenedPatches += 1;
    }

    blocks.push(
      shortened
        ? `${header(file)}\n${text}\n[patch shortened to ${budget.perFileChars} characters]`
        : `${header(file)}\n${text}`,
    );
  }

  // Fill the total budget with as many whole files as fit, in order.
  const kept: string[] = [];
  let used = 0;

  for (const block of blocks) {
    const cost = block.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget.totalChars) {
      break;
    }
    kept.push(block);
    used += cost;
  }

  for (;;) {
    const body = kept.join('\n');
    const omitted = blocks.length - kept.length;
    const notices = buildNotices(omitted, skippedPatches, shortenedPatches);
    const text = notices.length > 0 ? `${body}\n${notices.join('\n')}` : body;

    if (text.length <= budget.totalChars || kept.length === 0) {
      return text.slice(0, budget.totalChars);
    }

    // The notices do not fit alongside every file: drop the last one and
    // recompute, so the output never claims more than it delivered.
    kept.pop();
  }
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function buildNotices(
  omittedFiles: number,
  skippedPatches: number,
  shortenedPatches: number,
): string[] {
  const notices: string[] = [];

  if (omittedFiles > 0) {
    notices.push(
      `[diff truncated: ${omittedFiles} ${plural(omittedFiles, 'file', 'files')} omitted]`,
    );
  }
  if (skippedPatches > 0) {
    notices.push(
      `[diff truncated: ${skippedPatches} ${plural(skippedPatches, 'patch', 'patches')} not included]`,
    );
  }
  if (shortenedPatches > 0) {
    notices.push(
      `[diff truncated: ${shortenedPatches} ${plural(shortenedPatches, 'patch', 'patches')} shortened]`,
    );
  }

  return notices;
}
