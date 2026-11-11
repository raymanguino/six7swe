/**
 * The numbers phase 2 is decided on (#59).
 *
 * Every run of the agent writes one stats line to the workflow log. The
 * calibration script reads those lines back from GitHub and tallies them
 * here, in pure code, into the table the phase 2 issue asks for.
 *
 * The stats line carries counts only. A finding message is model output
 * written from attacker-controlled diff content, so it never goes into a
 * line that another program parses.
 */

import { allTouchedPaths, type ChangedFile } from './diff';
import { SEVERITY_ORDER, type FindingSeverity, type GateOutcome, type ReviewMode } from './verdict';

/** Marks the stats line in the workflow log. */
export const QA_STATS_PREFIX = 'QA_STATS ';

/** The version of the stats line. Bump it when a field changes meaning. */
const STATS_VERSION = 1;

/** The tokens one review used. `reasoning` is null when MiniMax does not report it. */
export interface RunTokens {
  prompt: number;
  completion: number;
  reasoning: number | null;
}

/** What one run of the agent did. */
export interface QaRunStats {
  v: typeof STATS_VERSION;
  pr: number;
  sha: string;
  mode: ReviewMode;
  outcome: GateOutcome;
  files: number;
  backendFiles: number;
  frontendFiles: number;
  diffChars: number;
  /** How many findings the model returned. Null when the review failed. */
  reported: number | null;
  /** How many findings survived sanitizing, by severity. Null when the review failed. */
  kept: Record<FindingSeverity, number> | null;
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
  return `${QA_STATS_PREFIX}${JSON.stringify({ v: STATS_VERSION, ...stats })}`;
}

const GATE_OUTCOMES: readonly GateOutcome[] = ['pass', 'fail', 'manual-review', 'fail-closed'];

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

function isRunStats(value: unknown): value is QaRunStats {
  return (
    isRecord(value) &&
    value.v === STATS_VERSION &&
    isCount(value.pr) &&
    typeof value.sha === 'string' &&
    (value.mode === 'comment-only' || value.mode === 'enforce') &&
    GATE_OUTCOMES.includes(value.outcome as GateOutcome) &&
    isCount(value.files) &&
    isCount(value.backendFiles) &&
    isCount(value.frontendFiles) &&
    isCount(value.diffChars) &&
    (value.reported === null || isCount(value.reported)) &&
    (value.kept === null || isSeverityCounts(value.kept)) &&
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
    const at = line.indexOf(QA_STATS_PREFIX);
    if (at < 0) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(at + QA_STATS_PREFIX.length));
      if (isRunStats(parsed)) stats.push(parsed);
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

export interface CalibrationSummary {
  prs: number;
  backendPrs: number;
  frontendPrs: number;
  /** Distinct commits reviewed, the latest run of each. */
  commits: number;
  outcomes: Record<GateOutcome, number>;
  /** Findings the model returned, across the completed reviews. */
  reported: number;
  /** Findings that survived sanitizing, by severity. */
  kept: Record<FindingSeverity, number>;
  /** Findings dropped by the sanitizer: pointed at a file or line not in the diff. */
  dropped: number;
  durationMs: Spread | null;
  completionTokens: Spread | null;
  reasoningTokens: Spread | null;
  /** Completed reviews that reported no token usage. */
  withoutTokens: number;
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
 * double its findings. Different commits on the same pull request each
 * count: a finding raised on one push and fixed by the next is exactly the
 * kind of finding calibration is about.
 */
export function summarizeCalibration(runs: readonly QaRunStats[]): CalibrationSummary {
  const latest = new Map<string, QaRunStats>();
  for (const run of runs) latest.set(`${run.pr}@${run.sha}`, run);
  const commits = [...latest.values()];

  const prs = new Set<number>();
  const backendPrs = new Set<number>();
  const frontendPrs = new Set<number>();
  const outcomes: Record<GateOutcome, number> = {
    pass: 0,
    fail: 0,
    'manual-review': 0,
    'fail-closed': 0,
  };
  const kept: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  let reported = 0;
  let keptTotal = 0;
  let withoutTokens = 0;
  const completionTokens: number[] = [];
  const reasoningTokens: number[] = [];

  for (const run of commits) {
    prs.add(run.pr);
    if (run.backendFiles > 0) backendPrs.add(run.pr);
    if (run.frontendFiles > 0) frontendPrs.add(run.pr);
    outcomes[run.outcome] += 1;

    if (run.reported !== null && run.kept !== null) {
      reported += run.reported;
      for (const severity of SEVERITY_ORDER) {
        kept[severity] += run.kept[severity];
        keptTotal += run.kept[severity];
      }
    }

    if (run.tokens) {
      completionTokens.push(run.tokens.completion);
      if (run.tokens.reasoning !== null) reasoningTokens.push(run.tokens.reasoning);
    } else if (run.outcome !== 'fail-closed') {
      withoutTokens += 1;
    }
  }

  return {
    prs: prs.size,
    backendPrs: backendPrs.size,
    frontendPrs: frontendPrs.size,
    commits: commits.length,
    outcomes,
    reported,
    kept,
    dropped: reported - keptTotal,
    durationMs: spread(commits.map((run) => run.durationMs)),
    completionTokens: spread(completionTokens),
    reasoningTokens: spread(reasoningTokens),
    withoutTokens,
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

export interface ReportContext {
  /** Runs found, whatever they logged. */
  runs: number;
  /** Runs whose log had no stats line: they predate it, or the job never ran. */
  runsWithoutStats: number;
  /** Runs whose log GitHub no longer has. */
  runsWithExpiredLogs: number;
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
    `| Findings dropped for pointing outside the diff | ${summary.dropped} |`,
    `| Gate outcomes | ${GATE_OUTCOMES.map((o) => `${summary.outcomes[o]} ${o}`).join(', ')} |`,
    `| Runtime | ${formatSpread(summary.durationMs, seconds)} |`,
    `| Completion tokens | ${formatSpread(summary.completionTokens, tokens)} |`,
    `| ... of which reasoning | ${formatSpread(summary.reasoningTokens, tokens)} |`,
    '',
    `Counted from ${context.runs - context.runsWithoutStats - context.runsWithExpiredLogs} of ${context.runs} workflow run(s). A commit reviewed more than once counts once, by its latest run.`,
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
  if (summary.withoutTokens > 0) {
    lines.push(`${summary.withoutTokens} completed review(s) reported no token usage.`);
  }
  if (summary.outcomes['fail-closed'] > 0) {
    lines.push(
      `${summary.outcomes['fail-closed']} review(s) failed closed; their findings, if any, are not counted.`,
    );
  }

  return `${lines.join('\n')}\n`;
}
