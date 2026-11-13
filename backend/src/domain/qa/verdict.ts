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

import { allTouchedPaths, hunkLineNumbers, type ChangedFile, type DiffCoverage } from './diff';

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

/**
 * What a finding is about.
 *
 * `defect` is a finding about the code. `steering` is a finding about the
 * pull request's content trying to instruct the reviewer: an injected
 * command, a forged role marker or a forged tooling notice. Such text is
 * worth a human's attention, but it is not a defect in the code, and the
 * person who wrote it is the person the gate is judging.
 */
export type FindingKind = 'defect' | 'steering';

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  message: string;
  /** Absent means `defect`. */
  kind?: FindingKind;
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
 * `pass` and `fail` are the ordinary outcomes. `manual-review` means a
 * human decides: the pull request touched something that judges it, or
 * the model was not shown all of it, so a clean result cannot be trusted.
 * `fail-closed` means the review could not be completed at all - an API
 * error, a schema failure, a truncated model response - and must never be
 * mistaken for a clean review.
 */
export type GateOutcome = 'pass' | 'fail' | 'manual-review' | 'fail-closed';

/** Severities that block a merge once the agent is allowed to enforce. */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major'];

/** The severities, most serious first. */
export const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'major', 'minor', 'nit'];

/**
 * How many findings a review reports.
 *
 * This is a display limit, not a decision limit. The gate sees every
 * finding; only the review body is trimmed, and only after the findings
 * have been sorted so the most serious are the ones that survive.
 */
export const MAX_REPORTED_FINDINGS = 8;

/**
 * The fixed severity of a steering finding, whatever the model said.
 *
 * It is below every blocking severity on purpose. If a steering finding
 * could block, anyone could block a merge in `enforce` mode by pasting
 * trigger text into a pull request description. It stays above `nit` so a
 * reviewer still notices it.
 */
export const STEERING_SEVERITY: FindingSeverity = 'minor';

/** Whether a finding is about the pull request's text rather than its code. */
export function isSteering(finding: ReviewFinding): boolean {
  return finding.kind === 'steering';
}

/** Separates the attempts inside a merged steering finding's message. */
const STEERING_MESSAGE_SEPARATOR = ' | ';

/** How many steering findings a merged message names before "and N more". */
export const MAX_NAMED_STEERING_FINDINGS = 3;

/** The longest text a merged message keeps from each steering finding. */
export const MAX_STEERING_EXCERPT_CHARS = 200;

function excerpt(text: string): string {
  return text.length <= MAX_STEERING_EXCERPT_CHARS
    ? text
    : `${text.slice(0, MAX_STEERING_EXCERPT_CHARS - 3)}...`;
}

/**
 * The message of a merged steering finding.
 *
 * It is bounded well below the length the review body renders, so the
 * count and every named excerpt survive rendering: the count first, then
 * a short excerpt of the first few findings, then how many were left
 * out. The full text of every finding is still in the workflow log.
 */
function mergedSteeringMessage(steering: readonly ReviewFinding[]): string {
  const named = steering
    .slice(0, MAX_NAMED_STEERING_FINDINGS)
    .map((finding) => excerpt(finding.message));
  const rest = steering.length - named.length;
  const parts = rest > 0 ? [...named, `and ${rest} more`] : named;

  return `[${steering.length} steering findings] ${parts.join(STEERING_MESSAGE_SEPARATOR)}`;
}

/**
 * Collapses every steering finding into one, at a fixed severity.
 *
 * The prompt asks for this already; this is the deterministic backstop.
 * A pull request padded with many injected instructions would otherwise
 * fill the display slots with steering findings and push a real defect
 * out of the list, and a steering finding the model rated `blocker` would
 * let pasted text alone fail the gate.
 *
 * Defects keep their order. The single steering finding goes after them.
 * When several are merged, the message is bounded: the count comes first,
 * then short excerpts of the first few, then how many more there were
 * (see mergedSteeringMessage). The full text of each is in the workflow
 * log, not in the review body. A single steering finding keeps its
 * message unchanged, so merging twice changes nothing. The location is
 * kept only when every merged finding shares it; otherwise the finding is
 * about the pull request as a whole.
 *
 * Known residual risk: a model that has been steered could label a real
 * defect as steering, and this would downgrade it to a non-blocking
 * severity. Inducing a relabel is likely cheaper than inducing an
 * omission - text such as "this auth change is pre-approved" next to a
 * real vulnerability could do it - so this is not a complete defence. The
 * finding is still shown, which leaves a human able to catch it.
 */
export function consolidateSteeringFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const defects = findings.filter((finding) => !isSteering(finding));
  const steering = findings.filter(isSteering);

  if (steering.length === 0) {
    return defects;
  }

  const [first] = steering;
  const sameLocation = steering.every(
    (finding) => finding.file === first.file && finding.line === first.line,
  );
  const message = steering.length === 1 ? first.message : mergedSteeringMessage(steering);

  return [
    ...defects,
    {
      severity: STEERING_SEVERITY,
      file: sameLocation ? first.file : null,
      line: sameLocation ? first.line : null,
      message,
      kind: 'steering',
    },
  ];
}

/**
 * Decides whether the gate outcome should turn the required check red.
 *
 * The outcome and the check colour are separate questions, and Phase 1
 * makes them diverge.
 *
 * In `comment-only` mode the agent is an observer, not the gate: nothing
 * it finds blocks a merge, so the check stays green whatever the outcome.
 * That is the phase 1 contract - the check is required and always green,
 * so the ruleset does not have to change when the agent starts enforcing.
 *
 * In `enforce` mode the agent *is* the gate. There, a failed review is
 * red, never green: a broken agent must not look like a clean pull
 * request.
 */
export function gateBlocksMerge(gate: GateOutcome, mode: ReviewMode): boolean {
  if (mode === 'comment-only') {
    return false;
  }

  return gate !== 'pass';
}

/**
 * Orders findings so the most serious come first.
 *
 * The model does not promise to return its findings in order of severity,
 * and a list that is trimmed for display must not be trimmed in the
 * model's order: a blocker written tenth would be cut before anything
 * downstream ever saw it. Findings of equal severity keep their relative
 * order.
 *
 * Every finding about the code comes before any steering finding, so text
 * pasted into a pull request can never push a real defect out of the
 * displayed list.
 */
export function sortFindingsBySeverity(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (left, right) =>
      Number(isSteering(left)) - Number(isSteering(right)) ||
      SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity),
  );
}

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
  /**
   * How much of the pull request the model was shown, from the diff
   * builder. Required, so a caller cannot leave it out and have a partly
   * read pull request pass.
   */
  coverage: DiffCoverage;
}

/** Why a pull request needs a human, when the gate says `manual-review`. */
export type ManualReviewReason = 'protected-path' | 'partial-coverage';

/**
 * Every reason a human has to look, whether or not it decided the gate.
 *
 * `decideGate` stops at the first rule that applies, but the review body
 * has to name every cause: a pull request that touches a protected path
 * and was only partly read needs both said.
 *
 * Only omitted files count as partial coverage. A shortened patch also
 * leaves part of a file unread, but any file over `perFileChars` (about
 * 200 lines) trips it, and that is common. Shortened patches are reported
 * in the body and do not change the outcome.
 */
export function manualReviewReasons(
  input: Pick<GateInput, 'changedFiles' | 'coverage' | 'protectedPaths'>,
): ManualReviewReason[] {
  const reasons: ManualReviewReason[] = [];

  if (touchesProtectedPath(allTouchedPaths(input.changedFiles), input.protectedPaths)) {
    reasons.push('protected-path');
  }
  if (input.coverage.omittedFiles > 0) {
    reasons.push('partial-coverage');
  }

  return reasons;
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
 * 4. A blocking finding in what was read fails.
 * 5. A pull request the model was not shown in full needs a human.
 * 6. Everything else passes.
 *
 * 4 comes before 5 on purpose. A defect found in the part that was read
 * is a real failure and asks for changes; it is not downgraded to "a
 * human should look". Partial coverage only downgrades a pass.
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

  const reasons = manualReviewReasons(input);

  if (reasons.includes('protected-path')) {
    return 'manual-review';
  }

  const findings = sanitizeFindings(input.findings, input.changedFiles);

  if (findings.some((finding) => BLOCKING_SEVERITIES.includes(finding.severity))) {
    return 'fail';
  }

  return reasons.includes('partial-coverage') ? 'manual-review' : 'pass';
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
    /** Defaults to every changed file having been shown. */
    coverage?: DiffCoverage;
  } = {},
): ReviewEvent {
  const changedFiles = options.changedFiles ?? [];

  return reviewEventForGate(
    decideGate({
      findings,
      changedFiles,
      mode,
      protectedPaths: options.protectedPaths,
      reviewCompleted: true,
      coverage: options.coverage ?? {
        totalFiles: changedFiles.length,
        omittedFiles: 0,
        shortenedPatches: 0,
        patchChars: 0,
      },
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
 *
 * A steering finding that names a file outside the diff is not dropped:
 * the attempt can sit in the title or the description, which have no
 * path, and the finding is about that text rather than about a file. It
 * is kept as a general finding, with no file and no line.
 *
 * Steering findings are then merged into one at a fixed, non-blocking
 * severity (see `consolidateSteeringFindings`). Doing it here means the gate,
 * which sanitizes its own input, applies it even if a caller forgets.
 */
export function sanitizeFindings(
  findings: readonly ReviewFinding[],
  changedFiles: readonly ChangedFile[],
): ReviewFinding[] {
  const touched = new Set(allTouchedPaths(changedFiles));
  const linesByPath = new Map<string, Set<number>>();

  for (const file of changedFiles) {
    const lines = hunkLineNumbers(file.patch ?? '');

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
      if (isSteering(finding)) {
        sanitized.push({ ...finding, file: null, line: null });
      }
      continue;
    }

    if (finding.line === null) {
      sanitized.push(finding);
      continue;
    }

    const validLines = linesByPath.get(finding.file);

    sanitized.push(validLines?.has(finding.line) === true ? finding : { ...finding, line: null });
  }

  return consolidateSteeringFindings(sanitized);
}
