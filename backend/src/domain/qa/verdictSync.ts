/**
 * Brings the verdict file up to date with the run data (#146): a row for
 * every finding id a run logged, and the machine-filled columns taken from
 * the run. The hand-kept columns are never touched.
 */

import type { QaRunStats } from './calibration';
import type { PostedFinding, PostedReview } from './reviewBody';
import type { RowCoverage, VerdictFile } from './verdictSchema';

/** A review the agent posted on a pull request, read back. */
export interface PullRequestReview extends PostedReview {
  pr: number;
}

/** A logged id whose text is not in any review the agent posted. */
export interface UnrecoverableFinding {
  findingId: string;
  pr: number;
  sha: string;
}

export interface SyncResult {
  file: VerdictFile;
  /** Ids of the rows added, in the order added. */
  added: string[];
  /** Rows whose machine-filled columns changed. */
  updated: string[];
  /**
   * Ids the stats line logged with no matching row in a review body: a
   * finding beyond the body's display limit, or a body that was shortened.
   */
  unrecoverable: UnrecoverableFinding[];
  /**
   * Rows whose pull request or commit differs from the run that logged
   * their id: a mistyped id or row. They are left as they are.
   */
  mismatched: MismatchedRow[];
}

/** A row that does not belong to the run that logged its id. */
export interface MismatchedRow {
  findingId: string;
  row: { pr: number; sha: string };
  run: { pr: number; sha: string };
}

/** The first run that logged each id, in run order. */
function firstRunById(runs: readonly QaRunStats[]): Map<string, QaRunStats> {
  const byId = new Map<string, QaRunStats>();
  for (const run of runs) {
    for (const id of run.findingIds ?? []) {
      if (!byId.has(id)) byId.set(id, run);
    }
  }
  return byId;
}

function runCoverage(run: QaRunStats): RowCoverage | null {
  if (run.omittedFiles === null || run.shortenedPatches === null) return null;
  return {
    files: run.files,
    omittedFiles: run.omittedFiles,
    shortenedPatches: run.shortenedPatches,
  };
}

function sameCoverage(left: RowCoverage | null, right: RowCoverage | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Brings the file up to date with the run data.
 *
 * Every id a run logged gets a row, filled from the review the agent
 * posted for that commit; an id with no such row is reported rather than
 * guessed at. The machine-filled columns (coverage, prompt version) of
 * every row are taken from the first run that logged its id, so they are
 * what the run measured. A value the run did not record (null) never
 * replaces one the row has, and a row whose run is no longer on record
 * keeps what it has: GitHub deletes logs after 90 days, and the file is
 * what keeps the values past that. A row whose pull request or commit is
 * not the run's is reported, not changed. The hand-kept columns are never
 * touched.
 *
 * Runs are in run order, oldest first.
 */
export function syncVerdictFile(
  file: VerdictFile,
  runs: readonly QaRunStats[],
  reviews: readonly PullRequestReview[],
): SyncResult {
  const runById = firstRunById(runs);
  const posted = new Map<string, PostedFinding>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      const run = runById.get(finding.findingId);
      // The text counts only from the review of the commit that logged the id.
      if (run && run.pr === review.pr && run.sha === review.sha && !posted.has(finding.findingId)) {
        posted.set(finding.findingId, finding);
      }
    }
  }

  const updated: string[] = [];
  const mismatched: MismatchedRow[] = [];
  const findings = file.findings.map((row) => {
    const run = runById.get(row.findingId);
    if (!run) return row;
    if (run.pr !== row.pr || run.sha !== row.sha) {
      mismatched.push({
        findingId: row.findingId,
        row: { pr: row.pr, sha: row.sha },
        run: { pr: run.pr, sha: run.sha },
      });
      return row;
    }
    const coverage = runCoverage(run) ?? row.coverage;
    const promptVersion = run.promptVersion ?? row.promptVersion;
    if (sameCoverage(coverage, row.coverage) && promptVersion === row.promptVersion) return row;
    updated.push(row.findingId);
    return { ...row, coverage, promptVersion };
  });

  const known = new Set(findings.map((row) => row.findingId));
  const added: string[] = [];
  const unrecoverable: UnrecoverableFinding[] = [];

  for (const [findingId, run] of runById) {
    if (known.has(findingId)) continue;
    const text = posted.get(findingId);
    if (!text) {
      unrecoverable.push({ findingId, pr: run.pr, sha: run.sha });
      continue;
    }
    findings.push({
      findingId,
      pr: run.pr,
      sha: run.sha,
      severity: text.severity,
      steering: text.steering,
      file: text.file,
      line: text.line,
      message: text.message,
      coverage: runCoverage(run),
      promptVersion: run.promptVersion,
      verdict: null,
      sameAs: null,
      note: '',
    });
    known.add(findingId);
    added.push(findingId);
  }

  return { file: { ...file, findings }, added, updated, unrecoverable, mismatched };
}
