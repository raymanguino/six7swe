/**
 * The numbers phase 2 is decided on (#59).
 *
 * Every run of the agent writes one stats line to the workflow log. The
 * calibration script reads those lines back from GitHub and tallies them
 * here, in pure code, into the table the phase 2 issue asks for.
 *
 * The stats line carries counts and finding identifiers, never text. A
 * finding message is model output written from attacker-controlled diff
 * content, so it never goes into a line that another program parses. For
 * the same reason a line only counts as a stats line when it starts with
 * the prefix (after the runner's timestamp), and every other line the
 * script logs has the prefix neutralised (`neutralizeStatsPrefix`), so
 * model text cannot forge a run.
 */

import { allTouchedPaths, type ChangedFile } from './diff';
import { FINDING_ID_PATTERN } from './findingId';
import { isKnownPromptVersion } from './promptVersion';
import {
  MANUAL_REVIEW_REASONS,
  SANITIZE_REASONS,
  SEVERITY_ORDER,
  zeroSanitizeCounts,
  type FindingSeverity,
  type GateOutcome,
  type ManualReviewReason,
  type ReviewMode,
  type SanitizeCounts,
} from './verdict';

/** Marks the stats line in the workflow log. */
export const QA_STATS_PREFIX = 'QA_STATS ';

/**
 * Where the prefix may sit in a log line: at the start, after the
 * timestamp the runner adds (and a byte order mark the log may start with).
 */
const STATS_LINE = /^\uFEFF?(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z )?QA_STATS /;

/**
 * Stops text from being read as a stats line.
 *
 * For every line the script logs that is not the stats line itself, since
 * some of them carry model text.
 */
export function neutralizeStatsPrefix(text: string): string {
  return text.replace(/QA_STATS/g, 'QA-STATS');
}

/**
 * The version of the stats line. Bump it when a field changes meaning.
 *
 * Version 2 added the coverage counts. Version 1 lines are still read,
 * with the coverage fields as null, so the runs logged before still count.
 * Version 3 added the sanitizer's counts by reason and the finding ids; a
 * version 1 or 2 line has them as null.
 * Version 4 added `enforceOutcome`, the outcome `enforce` mode would have
 * returned, and `manualReviewReasons`, why that review would need a human;
 * an older line has them as null.
 * Version 5 added `promptVersion`, the version of the review prompt the
 * run used (`REVIEW_PROMPT_VERSION`); an older line has it as null.
 */
export const QA_STATS_VERSION = 5;

/** The tokens one review used. `reasoning` is null when MiniMax does not report it. */
export interface RunTokens {
  prompt: number;
  completion: number;
  reasoning: number | null;
}

/** What one run of the agent did. */
export interface QaRunStats {
  v: 1 | 2 | 3 | 4 | typeof QA_STATS_VERSION;
  pr: number;
  sha: string;
  mode: ReviewMode;
  outcome: GateOutcome;
  /**
   * What `decideGate` would have returned in `enforce` mode, on the same
   * findings, changed files and coverage (`decideEnforceOutcome`). A
   * measurement only: `outcome` decides the exit code and the review
   * event. Null on a line older than version 4.
   */
  enforceOutcome: GateOutcome | null;
  /**
   * Every reason the review needs a human (`manualReviewReasons`), whether
   * or not one decided the gate: the cause of an `enforce` outcome of
   * `manual-review`. Empty when there is none. Null on a line older than
   * version 4, and on a version 4 line only when the review failed closed
   * before the gate was decided.
   */
  manualReviewReasons: ManualReviewReason[] | null;
  /**
   * The version of the review prompt the run used (`REVIEW_PROMPT_VERSION`),
   * so findings are compared per prompt. Null on a line older than version 5.
   */
  promptVersion: number | null;
  files: number;
  backendFiles: number;
  frontendFiles: number;
  diffChars: number;
  /** Files dropped from the diff for budget. Null on a v1 line or when the diff was never built. */
  omittedFiles: number | null;
  /** Files shown with a shortened patch. Null as for `omittedFiles`. */
  shortenedPatches: number | null;
  /**
   * Patch characters before the budget, lockfiles excluded. `diffChars` is
   * capped at the budget; this is not. Null as for `omittedFiles`.
   */
  patchChars: number | null;
  /** How many findings the model returned. Null when the review failed. */
  reported: number | null;
  /** How many findings survived sanitizing, by severity. Null when the review failed. */
  kept: Record<FindingSeverity, number> | null;
  /**
   * What the sanitizer did to the reported findings, by reason. Null when
   * the review failed or on a line older than version 3.
   */
  sanitized: SanitizeCounts | null;
  /**
   * The ids of the kept findings (`findingIds`), in the order the review
   * lists them, each unique within the run. They name a finding in this
   * run only; the commit is part of the hash. Null as for `sanitized`.
   */
  findingIds: string[] | null;
  /** Null when the model call never returned a usage report. */
  tokens: RunTokens | null;
  durationMs: number;
}

/**
 * Counts the changed files on each side of the repository.
 *
 * A file counts once, and a rename counts for the side it came from as
 * well as the side it went to.
 */
export function countAreas(files: readonly ChangedFile[]): {
  backendFiles: number;
  frontendFiles: number;
} {
  const touches = (file: ChangedFile, prefix: string): boolean =>
    allTouchedPaths([file]).some((path) => path.startsWith(prefix));
  return {
    backendFiles: files.filter((file) => touches(file, 'backend/')).length,
    frontendFiles: files.filter((file) => touches(file, 'frontend/')).length,
  };
}

/** Counts findings by severity, with every severity present. */
export function countBySeverity(
  findings: readonly { severity: FindingSeverity }[],
): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function formatStatsLine(stats: Omit<QaRunStats, 'v'>): string {
  return `${QA_STATS_PREFIX}${JSON.stringify({ v: QA_STATS_VERSION, ...stats })}`;
}

const GATE_OUTCOMES: readonly GateOutcome[] = ['pass', 'fail', 'manual-review', 'fail-closed'];

function isGateOutcome(value: unknown): value is GateOutcome {
  return GATE_OUTCOMES.some((outcome) => outcome === value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSeverityCounts(value: unknown): value is Record<FindingSeverity, number> {
  return isRecord(value) && SEVERITY_ORDER.every((severity) => isCount(value[severity]));
}

function isTokens(value: unknown): value is RunTokens {
  return (
    isRecord(value) &&
    isCount(value.prompt) &&
    isCount(value.completion) &&
    (value.reasoning === null || isCount(value.reasoning))
  );
}

function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value);
}

const COVERAGE_FIELDS = ['omittedFiles', 'shortenedPatches', 'patchChars'] as const;

/**
 * The fields each version of the line added, oldest first.
 *
 * A line older than `since` must not carry them, and they are filled in as
 * null; a line from `since` on must carry them. Bump `QA_STATS_VERSION` and
 * add a row here when the line gains a field.
 */
const FIELDS_ADDED_IN: readonly { since: QaRunStats['v']; fields: readonly string[] }[] = [
  { since: 2, fields: COVERAGE_FIELDS },
  { since: 3, fields: ['sanitized', 'findingIds'] },
  { since: 4, fields: ['enforceOutcome', 'manualReviewReasons'] },
  { since: 5, fields: ['promptVersion'] },
];

const STATS_VERSIONS: readonly QaRunStats['v'][] = [1, 2, 3, 4, QA_STATS_VERSION];

function isStatsVersion(value: unknown): value is QaRunStats['v'] {
  return STATS_VERSIONS.some((version) => version === value);
}

/**
 * A full commit sha. The script logs the head sha GitHub reports, which is
 * always 40 hex characters; anything else is not a line the script wrote.
 */
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function isManualReviewReason(value: unknown): value is ManualReviewReason {
  return MANUAL_REVIEW_REASONS.some((reason) => reason === value);
}

/** A list of known reasons, each at most once. */
function isReasonList(value: unknown): value is ManualReviewReason[] {
  return (
    Array.isArray(value) &&
    value.every(isManualReviewReason) &&
    new Set(value).size === value.length
  );
}

/**
 * The version 4 fields: the enforce outcome is always present, and the
 * reasons are present unless the review failed closed before the gate was
 * decided. An older line has both as null (filled in by the upgrade).
 */
function hasValidEnforceFields(value: Record<string, unknown>): boolean {
  if (typeof value.v !== 'number' || value.v < 4) {
    return value.enforceOutcome === null && value.manualReviewReasons === null;
  }
  return (
    isGateOutcome(value.enforceOutcome) &&
    (isReasonList(value.manualReviewReasons) ||
      (value.manualReviewReasons === null && value.enforceOutcome === 'fail-closed'))
  );
}

/**
 * The version 5 field: a positive version number. An older line has it as
 * null (filled in by the upgrade).
 *
 * A version this checkout's history does not know is still accepted: it is
 * what a newer prompt logs, and a checkout that has not caught up must not
 * drop those runs. The report counts them instead
 * (`withUnknownPromptVersion`).
 */
function hasValidPromptVersion(value: Record<string, unknown>): boolean {
  if (typeof value.v !== 'number' || value.v < 5) return value.promptVersion === null;
  return isCount(value.promptVersion) && value.promptVersion > 0;
}

function isSanitizeCounts(value: unknown): value is SanitizeCounts {
  return isRecord(value) && SANITIZE_REASONS.every((reason) => isCount(value[reason]));
}

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === 'string' && FINDING_ID_PATTERN.test(id))
  );
}

/**
 * Reads a parsed line into stats, or null when it has the wrong shape.
 *
 * An older line lacks the fields added since; they are filled in as null
 * rather than the line being dropped.
 */
function toRunStats(value: unknown): QaRunStats | null {
  if (!isRecord(value)) return null;

  const version = value.v;
  if (!isStatsVersion(version)) return null;

  const upgraded: Record<string, unknown> = { ...value };
  for (const { since, fields } of FIELDS_ADDED_IN) {
    if (version >= since) continue;
    if (fields.some((field) => field in value)) return null;
    for (const field of fields) upgraded[field] = null;
  }

  if (!isRunStats(upgraded)) return null;
  // One commit, one key: the sha is compared, so it is compared in one case.
  return { ...upgraded, sha: upgraded.sha.toLowerCase() };
}

function isRunStats(value: Record<string, unknown>): value is Record<string, unknown> & QaRunStats {
  return (
    isStatsVersion(value.v) &&
    isCount(value.pr) &&
    typeof value.sha === 'string' &&
    SHA_PATTERN.test(value.sha) &&
    (value.mode === 'comment-only' || value.mode === 'enforce') &&
    isGateOutcome(value.outcome) &&
    hasValidEnforceFields(value) &&
    hasValidPromptVersion(value) &&
    isCount(value.files) &&
    isCount(value.backendFiles) &&
    isCount(value.frontendFiles) &&
    isCount(value.diffChars) &&
    COVERAGE_FIELDS.every((field) => isCountOrNull(value[field])) &&
    (value.reported === null || isCount(value.reported)) &&
    (value.kept === null || isSeverityCounts(value.kept)) &&
    (value.sanitized === null || isSanitizeCounts(value.sanitized)) &&
    (value.findingIds === null || isIdList(value.findingIds)) &&
    (value.tokens === null || isTokens(value.tokens)) &&
    isCount(value.durationMs)
  );
}

/**
 * Reads the stats lines out of a workflow job log.
 *
 * The runner prefixes every line with a timestamp, so the prefix is looked
 * for anywhere in the line. A line that does not parse, or parses into
 * something of the wrong shape, is skipped rather than guessed at.
 */
export function parseStatsLines(log: string): QaRunStats[] {
  const stats: QaRunStats[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = STATS_LINE.exec(line);
    if (!match) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(match[0].length));
      const run = toRunStats(parsed);
      if (run) stats.push(run);
    } catch {
      // Not a stats line after all.
    }
  }
  return stats;
}

/** The thresholds from #59 that can be counted. */
export const CALIBRATION_TARGETS = { prs: 20, backendPrs: 5, frontendPrs: 5 } as const;

interface Spread {
  average: number;
  max: number;
}

interface Distribution {
  median: number;
  p90: number;
  max: number;
}

/** One commit, as the calibration report names it. */
export interface CommitRef {
  pr: number;
  sha: string;
}

/** An `enforce` outcome that is a verdict: the review completed. */
export type EnforceVerdict = Exclude<GateOutcome, 'fail-closed'>;

/**
 * Why a commit would have been blocked.
 *
 * `fail` is a blocking finding. For `manual-review` the line records the
 * reasons (`manualReviewReasons`), and the cause is the one `decideGate`
 * checks first: a protected path, then partial coverage.
 *
 * `protected-path-or-partial-coverage` and `not-recorded` are only for a
 * line without the reasons. There the cause is inferred from the order of
 * the rules: with no omitted file it can only be a protected path; with
 * omitted files it may be either.
 */
export type BlockCause =
  | 'blocking-finding'
  | 'protected-path'
  | 'partial-coverage'
  | 'protected-path-or-partial-coverage'
  | 'not-recorded';

/** A commit that would have turned the check red in `enforce` mode. */
export interface WouldBlock extends CommitRef {
  enforceOutcome: Exclude<EnforceVerdict, 'pass'>;
  cause: BlockCause;
  kept: Record<FindingSeverity, number> | null;
}

/**
 * A commit that was reviewed more than once, with no code change between
 * the runs, so any difference between them is the agent's own variance.
 */
export interface RereviewedCommit extends CommitRef {
  runs: number;
  /**
   * The `enforce` outcome of each run that recorded one, in run order.
   * Runs that failed closed are left out: they reached no verdict.
   */
  enforceOutcomes: EnforceVerdict[];
  /** Null when fewer than two runs recorded an `enforce` outcome. */
  outcomeChanged: boolean | null;
  /** The kept findings by severity of each completed run, in run order. */
  kept: Record<FindingSeverity, number>[];
  /** Null when fewer than two runs completed. */
  findingsChanged: boolean | null;
}

export interface CalibrationSummary {
  prs: number;
  backendPrs: number;
  frontendPrs: number;
  /** Distinct commits reviewed, the latest run of each. */
  commits: number;
  /** The modes the latest runs ran in, in the order first seen. */
  modes: ReviewMode[];
  outcomes: Record<GateOutcome, number>;
  /**
   * What the gate would have returned in `enforce` mode, one per commit,
   * from the commit's latest run that reached a verdict (or its latest run
   * when none did). See `tallyEnforce`.
   */
  enforceOutcomes: Record<GateOutcome, number>;
  /** Commits with no `enforce` outcome on record (logged before version 4). */
  withoutEnforceOutcome: number;
  /**
   * Commits with an `enforce` verdict: the denominator of the block rate.
   * A commit whose every run failed closed is left out; it is reported
   * with the real outcomes.
   */
  enforceDecided: number;
  /** The commits that would have been blocked, so each block can be judged by hand. */
  wouldBlock: WouldBlock[];
  /** The commits reviewed more than once, in the order first reviewed. */
  rereviewed: RereviewedCommit[];
  /** Findings the model returned, across the completed reviews. */
  reported: number;
  /** Findings that survived sanitizing, by severity. */
  kept: Record<FindingSeverity, number>;
  /**
   * What the sanitizer did, by reason, across the reviews that logged it
   * (version 3 lines that completed).
   */
  sanitized: SanitizeCounts | null;
  /** Completed reviews whose line has no sanitizer counts (logged before version 3). */
  withoutSanitizeCounts: number;
  durationMs: Spread | null;
  promptTokens: Spread | null;
  completionTokens: Spread | null;
  reasoningTokens: Spread | null;
  /** Completed reviews that reported no token usage. */
  withoutTokens: number;
  /** Commits whose latest run logged a prompt version this checkout does not know. */
  withUnknownPromptVersion: number;
  /** Reviews whose stats carry coverage (version 2 lines with a built diff). */
  withCoverage: number;
  /** Of those, the reviews that left files out. */
  withOmittedFiles: number;
  /** Files left out per review, across the reviews that carry coverage. */
  omittedFiles: Spread | null;
  /** Reviewable size (`patchChars`) per review. */
  patchChars: Distribution | null;
}

function zeroOutcomes(): Record<GateOutcome, number> {
  return { pass: 0, fail: 0, 'manual-review': 0, 'fail-closed': 0 };
}

function sameSeverityCounts(
  left: Record<FindingSeverity, number>,
  right: Record<FindingSeverity, number>,
): boolean {
  return SEVERITY_ORDER.every((severity) => left[severity] === right[severity]);
}

/** Whether a list of at least two values holds more than one value; null below two. */
function changed<T>(values: readonly T[], same: (left: T, right: T) => boolean): boolean | null {
  if (values.length < 2) return null;
  return values.some((value) => !same(value, values[0]));
}

/**
 * Compares the runs of each commit reviewed more than once.
 *
 * Two runs of one commit see the same code, so a different `enforce`
 * outcome between them is a flip: the agent's own variance, which #59
 * asks to be tracked before the agent may block. The findings are
 * compared by count per severity, which every version of the line carries.
 */
function rereviewedCommits(
  byCommit: ReadonlyMap<string, readonly QaRunStats[]>,
): RereviewedCommit[] {
  const rereviewed: RereviewedCommit[] = [];

  for (const runs of byCommit.values()) {
    if (runs.length < 2) continue;

    const enforceOutcomes = runs.map((run) => run.enforceOutcome).filter(isEnforceVerdict);
    const kept = runs
      .map((run) => run.kept)
      .filter((counts): counts is Record<FindingSeverity, number> => counts !== null);

    rereviewed.push({
      pr: runs[0].pr,
      sha: runs[0].sha,
      runs: runs.length,
      enforceOutcomes,
      outcomeChanged: changed(enforceOutcomes, (left, right) => left === right),
      kept,
      findingsChanged: changed(kept, sameSeverityCounts),
    });
  }

  return rereviewed;
}

function isEnforceVerdict(outcome: GateOutcome | null): outcome is EnforceVerdict {
  return outcome !== null && outcome !== 'fail-closed';
}

function blockCause(run: QaRunStats, outcome: Exclude<EnforceVerdict, 'pass'>): BlockCause {
  if (outcome === 'fail') return 'blocking-finding';
  if (run.manualReviewReasons !== null) {
    // decideGate checks the protected path first.
    if (run.manualReviewReasons.includes('protected-path')) return 'protected-path';
    if (run.manualReviewReasons.includes('partial-coverage')) return 'partial-coverage';
  }
  // Inferred: a line without the reasons, or reasons that do not explain
  // the outcome (which the script never writes).
  if (run.omittedFiles === null) return 'not-recorded';
  return run.omittedFiles === 0 ? 'protected-path' : 'protected-path-or-partial-coverage';
}

type EnforceTally = Pick<
  CalibrationSummary,
  'enforceOutcomes' | 'withoutEnforceOutcome' | 'enforceDecided' | 'wouldBlock'
>;

/**
 * Tallies the `enforce` outcomes, one per commit.
 *
 * Each commit counts by its latest run that reached a verdict, and by its
 * latest run only when none did. A re-run that failed closed - an API
 * error, a timeout - says nothing about the code, so it must not erase an
 * earlier run's block and pull the block rate down.
 */
function tallyEnforce(byCommit: ReadonlyMap<string, readonly QaRunStats[]>): EnforceTally {
  const enforceOutcomes = zeroOutcomes();
  let withoutEnforceOutcome = 0;
  let enforceDecided = 0;
  const wouldBlock: WouldBlock[] = [];

  for (const runs of byCommit.values()) {
    const run =
      [...runs].reverse().find((candidate) => isEnforceVerdict(candidate.enforceOutcome)) ??
      runs[runs.length - 1];
    const outcome = run.enforceOutcome;

    if (outcome === null) {
      withoutEnforceOutcome += 1;
      continue;
    }
    enforceOutcomes[outcome] += 1;
    if (!isEnforceVerdict(outcome)) continue;

    enforceDecided += 1;
    if (outcome !== 'pass') {
      wouldBlock.push({
        pr: run.pr,
        sha: run.sha,
        enforceOutcome: outcome,
        cause: blockCause(run, outcome),
        kept: run.kept,
      });
    }
  }

  return { enforceOutcomes, withoutEnforceOutcome, enforceDecided, wouldBlock };
}

function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { average: Math.round(total / values.length), max: Math.max(...values) };
}

/**
 * Tallies the runs.
 *
 * The input is in run order, oldest first. A commit that was reviewed more
 * than once (a re-run) counts once, by its latest run, so a re-run does not
 * double its findings. The `enforce` rows are the exception: they count a
 * commit by its latest run that reached a verdict (see `tallyEnforce`).
 * Different commits on the same pull request each
 * count: a finding raised on one push and fixed by the next is exactly the
 * kind of finding calibration is about.
 */
export function summarizeCalibration(runs: readonly QaRunStats[]): CalibrationSummary {
  const byCommit = new Map<string, QaRunStats[]>();
  for (const run of runs) {
    const key = `${run.pr}@${run.sha}`;
    byCommit.set(key, [...(byCommit.get(key) ?? []), run]);
  }
  const commits = [...byCommit.values()].map((commitRuns) => commitRuns[commitRuns.length - 1]);

  const prs = new Set<number>();
  const backendPrs = new Set<number>();
  const frontendPrs = new Set<number>();
  const modes: ReviewMode[] = [];
  const outcomes = zeroOutcomes();
  const kept: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  let reported = 0;
  const sanitized = zeroSanitizeCounts();
  let withSanitizeCounts = 0;
  let withoutSanitizeCounts = 0;
  let withoutTokens = 0;
  const promptTokens: number[] = [];
  const completionTokens: number[] = [];
  const reasoningTokens: number[] = [];
  const omittedFiles: number[] = [];
  const patchChars: number[] = [];

  for (const run of commits) {
    prs.add(run.pr);
    if (run.backendFiles > 0) backendPrs.add(run.pr);
    if (run.frontendFiles > 0) frontendPrs.add(run.pr);
    if (!modes.includes(run.mode)) modes.push(run.mode);
    outcomes[run.outcome] += 1;

    if (run.reported !== null && run.kept !== null) {
      reported += run.reported;
      for (const severity of SEVERITY_ORDER) {
        kept[severity] += run.kept[severity];
      }
      if (run.sanitized) {
        withSanitizeCounts += 1;
        for (const reason of SANITIZE_REASONS) sanitized[reason] += run.sanitized[reason];
      } else {
        withoutSanitizeCounts += 1;
      }
    }

    if (run.tokens) {
      promptTokens.push(run.tokens.prompt);
      completionTokens.push(run.tokens.completion);
      if (run.tokens.reasoning !== null) reasoningTokens.push(run.tokens.reasoning);
    } else if (run.outcome !== 'fail-closed') {
      withoutTokens += 1;
    }

    if (run.omittedFiles !== null) omittedFiles.push(run.omittedFiles);
    if (run.patchChars !== null) patchChars.push(run.patchChars);
  }

  return {
    prs: prs.size,
    backendPrs: backendPrs.size,
    frontendPrs: frontendPrs.size,
    commits: commits.length,
    modes,
    outcomes,
    ...tallyEnforce(byCommit),
    rereviewed: rereviewedCommits(byCommit),
    reported,
    kept,
    sanitized: withSanitizeCounts > 0 ? sanitized : null,
    withoutSanitizeCounts,
    durationMs: spread(commits.map((run) => run.durationMs)),
    promptTokens: spread(promptTokens),
    completionTokens: spread(completionTokens),
    reasoningTokens: spread(reasoningTokens),
    withoutTokens,
    withUnknownPromptVersion: commits.filter(
      (run) => run.promptVersion !== null && !isKnownPromptVersion(run.promptVersion),
    ).length,
    withCoverage: omittedFiles.length,
    withOmittedFiles: omittedFiles.filter((n) => n > 0).length,
    omittedFiles: spread(omittedFiles),
    patchChars: distribution(patchChars),
  };
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
}

function target(actual: number, wanted: number): string {
  return `${actual} / ${wanted} ${actual >= wanted ? '✅' : '❌'}`;
}

function formatSpread(value: Spread | null, unit: (n: number) => string): string {
  return value ? `${unit(value.average)} average, ${unit(value.max)} max` : 'no data';
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const tokens = (n: number): string => `${n.toLocaleString('en-US')} tokens`;
const chars = (n: number): string => n.toLocaleString('en-US');
const files = (n: number): string => `${n} file(s)`;

/** One sanitizer count, or "no data" when no review logged them. */
function reasonCount(
  summary: CalibrationSummary,
  reason: (typeof SANITIZE_REASONS)[number],
): string {
  return summary.sanitized ? String(summary.sanitized[reason]) : 'no data';
}

/** A share as a percentage to one decimal place, or nothing when there is no denominator. */
function share(part: number, whole: number): string {
  return whole > 0 ? ` (${((part / whole) * 100).toFixed(1)}%)` : '';
}

function ofCount(part: number, whole: number): string {
  return whole > 0 ? `${part} of ${whole}${share(part, whole)}` : 'no data';
}

/**
 * A commit as the report names it. The sha is read from a log line, so
 * only a hex sha is printed, shortened; anything else is not echoed into
 * Markdown that is pasted into an issue.
 */
function commitLabel(commit: CommitRef): string {
  // Defence in depth, on purpose: parseStatsLines already rejects a sha that
  // is not 40 hex characters, but the summary can be built from stats that
  // never went through it, and a sha is never echoed into Markdown unchecked.
  const sha = SHA_PATTERN.test(commit.sha) ? `\`${commit.sha.slice(0, 7)}\`` : '(unreadable sha)';
  return `#${commit.pr} ${sha}`;
}

function formatKept(kept: Record<FindingSeverity, number>): string {
  const present = SEVERITY_ORDER.filter((severity) => kept[severity] > 0);
  return present.length > 0
    ? present.map((severity) => `${kept[severity]} ${severity}`).join(', ')
    : 'none';
}

const CAUSE_LABELS: Record<BlockCause, string> = {
  'blocking-finding': 'blocking finding',
  'protected-path': 'protected path',
  'partial-coverage': 'partial coverage',
  'protected-path-or-partial-coverage': 'protected path or partial coverage',
  'not-recorded': 'reason not recorded',
};

/** The block rate, then how many blocks each outcome accounts for. */
function blockRate(summary: CalibrationSummary): string {
  const rate = ofCount(summary.wouldBlock.length, summary.enforceDecided);
  if (summary.enforceDecided === 0) return rate;
  const count = (outcome: WouldBlock['enforceOutcome']): number =>
    summary.wouldBlock.filter((commit) => commit.enforceOutcome === outcome).length;
  return `${rate}: ${count('fail')} fail, ${count('manual-review')} manual-review`;
}

/** How many re-reviewed commits changed between runs, of those that can be compared. */
function changedRow(
  commits: readonly RereviewedCommit[],
  key: 'outcomeChanged' | 'findingsChanged',
): string {
  return ofCount(
    commits.filter((commit) => commit[key] === true).length,
    commits.filter((commit) => commit[key] !== null).length,
  );
}

function formatChange(changedValue: boolean | null): string {
  if (changedValue === null) return 'not comparable';
  return changedValue ? 'changed' : 'same';
}

function outcomeCounts(outcomes: Record<GateOutcome, number>): string {
  return GATE_OUTCOMES.map((o) => `${outcomes[o]} ${o}`).join(', ');
}

/** The label of the real outcome row: the mode the runs ran in. */
function modeLabel(modes: readonly ReviewMode[]): string {
  return modes.length === 1 ? modes[0] : 'as run';
}

function formatDistribution(value: Distribution | null, budget: number): string {
  return value
    ? `${chars(value.median)} median, ${chars(value.p90)} p90, ${chars(value.max)} max (budget ${chars(budget)})`
    : 'no data';
}

export interface ReportContext {
  /** Runs found, whatever they logged. */
  runs: number;
  /** Runs whose log had no stats line: they predate it, or the job never ran. */
  runsWithoutStats: number;
  /** Runs whose log GitHub no longer has. */
  runsWithExpiredLogs: number;
  /** The diff budget (`totalChars`) the reviewable size is compared against. */
  diffBudgetChars: number;
}

/**
 * Renders the summary as Markdown, ready to paste into #59.
 *
 * Only the countable criteria are here. Whether a finding was a real
 * defect is a human judgement, and it is tracked by hand on the issue.
 */
export function renderCalibrationReport(
  summary: CalibrationSummary,
  context: ReportContext,
): string {
  const keptTotal = SEVERITY_ORDER.reduce((sum, severity) => sum + summary.kept[severity], 0);

  const lines = [
    '## QA agent calibration',
    '',
    '| Criterion | Value |',
    '|---|---|',
    `| Pull requests reviewed | ${target(summary.prs, CALIBRATION_TARGETS.prs)} |`,
    `| ... touching the backend | ${target(summary.backendPrs, CALIBRATION_TARGETS.backendPrs)} |`,
    `| ... touching the frontend | ${target(summary.frontendPrs, CALIBRATION_TARGETS.frontendPrs)} |`,
    `| Commits reviewed | ${summary.commits} |`,
    `| Findings returned by the model | ${summary.reported} |`,
    `| Findings posted | ${keptTotal} (${SEVERITY_ORDER.map((s) => `${summary.kept[s]} ${s}`).join(', ')}) |`,
    `| Dropped: file not in the pull request | ${reasonCount(summary, 'outsidePr')} |`,
    `| Dropped: file in the pull request but not shown to the model | ${reasonCount(summary, 'notShown')} |`,
    `| Merged: steering findings folded into one | ${reasonCount(summary, 'steeringMerged')} |`,
    `| Kept, line number removed (line not shown to the model) | ${reasonCount(summary, 'lineCorrected')} |`,
    `| Gate outcomes (${modeLabel(summary.modes)}) | ${outcomeCounts(summary.outcomes)} |`,
    `| Gate outcomes (if enforced) | ${summary.commits - summary.withoutEnforceOutcome > 0 ? outcomeCounts(summary.enforceOutcomes) : 'no data'} |`,
    `| Would have blocked if enforced | ${blockRate(summary)} |`,
    `| Commits reviewed more than once | ${summary.rereviewed.length} |`,
    `| ... outcome if enforced changed between runs | ${changedRow(summary.rereviewed, 'outcomeChanged')} |`,
    `| ... findings changed between runs (count by severity) | ${changedRow(summary.rereviewed, 'findingsChanged')} |`,
    `| Runtime | ${formatSpread(summary.durationMs, seconds)} |`,
    `| Prompt tokens | ${formatSpread(summary.promptTokens, tokens)} |`,
    `| Completion tokens | ${formatSpread(summary.completionTokens, tokens)} |`,
    `| ... of which reasoning | ${formatSpread(summary.reasoningTokens, tokens)} |`,
    `| Reviews with omitted files | ${summary.withOmittedFiles} of ${summary.withCoverage} |`,
    `| Omitted files per review | ${formatSpread(summary.omittedFiles, files)} |`,
    `| Reviewable size (patch characters) | ${formatDistribution(summary.patchChars, context.diffBudgetChars)} |`,
    '',
    `Counted from ${context.runs - context.runsWithoutStats - context.runsWithExpiredLogs} of ${context.runs} workflow run(s). A commit reviewed more than once counts once, by its latest run; the rows about enforce mode use its latest run that reached a verdict, so a re-run that failed closed does not hide an earlier block.`,
  ];

  if (context.runsWithoutStats > 0) {
    lines.push(
      `${context.runsWithoutStats} run(s) logged no stats: they predate the stats line, or the job did not run.`,
    );
  }
  if (context.runsWithExpiredLogs > 0) {
    lines.push(
      `${context.runsWithExpiredLogs} run(s) are no longer countable: GitHub has deleted their logs.`,
    );
  }
  if (summary.withoutSanitizeCounts > 0) {
    lines.push(
      `${summary.withoutSanitizeCounts} completed review(s) logged no sanitizer counts (they predate version 3 of the stats line), so the rows above undercount.`,
    );
  }
  if (summary.withUnknownPromptVersion > 0) {
    lines.push(
      `${summary.withUnknownPromptVersion} review(s) used a prompt version unknown to this checkout: update it before reading the numbers per prompt.`,
    );
  }
  if (summary.withoutTokens > 0) {
    lines.push(`${summary.withoutTokens} completed review(s) reported no token usage.`);
  }
  if (summary.withCoverage < summary.commits) {
    lines.push(
      `${summary.commits - summary.withCoverage} review(s) carry no coverage counts: they predate them, or failed before the diff was built.`,
    );
  }
  if (summary.outcomes['fail-closed'] > 0) {
    lines.push(
      `${summary.outcomes['fail-closed']} review(s) failed closed; their findings, if any, are not counted.`,
    );
  }
  if (summary.withoutEnforceOutcome > 0) {
    lines.push(
      `${summary.withoutEnforceOutcome} review(s) recorded no outcome if enforced (they predate version 4 of the stats line), so the enforce rows undercount.`,
    );
  }

  if (summary.wouldBlock.length > 0) {
    lines.push(
      '',
      '### Would have blocked if enforced',
      '',
      'Whether each block was a real defect is judged by hand in the verdict table on #59. Read the two together: the block rate above is only as good as the share of these that were real.',
      '',
      ...summary.wouldBlock.map(
        (commit) =>
          `- ${commitLabel(commit)}: ${commit.enforceOutcome} (${CAUSE_LABELS[commit.cause]}), findings ${commit.kept ? formatKept(commit.kept) : 'not recorded'}`,
      ),
    );
  }

  if (summary.rereviewed.length > 0) {
    lines.push(
      '',
      '### Commits reviewed more than once',
      '',
      "The runs of one commit saw the same code, so a difference between them is the agent's own variance. Runs that failed closed are not compared.",
      '',
      ...summary.rereviewed.map(
        (commit) =>
          `- ${commitLabel(commit)}: ${commit.runs} runs; if enforced ${commit.enforceOutcomes.join(' -> ') || 'not recorded'} (${formatChange(commit.outcomeChanged)}); findings ${commit.kept.map(formatKept).join(' -> ') || 'not recorded'} (${formatChange(commit.findingsChanged)})`,
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}
