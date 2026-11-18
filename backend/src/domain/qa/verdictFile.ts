/**
 * The QA agent's evaluation verdicts, kept in the repository (#146).
 *
 * A human judges each finding the agent posts (`real`, `false positive`,
 * ...). Those judgements used to live in a hand-edited comment on #59,
 * which had no key joining a row to the run that produced it and no check
 * that it matched the run data. They now live in a versioned JSON file
 * (`backend/qa/verdicts.json`), and this module is everything about that
 * file that needs no I/O:
 *
 * - the schema, validated with Zod, including the checks across rows;
 * - reading a finding table back out of a review body the agent posted, so
 *   the machine-filled columns come from what was posted, not from memory;
 * - merging newly posted findings into the file (`syncVerdictFile`);
 * - rendering the Markdown table that is pasted into #59, reconciled
 *   against the run data (`renderVerdictReport`).
 *
 * ## The key
 *
 * A row is keyed by the run-level finding id (`findingIds`): the hash of
 * the pull request, the commit, and the sanitized finding. The id is copied
 * from the review body, where the agent wrote it, and joined to the stats
 * line, which logs the same ids. It is never recomputed from the row's
 * text, because the body shows the message flattened onto one line and
 * capped in length, so the text there is not always the text that was
 * hashed.
 *
 * Because the commit is part of the hash, the same defect reported again
 * at the next commit gets a new id and a new row. That is deliberate: each
 * posting is a separate run's output, with its own coverage and prompt
 * version, and under `enforce` each one would have gated a commit. A row
 * that re-raises an earlier finding points at it with `sameAs`, and
 * inherits its verdict unless it has its own. A SHA-free key was rejected:
 * the model rewords a finding between runs and the line moves with the
 * code, so a hash of the text would rarely match across commits, and a
 * fuzzy match would be a guess written down as a fact.
 *
 * ## Rows without an id
 *
 * Findings posted before the stats line carried ids (version 3) cannot be
 * joined to a run. The rows judged by hand before this file existed are
 * kept as `legacy` rows: no id, the coverage as it was reconstructed then,
 * and a reference (`legacy-N`) so ground truth can point at them. No id is
 * invented for them.
 *
 * ## Ground truth
 *
 * A miss is a real defect the agent did not report, so it can only be
 * counted against a list of the defects a pull request actually contains.
 * `groundTruth` is that list, per pull request, with the findings that
 * reported each defect. A defect no finding reported is a miss. Only a
 * pull request read independently of the agent can show that the agent
 * missed nothing, so the report says how many were.
 *
 * Everything rendered from the file goes into Markdown that is pasted into
 * an issue. The finding text is model output, so it is escaped like the
 * review body escapes it. The hand-kept text (notes, ground truth) is
 * written by the owner and keeps its Markdown, flattened to one line and
 * with pipes escaped so it cannot break the table.
 */

import { z } from 'zod';
import { FINDING_ID_PATTERN } from './findingId';
import { REVIEW_PROMPT_VERSIONS } from './promptVersion';
import { codeSpan, escapeTableCell, flattenText, REVIEW_MARKER } from './review';
import { SEVERITY_ORDER, type FindingSeverity } from './verdict';
import type { QaRunStats } from './calibration';

/** The version of the verdict file's format. */
export const VERDICT_FILE_VERSION = 1;

/** The verdicts for a `blocker` or `major` finding: was it a real defect? */
export const DEFECT_VERDICTS = ['real', 'false positive', 'unsure'] as const;

/** The verdicts for a `minor` or `nit` finding, or a steering one: was it worth reading? */
export const QUALITY_VERDICTS = ['useful', 'noise', 'unsure'] as const;

export type FindingVerdict = (typeof DEFECT_VERDICTS)[number] | (typeof QUALITY_VERDICTS)[number];

/** The share of blocker/major findings that must be real before the gate may block (#59). */
export const PRECISION_TARGET = 0.8;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{7,40}$/;
const LEGACY_REF = /^legacy-[1-9]\d*$/;
const DEFECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const severitySchema = z.enum(['blocker', 'major', 'minor', 'nit']);
const verdictSchema = z.enum(['real', 'false positive', 'unsure', 'useful', 'noise']);
const count = z.number().int().nonnegative();
const prNumber = z.number().int().positive();
const promptVersion = z.number().int().positive().nullable();
const findingIdSchema = z.string().regex(FINDING_ID_PATTERN, 'not a finding id');

const coverageSchema = z
  .object({ files: count, omittedFiles: count, shortenedPatches: count })
  .strict()
  .refine((value) => value.omittedFiles <= value.files, {
    message: 'more files omitted than the pull request has',
  });

/** One finding the agent posted, with an id from the run that posted it. */
const findingRowSchema = z
  .object({
    /** Copied from the review body; the same value the stats line logs. */
    findingId: findingIdSchema,
    pr: prNumber,
    sha: z.string().regex(FULL_SHA, 'not a full lowercase commit sha'),
    severity: severitySchema,
    /** A steering finding: about the pull request's text, not its code. */
    steering: z.boolean(),
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    /** As the review body showed it: one line, at most 1,000 characters. */
    message: z.string().min(1),
    /** Machine-filled from the run's stats line. Null when the run is not on record. */
    coverage: coverageSchema.nullable(),
    /** Machine-filled from the run's stats line (version 5 on). */
    promptVersion,
    /** Hand-kept. Null when not judged yet, or when inherited through `sameAs`. */
    verdict: verdictSchema.nullable(),
    /** Hand-kept: the id of the earlier row this finding re-raises. */
    sameAs: findingIdSchema.nullable(),
    /** Hand-kept. */
    note: z.string(),
  })
  .strict();

/** A finding judged by hand before findings had ids. */
const legacyRowSchema = z
  .object({
    ref: z.string().regex(LEGACY_REF, 'a legacy ref looks like legacy-1'),
    pr: prNumber,
    /** The reviewed commit when the old table named it; never guessed. */
    sha: z.string().regex(SHORT_SHA, 'not a commit sha').nullable(),
    severity: severitySchema,
    finding: z.string().min(1),
    /** Files shown / files in the pull request, as recorded then. */
    coverage: z.string().min(1).nullable(),
    /** How that coverage was arrived at. None of it is a run measurement. */
    coverageSource: z.enum(['replayed budget', 'assumed from later runs', 'review body']),
    promptVersion,
    verdict: verdictSchema,
    note: z.string(),
  })
  .strict();

const defectSchema = z
  .object({
    /** A short slug, unique in the file. */
    id: z.string().regex(DEFECT_ID, 'a defect id is a lowercase slug'),
    severity: severitySchema,
    file: z.string().min(1).nullable(),
    description: z.string().min(1),
    /**
     * Whether the file was in what the model was shown. A defect in a file
     * the budget dropped is `missed (unseen)`, not held against the agent.
     * Null when not known.
     */
    shownToModel: z.boolean().nullable(),
    /** Finding ids or legacy refs of the findings that reported it. Empty: a miss. */
    foundBy: z.array(z.string()),
  })
  .strict();

const groundTruthSchema = z
  .object({
    pr: prNumber,
    /**
     * Whether the pull request was read for defects independently of the
     * agent. Without that read, the list holds only the defects someone
     * happened to find, and an absent miss is not evidence of none.
     */
    readIndependently: z.boolean(),
    note: z.string(),
    defects: z.array(defectSchema),
  })
  .strict();

const verdictFileShape = z
  .object({
    version: z.literal(VERDICT_FILE_VERSION),
    findings: z.array(findingRowSchema),
    legacy: z.array(legacyRowSchema),
    groundTruth: z.array(groundTruthSchema),
    /** Hand-kept Markdown paragraphs rendered after the tables. */
    notes: z.array(z.string()),
  })
  .strict();

export type FindingRow = z.infer<typeof findingRowSchema>;
export type LegacyRow = z.infer<typeof legacyRowSchema>;
export type GroundTruthDefect = z.infer<typeof defectSchema>;
export type GroundTruthPr = z.infer<typeof groundTruthSchema>;
export type VerdictFile = z.infer<typeof verdictFileShape>;
export type RowCoverage = z.infer<typeof coverageSchema>;

function isDefectSeverity(severity: FindingSeverity): boolean {
  return severity === 'blocker' || severity === 'major';
}

/** Which verdicts a finding takes: a defect verdict, or a usefulness one. */
function verdictsFor(row: { severity: FindingSeverity; steering?: boolean }): readonly string[] {
  return isDefectSeverity(row.severity) && row.steering !== true
    ? DEFECT_VERDICTS
    : QUALITY_VERDICTS;
}

/** The verdict a row counts with: its own, or the one it inherits through `sameAs`. */
export function resolvedVerdict(
  row: FindingRow,
  byId: ReadonlyMap<string, FindingRow>,
): FindingVerdict | null {
  if (row.verdict !== null) return row.verdict;
  if (row.sameAs === null) return null;
  return byId.get(row.sameAs)?.verdict ?? null;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/**
 * The checks across rows, which the per-row schema cannot make.
 *
 * Every reference has to land on a row of the same pull request, a
 * `sameAs` chain is one step long (it points at the first sighting, so it
 * cannot loop), and every verdict has to be one that fits the finding's
 * severity, inherited or not.
 */
const verdictFileSchema = verdictFileShape.superRefine((file, ctx) => {
  const issue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: 'custom', message, path });
  };

  for (const id of duplicates(file.findings.map((row) => row.findingId))) {
    issue(`finding id ${id} appears more than once`, ['findings']);
  }
  for (const ref of duplicates(file.legacy.map((row) => row.ref))) {
    issue(`legacy ref ${ref} appears more than once`, ['legacy']);
  }
  for (const pr of duplicates(file.groundTruth.map((entry) => String(entry.pr)))) {
    issue(`ground truth for #${pr} appears more than once`, ['groundTruth']);
  }
  const defectIds = file.groundTruth.flatMap((entry) => entry.defects.map((defect) => defect.id));
  for (const id of duplicates(defectIds)) {
    issue(`defect id ${id} appears more than once`, ['groundTruth']);
  }

  const byId = new Map(file.findings.map((row) => [row.findingId, row]));
  const legacyByRef = new Map(file.legacy.map((row) => [row.ref, row]));

  file.findings.forEach((row, index) => {
    const path = ['findings', index];
    if (row.sameAs !== null) {
      const target = byId.get(row.sameAs);
      if (row.sameAs === row.findingId)
        issue('sameAs points at the row itself', [...path, 'sameAs']);
      else if (!target) issue(`sameAs ${row.sameAs} is not a row in the file`, [...path, 'sameAs']);
      else if (target.pr !== row.pr) {
        issue(`sameAs ${row.sameAs} is on #${target.pr}, not #${row.pr}`, [...path, 'sameAs']);
      } else if (target.sameAs !== null) {
        issue(`sameAs must point at the first sighting, ${target.sameAs}`, [...path, 'sameAs']);
      }
    }
    const verdict = resolvedVerdict(row, byId);
    if (verdict !== null && !verdictsFor(row).includes(verdict)) {
      issue(
        `a ${row.severity}${row.steering ? ' steering' : ''} finding takes ${verdictsFor(row).join(', ')}, not "${verdict}"${row.verdict === null ? ' (inherited through sameAs: give the row its own verdict)' : ''}`,
        [...path, 'verdict'],
      );
    }
  });

  file.legacy.forEach((row, index) => {
    if (!verdictsFor(row).includes(row.verdict)) {
      issue(
        `a ${row.severity} finding takes ${verdictsFor(row).join(', ')}, not "${row.verdict}"`,
        ['legacy', index, 'verdict'],
      );
    }
  });

  file.groundTruth.forEach((entry, entryIndex) => {
    entry.defects.forEach((defect, defectIndex) => {
      const path = ['groundTruth', entryIndex, 'defects', defectIndex, 'foundBy'];
      for (const ref of defect.foundBy) {
        const row = byId.get(ref);
        const legacy = legacyByRef.get(ref);
        const pr = row?.pr ?? legacy?.pr;
        if (pr === undefined) {
          issue(`${ref} is neither a finding id nor a legacy ref in the file`, path);
          continue;
        }
        if (pr !== entry.pr) issue(`${ref} is a finding on #${pr}, not #${entry.pr}`, path);
        const verdict = row ? resolvedVerdict(row, byId) : legacy?.verdict;
        if (verdict === 'false positive' || verdict === 'noise') {
          issue(`${ref} is judged "${verdict}", so it cannot have found a defect`, path);
        }
      }
    });
  });
});

export type VerdictFileResult = { ok: true; file: VerdictFile } | { ok: false; errors: string[] };

/** Validates parsed JSON as a verdict file, with every problem named. */
export function parseVerdictFile(value: unknown): VerdictFileResult {
  const result = verdictFileSchema.safeParse(value);
  if (result.success) return { ok: true, file: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(file)'}: ${issue.message}`,
    ),
  };
}

/** Serialises the file the way it is kept in the repository. */
export function formatVerdictFile(file: VerdictFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Reading the agent's review body back
// ---------------------------------------------------------------------------

/** One row of the findings table in a review body, read back. */
export interface PostedFinding {
  findingId: string;
  severity: FindingSeverity;
  steering: boolean;
  file: string | null;
  line: number | null;
  message: string;
}

/** A review the agent posted, read back. */
export interface PostedReview {
  /** The reviewed commit, from the body's own line. */
  sha: string;
  findings: PostedFinding[];
}

const TABLE_HEADER_WITH_IDS = '| Severity | Location | Finding | ID |';
const REVIEWED_COMMIT = /^Reviewed commit: `([0-9a-f]{40})`$/;
const SEVERITY_CELL = /^(blocker|major|minor|nit)( \(steering\))?$/;
const CORRECTED_LINE = / \(line \d+ is not in the diff\)$/;

/**
 * Splits a table row into cells.
 *
 * A backslash escapes the character after it (the body escapes pipes in
 * the message and the location), so only an unescaped pipe is a boundary.
 * Escapes are kept in the cell text; each cell is unescaped by its reader.
 */
function splitRow(row: string): string[] | null {
  if (!row.startsWith('| ') || !row.endsWith(' |')) return null;
  const inner = row.slice(2, -2);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '\\' && index + 1 < inner.length) {
      current += char + inner[index + 1];
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** The text inside a code span, or null when the cell is not one. */
function codeSpanText(cell: string): string | null {
  const match = /^(`+)([\s\S]*?)\1$/.exec(cell);
  if (!match) return null;
  const text = match[2];
  // `codeSpan` pads text that starts or ends with a backtick.
  if (text.length >= 2 && text.startsWith(' ') && text.endsWith(' ')) {
    const trimmed = text.slice(1, -1);
    if (trimmed.startsWith('`') || trimmed.endsWith('`')) return trimmed;
  }
  return text;
}

function readLocation(cell: string): { file: string | null; line: number | null } | null {
  if (cell === 'general') return { file: null, line: null };
  const corrected = CORRECTED_LINE.test(cell);
  const span = codeSpanText(corrected ? cell.replace(CORRECTED_LINE, '') : cell);
  if (span === null) return null;
  const text = span.replace(/\\\|/g, '|');
  if (corrected) return { file: text, line: null };
  const withLine = /^(.+):([1-9]\d*)$/.exec(text);
  return withLine ? { file: withLine[1], line: Number(withLine[2]) } : { file: text, line: null };
}

/** Undoes `escapeMarkdown`: every backslash escapes the character after it. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\s\S])/g, '$1');
}

function readFindingRow(row: string): PostedFinding | null {
  const cells = splitRow(row);
  if (!cells || cells.length !== 4) return null;
  const [severityCell, locationCell, messageCell, idCell] = cells;

  const severity = SEVERITY_CELL.exec(severityCell);
  const location = readLocation(locationCell);
  const findingId = codeSpanText(idCell);
  const message = unescapeMarkdown(messageCell);
  if (!severity || !location || findingId === null || message.length === 0) return null;
  if (!FINDING_ID_PATTERN.test(findingId)) return null;

  return {
    findingId,
    severity: severity[1] as FindingSeverity,
    steering: severity[2] !== undefined,
    ...location,
    message,
  };
}

/**
 * Reads the findings table back out of a review body the agent posted.
 *
 * Null for a body that is not the agent's (no marker), names no reviewed
 * commit, or predates the id column. The model's text in the body is
 * escaped, so it cannot forge the commit line or a table row: an escaped
 * backtick or pipe does not match. The caller still accepts only reviews
 * posted by the workflow's own account, and only ids the stats line logged
 * for the same commit.
 */
export function parseAgentReview(body: string): PostedReview | null {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== REVIEW_MARKER) return null;

  const commitLine = lines.map((line) => REVIEWED_COMMIT.exec(line)).find((match) => match);
  if (!commitLine) return null;

  const header = lines.indexOf(TABLE_HEADER_WITH_IDS);
  if (header === -1) return { sha: commitLine[1], findings: [] };

  const findings: PostedFinding[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('| ')) break;
    const finding = readFindingRow(line);
    if (finding) findings.push(finding);
  }
  return { sha: commitLine[1], findings };
}

// ---------------------------------------------------------------------------
// Merging run data into the file
// ---------------------------------------------------------------------------

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
 * what the run measured. A row whose run is no longer on record keeps the
 * values it has: GitHub deletes logs after 90 days, and the file is what
 * keeps them past that. The hand-kept columns are never touched.
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
  const findings = file.findings.map((row) => {
    const run = runById.get(row.findingId);
    if (!run) return row;
    const coverage = runCoverage(run);
    if (sameCoverage(coverage, row.coverage) && run.promptVersion === row.promptVersion) return row;
    updated.push(row.findingId);
    return { ...row, coverage, promptVersion: run.promptVersion };
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

  return { file: { ...file, findings }, added, updated, unrecoverable };
}

// ---------------------------------------------------------------------------
// Summarising
// ---------------------------------------------------------------------------

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

export interface MissCounts {
  /** Ground-truth defects that no finding reported, in a file the model was shown (or not known). */
  missed: number;
  /** The same, in a file the model was not shown. */
  missedUnseen: number;
  /** Defects recorded, across the pull requests with ground truth. */
  defects: number;
  /** Defects a finding reported. */
  found: number;
  /** Pull requests with ground truth. */
  prs: number;
  /** Of those, read for defects independently of the agent. */
  independentPrs: number;
  /** Defects and found defects over the independently read pull requests only: the recall. */
  independentDefects: number;
  independentFound: number;
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
  const defects = postings.filter(
    (posting) => isDefectSeverity(posting.severity) && !posting.steering,
  );
  return {
    real: defects.filter((posting) => posting.verdict === 'real').length,
    falsePositive: defects.filter((posting) => posting.verdict === 'false positive').length,
    unsure: defects.filter((posting) => posting.verdict === 'unsure').length,
  };
}

function usefulnessOf(postings: readonly JudgedPosting[]): Usefulness {
  const quality = postings.filter(
    (posting) => !isDefectSeverity(posting.severity) || posting.steering,
  );
  return {
    useful: quality.filter((posting) => posting.verdict === 'useful').length,
    noise: quality.filter((posting) => posting.verdict === 'noise').length,
    unsure: quality.filter((posting) => posting.verdict === 'unsure').length,
  };
}

function countMisses(file: VerdictFile): MissCounts {
  const counts: MissCounts = {
    missed: 0,
    missedUnseen: 0,
    defects: 0,
    found: 0,
    prs: file.groundTruth.length,
    independentPrs: 0,
    independentDefects: 0,
    independentFound: 0,
    prsWithoutGroundTruth: [],
  };

  for (const entry of file.groundTruth) {
    if (entry.readIndependently) counts.independentPrs += 1;
    for (const defect of entry.defects) {
      const found = defect.foundBy.length > 0;
      counts.defects += 1;
      if (found) counts.found += 1;
      else if (defect.shownToModel === false) counts.missedUnseen += 1;
      else counts.missed += 1;
      if (entry.readIndependently) {
        counts.independentDefects += 1;
        if (found) counts.independentFound += 1;
      }
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Hand-kept text in a table cell: its Markdown kept, on one line, with no cell boundary. */
function handCell(text: string): string {
  const flat = flattenText(text);
  return flat.length > 0 ? flat.replace(/(?<!\\)\|/g, '\\|') : ' ';
}

function shaCell(sha: string | null): string {
  return sha !== null && SHORT_SHA.test(sha) ? `\`${sha.slice(0, 7)}\`` : 'not recorded';
}

function promptCell(version: number | null): string {
  return version === null ? 'not recorded' : `v${version}`;
}

function coverageCell(coverage: RowCoverage | null): string {
  if (coverage === null) return 'not recorded';
  const shown = `${coverage.files - coverage.omittedFiles}/${coverage.files}`;
  return coverage.shortenedPatches > 0 ? `${shown}, ${coverage.shortenedPatches} shortened` : shown;
}

/** The location, as the review body shows it: model output, so in a code span. */
function locationCell(row: FindingRow): string {
  if (row.file === null) return 'general';
  return codeSpan(row.line === null ? row.file : `${row.file}:${row.line}`).replace(/\|/g, '\\|');
}

function severityCell(row: { severity: FindingSeverity; steering?: boolean }): string {
  return row.steering ? `${row.severity} (steering)` : row.severity;
}

function percent(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`;
}

function precisionLine(precision: Precision, withTarget: boolean): string {
  const judged = precision.real + precision.falsePositive;
  const unsure =
    precision.unsure > 0 ? ` (${precision.unsure} unsure, left out of the percentage)` : '';
  if (judged === 0) return `no judged findings${unsure}`;
  const target = withTarget
    ? `, against a target of at least ${Math.round(PRECISION_TARGET * 100)}%`
    : '';
  return `${precision.real} real of ${judged}${unsure} -- ${percent(precision.real, judged)}${target}`;
}

function reconciliationLines(reconciliation: Reconciliation | null): string[] {
  if (reconciliation === null) {
    return [
      '_Run data was not loaded (`--offline`), so this table is not reconciled against what the agent posted._',
    ];
  }
  const r = reconciliation;
  return [
    '| | Findings |',
    '|---|---|',
    `| Posted (latest run of each commit, as \`qa:calibration\` counts them) | ${r.posted} |`,
    `| ... by runs that logged finding ids | ${r.postedWithIds} |`,
    `| ... before finding ids were logged | ${r.postedWithoutIds} |`,
    `| ... ... judged by hand, without an id (legacy rows) | ${r.legacyRows} |`,
    `| ... ... not judged (approximate) | ${Math.max(0, r.postedWithoutIds - r.legacyRows)} |`,
    `| Distinct finding ids logged, all runs | ${r.identified} |`,
    `| ... with a verdict | ${r.identifiedWithVerdict} |`,
    `| ... unadjudicated | ${r.identifiedUnadjudicated} |`,
    `| ... ... of which not in the file yet | ${r.notInFile} |`,
    `| Rows in the file whose id no loaded run logged | ${r.rowsNotInRunData} |`,
    '',
    'The findings posted before ids were logged cannot be joined to a run. The legacy rows below are the ones judged by hand, matched to their pull request but not to a run; one may come from an earlier run of its commit, which the posted count leaves out, so the number not judged is approximate.',
  ];
}

function missLines(misses: MissCounts): string[] {
  const unmeasured =
    misses.independentPrs === 0
      ? ' No reviewed pull request has been read independently of the agent yet, so a miss can only be one that was noticed: this is a floor, not a measurement.'
      : '';
  const recall =
    misses.independentDefects > 0
      ? `${misses.independentFound} of ${misses.independentDefects} defects found -- ${percent(misses.independentFound, misses.independentDefects)}, over ${misses.independentPrs} pull request(s) read independently`
      : 'no data: no pull request read independently has a recorded defect';
  const uncovered =
    misses.prsWithoutGroundTruth.length > 0
      ? [
          `**Judged pull requests with no ground truth:** ${misses.prsWithoutGroundTruth.map((pr) => `#${pr}`).join(', ')}. A miss there is unknown.`,
        ]
      : [];
  return [
    `**Missed:** ${misses.missed} (computed from the ground truth below: a recorded defect no finding reported).${unmeasured}`,
    `**Missed (unseen):** ${misses.missedUnseen}. Not counted against the agent: it was never shown the file. Tracked so a partial review is not mistaken for a clean one.`,
    `**Recall:** ${recall}.`,
    ...uncovered,
  ];
}

function findingTable(file: VerdictFile): string[] {
  if (file.findings.length === 0) {
    return ['_No findings with an id are in the file yet. `qa:verdicts --sync` adds them._'];
  }
  const byId = new Map(file.findings.map((row) => [row.findingId, row]));
  const sorted = [...file.findings].sort((a, b) => a.pr - b.pr);
  return [
    '| PR | Commit | Prompt | Coverage | Severity | Location | Finding | ID | Verdict | Note |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...sorted.map((row) => {
      const verdict = resolvedVerdict(row, byId);
      const verdictText =
        verdict === null
          ? '_unadjudicated_'
          : row.verdict === null
            ? `${verdict} (as \`${row.sameAs ?? ''}\`)`
            : verdict;
      const note = row.sameAs !== null ? `Re-raises \`${row.sameAs}\`. ${row.note}` : row.note;
      return `| #${row.pr} | ${shaCell(row.sha)} | ${promptCell(row.promptVersion)} | ${coverageCell(row.coverage)} | ${severityCell(row)} | ${locationCell(row)} | ${escapeTableCell(row.message)} | ${codeSpan(row.findingId)} | ${verdictText} | ${handCell(note)} |`;
    }),
  ];
}

function legacyTable(file: VerdictFile): string[] {
  if (file.legacy.length === 0) return [];
  return [
    '',
    '### Findings judged before finding ids',
    '',
    'Judged by hand before the stats line logged ids, so they have no id and cannot be joined to a run. Their coverage was recorded by hand at the time, and the source column says how: replayed from the diff budget, assumed from a later run, or read from the review body.',
    '',
    '| Ref | PR | Commit | Prompt | Coverage | Coverage source | Severity | Finding (short) | Verdict | Note |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...file.legacy.map(
      (row) =>
        `| ${row.ref} | #${row.pr} | ${shaCell(row.sha)} | ${promptCell(row.promptVersion)} | ${row.coverage === null ? 'not recorded' : handCell(row.coverage)} | ${row.coverageSource} | ${row.severity} | ${handCell(row.finding)} | ${row.verdict} | ${handCell(row.note)} |`,
    ),
  ];
}

function groundTruthTable(file: VerdictFile): string[] {
  const lines = [
    '',
    '### Ground truth',
    '',
    'The defects each pull request actually contains, and the findings that reported them. A defect with no finding is a miss. A pull request not read independently of the agent lists only the defects someone noticed.',
    '',
  ];
  if (file.groundTruth.length === 0) return [...lines, '_No ground truth recorded yet._'];
  lines.push(
    '| PR | Read independently | Defect | Severity | File | Found by | Result |',
    '|---|---|---|---|---|---|---|',
  );
  for (const entry of file.groundTruth) {
    const read = entry.readIndependently ? 'yes' : 'no';
    if (entry.defects.length === 0) {
      lines.push(`| #${entry.pr} | ${read} | _none recorded_ ${handCell(entry.note)} | | | | |`);
      continue;
    }
    for (const defect of entry.defects) {
      const result =
        defect.foundBy.length > 0
          ? 'found'
          : defect.shownToModel === false
            ? 'missed (unseen)'
            : 'missed';
      const foundBy =
        defect.foundBy.length > 0 ? defect.foundBy.map((ref) => `\`${ref}\``).join(', ') : '-';
      const where = defect.file === null ? 'not recorded' : codeSpan(defect.file);
      lines.push(
        `| #${entry.pr} | ${read} | ${handCell(defect.description)} | ${defect.severity} | ${handCell(where)} | ${foundBy} | ${result} |`,
      );
    }
  }
  return lines;
}

export interface VerdictReportContext {
  /** The command that renders the report, named in the header. */
  command: string;
  /** The file the report is rendered from, named in the header. */
  filePath: string;
}

/**
 * Renders the verdict table for #59.
 *
 * The comment on #59 is this rendering, not the source of truth: the
 * header says so, and the reconciliation table states how much of what
 * the agent posted has been judged.
 */
export function renderVerdictReport(
  file: VerdictFile,
  runs: readonly QaRunStats[] | null,
  context: VerdictReportContext,
): string {
  const summary = summarizeVerdicts(file, runs);
  const { usefulness } = summary;

  const byPrompt = summary.precisionByPrompt
    .filter(({ precision }) => precision.real + precision.falsePositive + precision.unsure > 0)
    .map(
      ({ promptVersion: version, precision }) =>
        `${promptCell(version)}: ${precisionLine(precision, false)}`,
    );

  const lines = [
    '## QA agent finding verdicts',
    '',
    `_Generated by \`${context.command}\` from \`${context.filePath}\` and the QA Review run logs. Do not edit this comment: change the file, re-run the generator, and replace this comment with its output._`,
    '',
    '**Verdicts**',
    '- `real`: a genuine defect, fixed or worth fixing',
    '- `false positive`: wrong about the code',
    '- `unsure`: could not tell quickly; left out of the percentage',
    '',
    'For `minor` and `nit` (and steering findings), the question is "was it worth reading?" (`useful` / `noise`), not "was it a bug?". A miss is not a verdict: it is a ground-truth defect that no finding reported.',
    '',
    '**Coverage** is files shown to the model / files in the pull request, from the stats line of the run that posted the finding.',
    '',
    '### Reconciliation with the run data',
    '',
    ...reconciliationLines(summary.reconciliation),
    '',
    '### Summary',
    '',
    `**Blocker/major:** ${precisionLine(summary.precision, true)}`,
    ...(byPrompt.length > 0 ? [`**Blocker/major by prompt version:** ${byPrompt.join('; ')}`] : []),
    `**Minor/nit:** ${usefulness.useful} useful, ${usefulness.noise} noise${usefulness.unsure > 0 ? `, ${usefulness.unsure} unsure` : ''}`,
    ...missLines(summary.misses),
    '',
    `Counted over ${summary.rowsWithVerdict + summary.legacyRows} judged posting(s): ${summary.rowsWithVerdict} with an id${summary.reRaised > 0 ? ` (${summary.reRaised} re-raise an earlier finding and count again, as each would have gated its own commit)` : ''} and ${summary.legacyRows} legacy.`,
    '',
    '### Findings',
    '',
    ...findingTable(file),
    ...legacyTable(file),
    ...groundTruthTable(file),
    '',
    '### Prompt versions',
    '',
    ...REVIEW_PROMPT_VERSIONS.map(
      (entry) => `- v${entry.version}: ${entry.since}, ${entry.change}`,
    ),
  ];

  if (file.notes.length > 0) {
    lines.push('', '### Notes', '');
    for (const note of file.notes) lines.push(note, '');
    lines.pop();
  }

  return `${lines.join('\n')}\n`;
}
