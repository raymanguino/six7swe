/**
 * Review verdicts.
 *
 * Pure domain logic: no IO, no framework imports, no model calls. The
 * agent's findings are turned into a single gate outcome and a single
 * review event here, so both decisions are unit-testable and the
 * Phase 1 -> Phase 2 flip is a single argument at the call site.
 *
 * The path policy lives here rather than in the workflow file on purpose: a
 * pull request can edit its own workflow file, but it cannot edit the agent
 * code the workflow checks out from `base.sha`.
 */

import { addedLineNumbers, allTouchedPaths, type ChangedFile } from './diff';

/**
 * The GitHub review events this agent is allowed to post.
 *
 * `APPROVE` is deliberately absent. An approval posted by the agent can
 * satisfy the "require approving reviews" branch-protection rule, and the
 * whole point of the status-check gate is that a human still owns that
 * approval. The agent reports; it never rubber-stamps.
 */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES';

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
 * `comment-only` is Phase 1: the agent reports and never blocks.
 * `enforce` is Phase 2: the agent blocks a pull request that has a
 * blocking finding.
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
 * The event is derived from the gate outcome, never computed separately.
 * Two independent decisions about the same pull request could disagree,
 * and an agent that approves a pull request the gate wants a human to
 * look at is exactly the kind of bug this module exists to prevent.
 */
export function reviewEventForGate(gate: GateOutcome): ReviewEvent {
  if (gate === 'fail') {
    return 'REQUEST_CHANGES';
  }

  // `manual-review` and `fail-closed` are not the agent asking for
  // changes: the first needs a human, the second is the agent broken.
  // Both are explained in the review body.
  return 'COMMENT';
}

export interface GateInput {
  /** Raw findings from the model. They are sanitized inside this function. */
  findings: readonly ReviewFinding[];
  /**
   * The files the pull request changed.
   *
   * The file objects are needed, not just their names: a rename carries
   * the path it came from, and the patches carry the line numbers a
   * finding can legitimately point at.
   */
  changedFiles: readonly ChangedFile[];
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
 *
 * The findings are sanitized here rather than being expected to arrive
 * sanitized, so a caller that forgets the step cannot have a hallucinated
 * path block a merge.
 */
export function decideGate(input: GateInput): GateOutcome {
  if (!input.reviewCompleted) {
    return 'fail-closed';
  }

  if (input.mode === 'comment-only') {
    return 'pass';
  }

  if (touchesProtectedPath(allTouchedPaths(input.changedFiles), input.protectedPaths)) {
    return 'manual-review';
  }

  const findings = sanitizeFindings(input.findings, input.changedFiles);

  return findings.some((finding) => BLOCKING_SEVERITIES.includes(finding.severity))
    ? 'fail'
    : 'pass';
}

/**
 * Decides which GitHub review event the findings justify.
 *
 * The default is `comment-only`, so the safe behaviour is what you get if
 * nobody passes a mode. Phase 2 flips the *caller*, not the default.
 */
export function decideReviewEvent(
  findings: readonly ReviewFinding[],
  mode: ReviewMode = 'comment-only',
  options: {
    changedFiles?: readonly ChangedFile[];
    protectedPaths?: readonly string[];
  } = {},
): ReviewEvent {
  return reviewEventForGate(
    decideGate({
      findings,
      changedFiles: options.changedFiles ?? [],
      mode,
      protectedPaths: options.protectedPaths,
      reviewCompleted: true,
    }),
  );
}

/**
 * Paths a pull request must never be allowed to pass automatically.
 *
 * A pull request that edits the workflow, the decision logic, the review
 * client, the schema, the auth code or the dependency manifest is changing
 * the thing that judges it, or the thing that runs it. Those pull requests
 * get a red check and a human decision.
 *
 * `backend/package.json` and `pnpm-workspace.yaml` are here for the same
 * reason as the root `package.json`: their scripts and their dependency
 * and registry settings are what the agent itself runs under.
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
  'backend/migrations/**',
  'backend/drizzle.config.ts',
  'backend/jest.config.js',
  'backend/tsconfig*.json',
  'backend/package.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.npmrc',
];

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * Compiles a glob into a regular expression.
 *
 * `**` matches any number of path segments, `*` matches within one
 * segment. A trailing `/**` also matches the directory itself, and a bare
 * `**` matches every path.
 */
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;

    if (segment === '**') {
      if (isLast) {
        if (source.endsWith('/')) {
          source = `${source.slice(0, -1)}(?:/.*)?`;
        } else {
          source = source.length > 0 ? `${source}(?:/.*)?` : '.*';
        }
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
 * Reports whether any changed path matches a protected path.
 *
 * A pattern matches when it matches the whole path, or when the path starts
 * with the pattern as a directory prefix, so `backend/src/db/schema` covers
 * the files inside it even without a `/**` suffix.
 */
export function touchesProtectedPath(
  changedPaths: readonly string[],
  patterns: readonly string[] = DEFAULT_PROTECTED_PATTERNS,
): boolean {
  for (const pattern of patterns) {
    const matcher = globToRegExp(pattern);

    for (const path of changedPaths) {
      if (matcher.test(path) || path.startsWith(`${pattern}/`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Removes the findings that cannot be trusted.
 *
 * A finding that references a file the pull request did not touch is a
 * hallucination and is dropped outright: there is nothing left of it.
 *
 * A finding that references a line the diff does not contain keeps its
 * message but loses its line number. The line is wrong, the observation
 * may not be, and a wrong line number would make GitHub reject an inline
 * comment outright.
 *
 * Findings without a file are general observations about the change and
 * are kept as they are.
 */
export function sanitizeFindings(
  findings: readonly ReviewFinding[],
  changedFiles: readonly ChangedFile[],
): ReviewFinding[] {
  const touched = new Set(allTouchedPaths(changedFiles));
  const linesByPath = new Map<string, Set<number>>();

  for (const file of changedFiles) {
    const lines = addedLineNumbers(file.patch ?? '');

    if (!linesByPath.has(file.filename)) {
      linesByPath.set(file.filename, lines);
    }
    if (file.previousFilename && !linesByPath.has(file.previousFilename)) {
      linesByPath.set(file.previousFilename, lines);
    }
  }

  const sanitized: ReviewFinding[] = [];

  for (const finding of findings) {
    if (finding.file === null) {
      sanitized.push(finding);
      continue;
    }

    if (!touched.has(finding.file)) {
      continue;
    }

    if (finding.line === null) {
      sanitized.push(finding);
      continue;
    }

    const validLines = linesByPath.get(finding.file);

    sanitized.push(validLines?.has(finding.line) === true ? finding : { ...finding, line: null });
  }

  return sanitized;
}
