/**
 * Renders the verdict file as the Markdown table for #59 (#146).
 *
 * The report is pasted into an issue comment. The finding text and the
 * location are model output, so they are rendered as code spans: GitHub
 * neither links a URL nor resolves an @mention inside one. Invisible
 * characters (bidi overrides, zero-width characters) are stripped, so the
 * text reads as what it is. The hand-kept text keeps its Markdown,
 * flattened to one line with its pipes escaped.
 */

import { isKnownPromptVersion, REVIEW_PROMPT_VERSIONS } from './promptVersion';
import { codeSpan, escapePipes, flattenText, stripInvisible } from './review';
import type { QaRunStats } from './calibration';
import type { FindingSeverity } from './verdict';
import {
  PRECISION_TARGET,
  resolvedVerdict,
  SHORT_SHA_PATTERN,
  type FindingRow,
  type RowCoverage,
  type VerdictFile,
} from './verdictSchema';
import {
  summarizeVerdicts,
  type DefectTally,
  type MissCounts,
  type Precision,
  type Reconciliation,
} from './verdictSummary';

/**
 * Model output in a table cell: a code span, so GitHub neither links a URL
 * nor resolves an @mention in it, with its pipes escaped.
 */
function modelCell(text: string): string {
  return escapePipes(codeSpan(stripInvisible(text)));
}

/** A mention, or a bare URL GitHub would link on its own. */
const MENTION_OR_URL =
  /(?<![\w`])@[A-Za-z0-9][\w-]*|\b(?:https?:\/\/|www\.)[^\s<>`()]*[^\s<>`().,;:!?]/g;

/** Outside a code span: the characters that open a link, an image or HTML, and the escape. */
const ACTIVE_MARKDOWN = /[\\<>[\]]/g;

/** Text outside a code span: mentions and URLs wrapped in code spans, active characters escaped. */
function inertSegment(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(MENTION_OR_URL)) {
    out += text.slice(last, match.index).replace(ACTIVE_MARKDOWN, '\\$&');
    out += codeSpan(match[0]);
    last = match.index + match[0].length;
  }
  return out + text.slice(last).replace(ACTIVE_MARKDOWN, '\\$&');
}

/** The start of the next backtick run of exactly `length` characters, or -1. */
function closingFence(text: string, from: number, length: number): number {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let match = runs.exec(text); match; match = runs.exec(text)) {
    if (match[0].length === length) return match.index;
  }
  return -1;
}

/**
 * Hand-kept Markdown, made inert for an issue comment.
 *
 * Code spans and emphasis keep working, so the notes read as written. A
 * mention or a bare URL becomes a code span, so it notifies and links no
 * one, and the characters that open a link, an image or HTML (an unclosed
 * comment included) are escaped. Invisible characters are stripped and
 * the text is flattened onto one line.
 */
export function inertMarkdown(text: string): string {
  const flat = flattenText(stripInvisible(text));
  let out = '';
  let index = 0;
  while (index < flat.length) {
    const tick = flat.indexOf('`', index);
    if (tick === -1) {
      out += inertSegment(flat.slice(index));
      break;
    }
    out += inertSegment(flat.slice(index, tick));
    const fence = /^`+/.exec(flat.slice(tick))?.[0] ?? '`';
    const close = closingFence(flat, tick + fence.length, fence.length);
    if (close === -1) {
      // An unclosed fence is text, not a code span.
      out += fence.replace(/`/g, '\\`');
      index = tick + fence.length;
    } else {
      out += flat.slice(tick, close + fence.length);
      index = close + fence.length;
    }
  }
  return out;
}

/** Hand-kept text in a table cell: inert Markdown, on one line, with no cell boundary. */
function handCell(text: string): string {
  const safe = inertMarkdown(text);
  return safe.length > 0 ? escapePipes(safe) : ' ';
}

function shaCell(sha: string | null): string {
  return sha !== null && SHORT_SHA_PATTERN.test(sha) ? `\`${sha.slice(0, 7)}\`` : 'not recorded';
}

function promptCell(version: number | null): string {
  if (version === null) return 'not recorded';
  return isKnownPromptVersion(version)
    ? `v${version}`
    : `v${version} (unknown to this checkout, update)`;
}

function coverageCell(coverage: RowCoverage | null): string {
  if (coverage === null) return 'not recorded';
  const shown = `${coverage.files - coverage.omittedFiles}/${coverage.files}`;
  return coverage.shortenedPatches > 0 ? `${shown}, ${coverage.shortenedPatches} shortened` : shown;
}

/** The location, as the review body shows it: model output, so in a code span. */
function locationCell(row: FindingRow): string {
  if (row.file === null) return 'general';
  return modelCell(row.line === null ? row.file : `${row.file}:${row.line}`);
}

function severityCell(row: { severity: FindingSeverity; steering?: boolean }): string {
  return row.steering ? `${row.severity} (steering)` : row.severity;
}

/** A share to one decimal place, as `qa:calibration` prints one, so 79.6% never reads as 80%. */
function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
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

function prList(prs: readonly number[]): string {
  return prs.map((pr) => `#${pr}`).join(', ');
}

function missCounts(tally: DefectTally): string {
  return `${tally.missed} missed, ${tally.missedUnseen} missed (unseen)`;
}

/** What the lists of the pull requests not read independently hold. */
function noticedCounts(tally: DefectTally): string {
  if (tally.defects === 0) return 'no defects recorded';
  const misses = tally.missed + tally.missedUnseen === 0 ? 'no misses recorded' : missCounts(tally);
  return `${tally.defects} defect(s) recorded, ${tally.found} found by the agent, ${misses}`;
}

/**
 * Recall over the independently read pull requests, two ways: over every
 * recorded defect, and over the defects in files the model was shown,
 * since a miss in a file it never saw is not held against it.
 */
function recallLine(tally: DefectTally): string {
  if (tally.defects === 0)
    return 'no data: no pull request read independently has a recorded defect';
  const all = `${tally.found} of ${tally.defects} defects found (${percent(tally.found, tally.defects)})`;
  const shownDefects = tally.defects - tally.missedUnseen;
  const shown =
    shownDefects > 0
      ? `${tally.found} of ${shownDefects} among the files the model was shown (${percent(tally.found, shownDefects)})`
      : 'none in a file the model was shown';
  return `${all}; ${shown}`;
}

function missLines(misses: MissCounts): string[] {
  const measured =
    misses.independentPrs.length > 0
      ? `**Missed:** ${missCounts(misses.independent)}, over the ${misses.independentPrs.length} pull request(s) read independently of the agent (${prList(misses.independentPrs)}).`
      : '**Missed:** not measured. No reviewed pull request has been read independently of the agent yet.';
  const noticed =
    misses.noticedOnlyPrs.length > 0
      ? [
          `**Noticed only:** ${noticedCounts(misses.noticedOnly)}, in ${prList(misses.noticedOnlyPrs)}, which were not read independently. These lists hold only the defects someone noticed, so this is a floor, not a measurement, and it is not part of the figures above.`,
        ]
      : [];
  const uncovered =
    misses.prsWithoutGroundTruth.length > 0
      ? [
          `**Judged pull requests with no ground truth:** ${prList(misses.prsWithoutGroundTruth)}. A miss there is unknown.`,
        ]
      : [];
  return [
    measured,
    ...noticed,
    '**Missed (unseen)** is a defect in a file the model was not shown. It is not counted against the agent, and is tracked so a partial review is not mistaken for a clean one.',
    `**Recall:** ${recallLine(misses.independent)}.`,
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
      return `| #${row.pr} | ${shaCell(row.sha)} | ${promptCell(row.promptVersion)} | ${coverageCell(row.coverage)} | ${severityCell(row)} | ${locationCell(row)} | ${modelCell(row.message)} | ${codeSpan(row.findingId)} | ${verdictText} | ${handCell(note)} |`;
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
      const where = defect.file === null ? 'not recorded' : modelCell(defect.file);
      lines.push(
        `| #${entry.pr} | ${read} | ${handCell(defect.description)} | ${defect.severity} | ${where} | ${foundBy} | ${result} |`,
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
    for (const note of file.notes) lines.push(inertMarkdown(note), '');
    lines.pop();
  }

  return `${lines.join('\n')}\n`;
}
