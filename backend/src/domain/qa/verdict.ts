/**
 * Review verdicts.
 *
 * Pure domain logic: no IO, no framework imports, no model calls. The
 * agent's findings are turned into a single GitHub review event and a single
 * gate outcome here, so both decisions are unit-testable and the
 * Phase 1 -> Phase 2 flip is a single argument at the call site.
 *
 * The path policy lives here rather than in the workflow file on purpose: a
 * pull request can edit its own workflow file, but it cannot edit the agent
 * code the workflow checks out from `base.sha`.
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

/**
 * What the workflow should do with this review.
 *
 * `pass` and `fail` are the ordinary outcomes. `manual-review` means the
 * pull request touched something that judges it, so a human decides.
 * `fail-closed` means the review could not be completed at all - an API
 * error, a schema failure, a truncated model response - and must never be
 * mistaken for a clean review.
 */
export type GateOutcome = 'pass' | 'fail' | 'manual-review' | 'fail-closed';

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

export interface GateInput {
  findings: readonly ReviewFinding[];
  changedFiles: readonly string[];
  mode: ReviewMode;
  protectedPaths?: readonly string[];
  /** False when the review could not be completed. */
  reviewCompleted: boolean;
}

/**
 * Decides whether the required check goes green or red.
 *
 * The order matters:
 *
 * 1. A review that could not be completed is `fail-closed`, whatever the
 *    mode. A broken agent is not a clean pull request.
 * 2. `comment-only` always passes. Phase 1 observes; it never blocks.
 * 3. A pull request that touches a protected path needs a human.
 * 4. Otherwise a blocking finding fails, and everything else passes.
 */
export function decideGate(input: GateInput): GateOutcome {
  if (!input.reviewCompleted) {
    return 'fail-closed';
  }

  if (input.mode === 'comment-only') {
    return 'pass';
  }

  if (touchesProtectedPath(input.changedFiles, input.protectedPaths)) {
    return 'manual-review';
  }

  return input.findings.some((finding) => BLOCKING_SEVERITIES.includes(finding.severity))
    ? 'fail'
    : 'pass';
}

/**
 * Paths a pull request must never be allowed to pass automatically.
 *
 * A pull request that edits the workflow, the decision logic, the review
 * client, the schema, the auth code or the dependency manifest is changing
 * the thing that judges it, or the thing that runs it. Those pull requests
 * get a red check and a human decision.
 *
 * This is defence in depth, not a hard boundary: a pull request that edits
 * `.github/workflows/qa-review.yml` can also edit the exit-code mapping in
 * that same file. What it cannot do is edit the agent code, because the
 * workflow checks out `base.sha`.
 */
export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
  'backend/src/domain/qa/**',
  'backend/src/services/github/**',
  'backend/src/services/ai/**',
  'backend/src/scripts/review-pr.ts',
  'backend/scripts/review-pr.ts',
  'backend/src/db/schema/**',
  'backend/src/plugins/auth.ts',
  'backend/src/services/auth/**',
  'backend/src/config/auth.ts',
  'package.json',
  'pnpm-lock.yaml',
];

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * Compiles a glob into a regular expression.
 *
 * `**` matches any number of path segments, `*` matches within one
 * segment. A trailing `/**` also matches the directory itself.
 */
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;

    if (segment === '**') {
      if (isLast) {
        source = source.replace(/\/$/, '') + '(?:/.*)?';
      } else {
        source += '(?:[^/]+/)*';
      }
      continue;
    }

    source += segment.split('*').map(escapeRegExp).join('[^/]*');

    if (!isLast) {
      source += '/';
    }
  }

  return new RegExp(`^${source}$`);
}

/**
 * Reports whether any changed file matches a protected path.
 *
 * A pattern matches when it matches the whole path, or when the path starts
 * with the pattern as a directory prefix, so `backend/src/db/schema` covers
 * the files inside it even without a `/**` suffix.
 */
export function touchesProtectedPath(
  changedFiles: readonly string[],
  patterns: readonly string[] = DEFAULT_PROTECTED_PATTERNS,
): boolean {
  for (const pattern of patterns) {
    const matcher = globToRegExp(pattern);

    for (const file of changedFiles) {
      if (matcher.test(file) || file.startsWith(`${pattern}/`)) {
        return true;
      }
    }
  }

  return false;
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
