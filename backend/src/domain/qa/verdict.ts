/**
 * Review verdicts.
 *
 * Pure domain logic: no IO, no framework imports, no model calls. The
 * agent's findings are turned into a single GitHub review event here, so the
 * decision is unit-testable and the Phase 1 -> Phase 2 flip is a single
 * argument at the call site.
 */

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  message: string;
}

/**
 * How the agent's output is applied.
 *
 * `comment-only` is Phase 1: the agent reports and never approves.
 * `enforce` is Phase 2: the agent approves clean PRs and blocks the rest.
 */
export type ReviewMode = 'comment-only' | 'enforce';

/** Severities that block a merge once the agent is allowed to enforce. */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major'];

/**
 * Decides which GitHub review event the findings justify.
 *
 * The default is `comment-only`, so the safe behaviour is what you get if
 * nobody passes a mode. Phase 2 flips the *caller*, not the default.
 */
export function decideReviewEvent(
  findings: readonly ReviewFinding[],
  mode: ReviewMode = 'comment-only',
): ReviewEvent {
  if (mode === 'comment-only') {
    return 'COMMENT';
  }

  return findings.some((finding) => BLOCKING_SEVERITIES.includes(finding.severity))
    ? 'REQUEST_CHANGES'
    : 'APPROVE';
}

/**
 * Drops findings that reference a file the pull request did not touch.
 *
 * The model can invent a path that is not in the diff. Such a finding is a
 * hallucination and must never reach a reviewer, so it is dropped here
 * rather than being softened into a general comment. Findings without a file
 * are general observations about the change and are kept.
 */
export function sanitizeFindings(
  findings: readonly ReviewFinding[],
  changedFiles: readonly string[],
): ReviewFinding[] {
  const known = new Set(changedFiles);

  return findings.filter((finding) => finding.file === null || known.has(finding.file));
}
