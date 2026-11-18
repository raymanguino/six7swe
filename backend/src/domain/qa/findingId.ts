/**
 * Finding identifiers.
 *
 * A finding's identity does not survive a run, so anything kept by hand
 * about a finding (a verdict, a note) needs an identifier to attach to. It
 * is computed here, from the sanitized finding, so the stats line, the
 * review body and a verdict file all carry the same value.
 *
 * The domain builds the canonical text and shapes the identifier, but the
 * hash itself is injected (`HashFn`): the domain uses no Node APIs, and the
 * caller passes a SHA-256 hex digest such as `hashData` from `util/hash`.
 * Two callers that hash differently get different ids, so the stats line
 * and the review body must be given the same function.
 *
 * Scope: an identifier names a finding in one run, that is one pull
 * request at one commit. The same defect reported at the next commit gets
 * a different identifier, because the commit is part of the hash.
 * Recognising the same finding across commits is #146's job, not this
 * module's.
 */

import type { ReviewFinding } from './verdict';

/** The length of the hash part of an identifier, in hex characters. */
const FINDING_ID_HASH_CHARS = 16;

/**
 * What an identifier looks like: the hash, and `-2`, `-3`... for the
 * repeats of a finding within one run (see `findingIds`).
 */
export const FINDING_ID_PATTERN = /^[0-9a-f]{16}(?:-[2-9]|-[1-9]\d+)?$/;

/** Hashes text to a lowercase hex digest, at least 16 characters long (SHA-256 hex). */
export type HashFn = (data: string) => string;

export type IdentifiableFinding = Pick<ReviewFinding, 'severity' | 'file' | 'line' | 'message'>;

interface RunKey {
  pr: number;
  sha: string;
}

/**
 * The hash of a sanitized finding in one run.
 *
 * The pull request, the commit, the file, the line, the severity and the
 * message, hashed as JSON so no message can run into the next field. It
 * is computed after sanitizing: a corrected line is already null, and a
 * merged steering finding is the merged one.
 *
 * Two findings that agree on all of these have the same hash. Use
 * `findingIds` for a whole run, which keeps them apart.
 */
export function findingId(run: RunKey, finding: IdentifiableFinding, hash: HashFn): string {
  const payload = JSON.stringify([
    run.pr,
    run.sha,
    finding.file,
    finding.line,
    finding.severity,
    finding.message,
  ]);

  return hash(payload).slice(0, FINDING_ID_HASH_CHARS);
}

/**
 * The identifiers of a run's findings, in order, each one unique.
 *
 * A repeat of an identifier gets a `-2`, `-3`... suffix, by order of
 * appearance. That covers a model that reports the same finding twice,
 * and two findings whose lines were both corrected to null with the same
 * message. The suffix depends on the order, so the findings have to be in
 * the order the review lists them, which is the order the stats line
 * carries.
 */
export function findingIds(
  run: RunKey,
  findings: readonly IdentifiableFinding[],
  hash: HashFn,
): string[] {
  const seen = new Map<string, number>();

  return findings.map((finding) => {
    const id = findingId(run, finding, hash);
    const occurrence = (seen.get(id) ?? 0) + 1;
    seen.set(id, occurrence);

    return occurrence === 1 ? id : `${id}-${occurrence}`;
  });
}
