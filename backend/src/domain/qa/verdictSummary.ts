/**
 * Tallies the verdict file (#146): precision, usefulness, misses against
 * the ground truth, and the reconciliation with the run data.
 */

import type { QaRunStats } from './calibration';
import { SEVERITY_ORDER, type FindingSeverity } from './verdict';
import {
  isDefectFinding,
  resolvedVerdict,
  type FindingVerdict,
  type VerdictFile,
} from './verdictSchema';

/** Precision over blocker/major findings: real of judged, unsure excluded. */
export interface Precision {
  real: number;
  falsePositive: number;
  unsure: number;
}

export interface Usefulness {
  useful: number;
  noise: number;
  unsure: number;
}

/** How the file lines up with the run data. Null fields mean no run data was loaded. */
export interface Reconciliation {
  /** Findings posted, as `qa:calibration` counts them: the latest run of each commit. */
  posted: number;
  /** Of those, posted by a run that logged ids. */
  postedWithIds: number;
  /** Of those, posted before the stats line carried ids. */
  postedWithoutIds: number;
  /** Distinct ids logged by any run (every run posts its own review). */
  identified: number;
  /** Of the logged ids, rows with a verdict, own or inherited. */
  identifiedWithVerdict: number;
  /** Of the logged ids, findings with no verdict yet (in the file or not). */
  identifiedUnadjudicated: number;
  /** Of the unadjudicated, ids that have no row in the file yet. */
  notInFile: number;
  /** Rows whose id no loaded run logged: the log expired, or the id is wrong. */
  rowsNotInRunData: number;
  /** Findings judged by hand before ids, matched to a pull request but not to a run. */
  legacyRows: number;
}

/** Ground-truth defects in one group of pull requests. */
export interface DefectTally {
  /** Defects recorded. */
  defects: number;
  /** Defects a finding reported. */
  found: number;
  /** Not reported, in a file the model was shown (or where that is not known). */
  missed: number;
  /** Not reported, in a file the model was not shown: not held against the agent. */
  missedUnseen: number;
}

/**
 * Misses, kept apart by how the pull request's defects were found.
 *
 * Only a pull request read for defects independently of the agent can
 * measure a miss. Elsewhere the list holds only the defects someone
 * noticed, so its misses are a floor; they are tallied separately and
 * never mixed into the measurement.
 */
export interface MissCounts {
  /** Pull requests read independently: the measurement. */
  independentPrs: number[];
  independent: DefectTally;
  /** Pull requests with ground truth that were not read independently. */
  noticedOnlyPrs: number[];
  noticedOnly: DefectTally;
  /** Pull requests with a verdict row but no ground truth. */
  prsWithoutGroundTruth: number[];
}

export interface VerdictSummary {
  /** Rows with an id. */
  rows: number;
  /** Rows with a verdict, own or inherited. */
  rowsWithVerdict: number;
  /** Rows that re-raise an earlier finding. */
  reRaised: number;
  legacyRows: number;
  /** Over every judged posting, identified and legacy. */
  precision: Precision;
  /** Precision per prompt version; the key is the version, or null when not recorded. */
  precisionByPrompt: { promptVersion: number | null; precision: Precision }[];
  usefulness: Usefulness;
  misses: MissCounts;
  reconciliation: Reconciliation | null;
}

interface JudgedPosting {
  severity: FindingSeverity;
  steering: boolean;
  promptVersion: number | null;
  verdict: FindingVerdict;
}

function judgedPostings(file: VerdictFile): JudgedPosting[] {
  const byId = new Map(file.findings.map((row) => [row.findingId, row]));
  const postings: JudgedPosting[] = [];
  for (const row of file.findings) {
    const verdict = resolvedVerdict(row, byId);
    if (verdict !== null) postings.push({ ...row, verdict });
  }
  for (const row of file.legacy) postings.push({ ...row, steering: false });
  return postings;
}

function precisionOf(postings: readonly JudgedPosting[]): Precision {
  const defects = postings.filter(isDefectFinding);
  return {
    real: defects.filter((posting) => posting.verdict === 'real').length,
    falsePositive: defects.filter((posting) => posting.verdict === 'false positive').length,
    unsure: defects.filter((posting) => posting.verdict === 'unsure').length,
  };
}

function usefulnessOf(postings: readonly JudgedPosting[]): Usefulness {
  const quality = postings.filter((posting) => !isDefectFinding(posting));
  return {
    useful: quality.filter((posting) => posting.verdict === 'useful').length,
    noise: quality.filter((posting) => posting.verdict === 'noise').length,
    unsure: quality.filter((posting) => posting.verdict === 'unsure').length,
  };
}

function zeroTally(): DefectTally {
  return { defects: 0, found: 0, missed: 0, missedUnseen: 0 };
}

function countMisses(file: VerdictFile): MissCounts {
  const counts: MissCounts = {
    independentPrs: [],
    independent: zeroTally(),
    noticedOnlyPrs: [],
    noticedOnly: zeroTally(),
    prsWithoutGroundTruth: [],
  };

  for (const entry of [...file.groundTruth].sort((a, b) => a.pr - b.pr)) {
    const tally = entry.readIndependently ? counts.independent : counts.noticedOnly;
    (entry.readIndependently ? counts.independentPrs : counts.noticedOnlyPrs).push(entry.pr);
    for (const defect of entry.defects) {
      tally.defects += 1;
      if (defect.foundBy.length > 0) tally.found += 1;
      else if (defect.shownToModel === false) tally.missedUnseen += 1;
      else tally.missed += 1;
    }
  }

  const withTruth = new Set(file.groundTruth.map((entry) => entry.pr));
  const judged = new Set([...file.findings, ...file.legacy].map((row) => row.pr));
  counts.prsWithoutGroundTruth = [...judged]
    .filter((pr) => !withTruth.has(pr))
    .sort((a, b) => a - b);
  return counts;
}

function totalKept(run: QaRunStats): number {
  return run.kept
    ? SEVERITY_ORDER.reduce((sum, severity) => sum + (run.kept?.[severity] ?? 0), 0)
    : 0;
}

function reconcile(file: VerdictFile, runs: readonly QaRunStats[]): Reconciliation {
  const latest = new Map<string, QaRunStats>();
  for (const run of runs) latest.set(`${run.pr}@${run.sha}`, run);

  let postedWithIds = 0;
  let postedWithoutIds = 0;
  for (const run of latest.values()) {
    if (run.kept === null) continue;
    if (run.findingIds === null) postedWithoutIds += totalKept(run);
    else postedWithIds += totalKept(run);
  }

  const logged = new Set(runs.flatMap((run) => run.findingIds ?? []));
  const byId = new Map(file.findings.map((row) => [row.findingId, row]));
  let identifiedWithVerdict = 0;
  let notInFile = 0;
  for (const id of logged) {
    const row = byId.get(id);
    if (!row) notInFile += 1;
    else if (resolvedVerdict(row, byId) !== null) identifiedWithVerdict += 1;
  }

  return {
    posted: postedWithIds + postedWithoutIds,
    postedWithIds,
    postedWithoutIds,
    identified: logged.size,
    identifiedWithVerdict,
    identifiedUnadjudicated: logged.size - identifiedWithVerdict,
    notInFile,
    rowsNotInRunData: file.findings.filter((row) => !logged.has(row.findingId)).length,
    legacyRows: file.legacy.length,
  };
}

/**
 * Tallies the file, and reconciles it against the run data when it is
 * given (oldest run first). Without run data the counts that need it are
 * null rather than zero, so a missing download is not read as "nothing
 * posted".
 */
export function summarizeVerdicts(
  file: VerdictFile,
  runs: readonly QaRunStats[] | null,
): VerdictSummary {
  const byId = new Map(file.findings.map((row) => [row.findingId, row]));
  const postings = judgedPostings(file);
  const versions = [...new Set(postings.map((posting) => posting.promptVersion))].sort(
    (a, b) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    rows: file.findings.length,
    rowsWithVerdict: file.findings.filter((row) => resolvedVerdict(row, byId) !== null).length,
    reRaised: file.findings.filter((row) => row.sameAs !== null).length,
    legacyRows: file.legacy.length,
    precision: precisionOf(postings),
    precisionByPrompt: versions.map((version) => ({
      promptVersion: version,
      precision: precisionOf(postings.filter((posting) => posting.promptVersion === version)),
    })),
    usefulness: usefulnessOf(postings),
    misses: countMisses(file),
    reconciliation: runs ? reconcile(file, runs) : null,
  };
}
