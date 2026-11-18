/**
 * The QA agent's evaluation verdicts, kept in the repository (#146).
 *
 * A human judges each finding the agent posts (`real`, `false positive`,
 * ...). Those judgements used to live in a hand-edited comment on #59,
 * which had no key joining a row to the run that produced it and no check
 * that it matched the run data. They now live in a versioned JSON file
 * (`backend/qa/verdicts.json`). This module is the file's schema, validated
 * with Zod, including the checks across rows. The rest needs no I/O either
 * and sits beside it:
 *
 * - `reviewBody.ts` reads a finding table back out of a review body the
 *   agent posted, so the machine-filled columns come from what was posted;
 * - `verdictSync.ts` merges newly posted findings into the file;
 * - `verdictSummary.ts` tallies it and reconciles it with the run data;
 * - `verdictReport.ts` renders the Markdown table pasted into #59.
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
 * an issue. The finding text is model output, so it is rendered as a code
 * span with invisible characters stripped (`verdictReport.ts`). The hand-kept text (notes, ground truth) is
 * written by the owner and keeps its Markdown, flattened to one line and
 * with pipes escaped so it cannot break the table.
 */

import { z } from 'zod';
import { FINDING_ID_PATTERN } from './findingId';
import type { FindingSeverity } from './verdict';

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
/** A commit sha, full or abbreviated, lowercase hex. */
export const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const LEGACY_REF = /^legacy-[1-9]\d*$/;
const DEFECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const severitySchema = z.enum(['blocker', 'major', 'minor', 'nit']);
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
    sha: z.string().regex(SHORT_SHA_PATTERN, 'not a commit sha').nullable(),
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

/**
 * Whether a finding is judged as a defect (`real` / `false positive`)
 * rather than on usefulness: a `blocker` or `major` that is not steering.
 */
export function isDefectFinding(row: { severity: FindingSeverity; steering?: boolean }): boolean {
  return (row.severity === 'blocker' || row.severity === 'major') && row.steering !== true;
}

/** Which verdicts a finding takes: a defect verdict, or a usefulness one. */
function verdictsFor(row: {
  severity: FindingSeverity;
  steering?: boolean;
}): readonly FindingVerdict[] {
  return isDefectFinding(row) ? DEFECT_VERDICTS : QUALITY_VERDICTS;
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
      for (const ref of duplicates(defect.foundBy)) {
        issue(`${ref} is listed more than once`, path);
      }
      for (const ref of new Set(defect.foundBy)) {
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
