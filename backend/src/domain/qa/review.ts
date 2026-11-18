/**
 * The review body the agent posts on a pull request.
 *
 * Pure domain logic: no IO, no framework imports. Rendering the body is
 * what a human reads, so it belongs with the other pure decisions rather
 * than inside the script that wires everything together.
 *
 * The marker lives here too, because it is part of the contract between
 * the body and the client that reads reviews back: the client has to
 * recognise the agent's own reviews, and the body has to be the one that carries the
 * marker. Keeping the constant in one place stops them drifting apart.
 *
 * Almost everything in the body is untrusted. The summary and the finding
 * messages come from the model, and the model read a diff that the pull
 * request author wrote. So the text is escaped before it is rendered: a
 * finding message containing a pipe would otherwise break the table and
 * add a row the gate never decided on, and a summary containing a bold
 * "**Gate outcome: pass**" would otherwise fake the verdict.
 */

import type { DiffCoverage } from './diff';
import { findingIds, type HashFn } from './findingId';
import {
  isSteering,
  MAX_REPORTED_FINDINGS,
  sortFindingsBySeverity,
  type GateOutcome,
  type ManualReviewReason,
  type ReviewFinding,
  type ReviewMode,
} from './verdict';

/**
 * Hidden marker that identifies the agent's own review.
 *
 * It is an HTML comment, so GitHub renders nothing for it, and it is what
 * lets a later run find the requests for changes it posted before, so it
 * can dismiss them once superseded.
 */
export const REVIEW_MARKER = '<!-- six7swe-qa-agent -->';

/**
 * The largest body GitHub accepts.
 *
 * GitHub rejects a longer review body with a 422, and a rejected review
 * means the pull request gets no review at all. The limit here is lower
 * than GitHub's so there is room for the truncation notice.
 */
export const MAX_BODY_CHARS = 60_000;

/** The longest summary kept in the body. */
export const MAX_SUMMARY_CHARS = 4_000;

/** The longest finding message kept in the body. */
export const MAX_MESSAGE_CHARS = 1_000;

/**
 * The characters that can give untrusted text structure in markdown.
 *
 * A backslash escapes the rest. Every one of these renders as the
 * character it was, so the text still reads the same - it just cannot
 * become a heading, a bold run, a code span, a link, an image, a block
 * quote or a table cell boundary.
 */
const MARKDOWN_STRUCTURE = /[\\`*_[\]<>|#~]/g;

/**
 * Control characters, which can hide content or break the layout.
 *
 * An escape sequence can repaint a terminal or hide what a log line
 * really says, so they are stripped rather than left in the text.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Flattens text to a single line of plain characters.
 *
 * Newlines are the important part: a message with a newline in it would
 * otherwise start a new row in the table, or a new line in the review
 * body, and could carry a fake gate outcome with it.
 */
export function flattenText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Escapes untrusted text so it cannot introduce markdown structure.
 */
export function escapeMarkdown(text: string): string {
  return flattenText(text).replace(MARKDOWN_STRUCTURE, '\\$&');
}

/**
 * Escapes untrusted text for a table cell.
 *
 * A pipe ends the cell, so it has to be escaped as well. Without that, a
 * finding message containing a pipe could add a row to the table that the
 * gate never decided on.
 *
 * The pipe is escaped once, not twice: `escapeMarkdown` already escapes
 * the backslash, so escaping the pipe here would leave `\\|` and render
 * as a literal backslash followed by a cell boundary.
 */
export function escapeTableCell(text: string): string {
  return escapeMarkdown(text);
}

/**
 * Wraps text in a code span that cannot be broken out of.
 *
 * A code span is literal, so the markdown characters inside it need no
 * escaping - escaping them there would show the backslashes to the
 * reader. Two things still matter: a pipe, because it ends the table
 * cell even inside a code span, and a backtick, because it ends the code
 * span. The fence is made longer than the longest run of backticks in the
 * text so the span cannot be closed early.
 */
export function codeSpan(text: string): string {
  const safe = flattenText(text);
  const longestRun = safe.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = '`'.repeat(longestRun + 1);
  const padded = safe.startsWith('`') || safe.endsWith('`') ? ` ${safe} ` : safe;

  return `${fence}${padded}${fence}`;
}

/**
 * Escapes every pipe, so text cannot end a table cell, even inside a code
 * span. `parseAgentReview` reads `\|` back as a pipe, and the verdict
 * report escapes its cells with this same function.
 */
export function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Characters that change how text displays without showing themselves:
 * every format character (bidi controls, zero-width characters, the soft
 * hyphen, the byte order mark), the Mongolian vowel separator and the
 * variation selectors.
 */
// Each variation selector is matched on its own, which is the point here.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_CHARACTERS = /[\p{Cf}\u180E\uFE00-\uFE0F]/gu;

/** Removes the characters that could make text read as something it is not. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, '');
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 3)}...`;
}

/**
 * The severity cell, which marks a steering finding as one.
 *
 * A steering finding is about the pull request's text, not its code, and
 * the reader has to be able to tell the two apart at a glance.
 */
export function severityLabel(finding: ReviewFinding): string {
  return isSteering(finding) ? `${finding.severity} (steering)` : finding.severity;
}

/**
 * Picks the findings the body shows, in order.
 *
 * The steering findings are kept, after the defects, by reserving their
 * slots at the end. A plain slice of the sorted list would cut them as
 * soon as there were enough defects, and the reader would never learn
 * that the pull request tried to steer its review.
 *
 * It sorts the findings itself, so the most serious defects are the ones
 * shown whether or not the caller sorted them first.
 */
export function findingsToShow(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const sorted = sortFindingsBySeverity(findings);
  const steering = sorted.filter(isSteering).slice(0, MAX_REPORTED_FINDINGS);
  const defects = sorted
    .filter((finding) => !isSteering(finding))
    .slice(0, MAX_REPORTED_FINDINGS - steering.length);

  return [...defects, ...steering];
}

function location(finding: ReviewFinding): string {
  if (finding.file === null) {
    return 'general';
  }

  if (finding.line === null && finding.correctedFromLine !== undefined) {
    const note = `line ${finding.correctedFromLine} is not in the diff`;
    return `${escapePipes(codeSpan(finding.file))} (${note})`;
  }

  const text = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;

  return escapePipes(codeSpan(text));
}

export interface ReviewBodyInput {
  /** The model's summary. Untrusted. */
  summary: string;
  /** The findings that survived sanitizing, most serious first. */
  findings: readonly ReviewFinding[];
  /** How many findings the model returned before sanitizing. */
  reportedCount: number;
  gate: GateOutcome;
  commitSha: string;
  /** How much of the pull request the model was shown, from the diff builder. */
  coverage: DiffCoverage;
  /** Why a human has to look. Only rendered when the gate is `manual-review`. */
  manualReviewReasons: readonly ManualReviewReason[];
  /**
   * What the finding identifiers are computed from, with `commitSha`: the
   * pull request number and the hash function. When it is given each shown
   * finding carries its identifier (`findingIds`), the same value the
   * stats line logs for the same list. Pass the same findings, in the
   * same order, and the same hash, to both.
   */
  ids?: { pr: number; hash: HashFn };
  /**
   * How long the run took, in milliseconds, measured by the script. Not
   * derived from model output, and not part of the gate.
   *
   * It runs from the start of the script to just before the review is
   * posted, so it excludes posting and dismissing earlier reviews.
   */
  durationMs?: number;
}

/**
 * The duration line, or no line for a value that is not a usable duration.
 * One decimal place, the same precision `qa:calibration` reports.
 */
function durationLines(durationMs: number | undefined): string[] {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return [];
  }

  return [`Review took ${(durationMs / 1000).toFixed(1)}s.`];
}

function reviewedFiles(coverage: DiffCoverage): number {
  return coverage.totalFiles - coverage.omittedFiles;
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Says how many files the budget kept from the model, as one sentence. */
function notShownSentence(omittedFiles: number): string {
  return `${count(omittedFiles, 'file was', 'files were')} not shown to the model.`;
}

/**
 * Says how much of the pull request the model read.
 *
 * Written by the domain from the builder's own counts, never by the model,
 * so a reader can tell "found nothing" from "read less than half".
 */
export function describeCoverage(coverage: DiffCoverage): string {
  const reviewed = reviewedFiles(coverage);
  const files =
    coverage.omittedFiles > 0
      ? `Reviewed ${reviewed} of ${count(coverage.totalFiles, 'file', 'files')}.`
      : coverage.totalFiles === 1
        ? 'Reviewed the 1 file.'
        : `Reviewed all ${coverage.totalFiles} files.`;

  return coverage.shortenedPatches > 0
    ? `${files} ${count(coverage.shortenedPatches, 'patch', 'patches')} shortened, ${count(coverage.hiddenLines, 'line', 'lines')} hidden.`
    : files;
}

/**
 * Omitted files tolerated before advising a split. 0 means the note fires
 * exactly when the diff budget forces files out of the review, so the
 * initial threshold equals the budget by construction. Revisit from
 * qa:calibration data (#59); the unit is a file count, so tuning it from
 * size data later will change the constant's meaning.
 */
export const SIZE_ADVISORY_THRESHOLD = 0;

/**
 * A note, not a finding, that the pull request is too large to review in
 * full. Returns null unless more than `threshold` files were omitted from
 * the diff. It is advice to the author only: it has no part in the gate
 * outcome, the review event or the exit code.
 */
export function sizeAdvisory(coverage: DiffCoverage, threshold: number): string | null {
  if (coverage.omittedFiles <= threshold) {
    return null;
  }

  return [
    `This pull request is too large for a complete review (${reviewedFiles(coverage)} of ${coverage.totalFiles} files read).`,
    'Consider splitting it, for example schema, ingestion and API as separate pull requests.',
  ].join('\n');
}

/**
 * The coverage line, and why a human has to look when the gate says so.
 *
 * `manual-review` has two causes, and the reader has to be told which one
 * applies - or both. The coverage cause extends the coverage line rather
 * than repeating it.
 */
function coverageAndReasons(input: ReviewBodyInput): string[] {
  const reasons = input.gate === 'manual-review' ? input.manualReviewReasons : [];
  const lines: string[] = [];

  if (reasons.includes('partial-coverage')) {
    lines.push(
      `${describeCoverage(input.coverage)} ${notShownSentence(input.coverage.omittedFiles)} A clean result cannot be trusted.`,
    );
  } else {
    lines.push(describeCoverage(input.coverage));
  }

  if (reasons.includes('protected-path')) {
    lines.push(
      'This pull request changes a path that judges or runs the review, so a human decides.',
    );
  }

  return lines;
}

function advisoryLines(coverage: DiffCoverage): string[] {
  const note = sizeAdvisory(coverage, SIZE_ADVISORY_THRESHOLD);

  return note === null ? [] : ['', ...note.split('\n').map((line) => `_${line}_`)];
}

/**
 * Every run posts its own review, so a reader can land on an older one.
 * This says how to tell which one is current.
 */
export const SUPERSEDED_NOTE =
  '_One review is posted per run. The most recent QA agent review on this pull request is the current verdict; this one covers only the commit above._';

/**
 * Renders the review body.
 *
 * The gate outcome comes first, before anything the model wrote. The
 * reader has to meet the real verdict before they meet text that was
 * written by a model that read attacker-controlled content.
 *
 * The findings are trimmed here, and only here. The gate has already seen
 * every finding by the time this runs, so trimming cannot hide a defect -
 * it only decides which ones the reviewer reads.
 */
export function renderReviewBody(input: ReviewBodyInput): string {
  const header = [
    REVIEW_MARKER,
    '',
    '## QA agent review',
    '',
    `**Gate outcome: \`${input.gate}\`**`,
    `Reviewed commit: \`${escapeMarkdown(input.commitSha)}\``,
    SUPERSEDED_NOTE,
    ...coverageAndReasons(input),
    ...durationLines(input.durationMs),
    ...advisoryLines(input.coverage),
    '',
  ];

  const summary = escapeMarkdown(truncate(input.summary, MAX_SUMMARY_CHARS));

  const shown = findingsToShow(input.findings);

  // Identifiers are assigned over the whole list, in the order given, and
  // looked up by finding: the shown list is a re-sorted selection of it.
  const idOf = new Map<ReviewFinding, string>();
  if (input.ids) {
    const ids = findingIds(
      { pr: input.ids.pr, sha: input.commitSha },
      input.findings,
      input.ids.hash,
    );
    input.findings.forEach((finding, index) => idOf.set(finding, ids[index]));
  }
  const withIds = input.ids !== undefined;

  const rows = shown.map((finding) => {
    const cells = [
      severityLabel(finding),
      location(finding),
      escapeTableCell(truncate(finding.message, MAX_MESSAGE_CHARS)),
    ];
    if (withIds) cells.push(codeSpan(idOf.get(finding) ?? ''));
    return `| ${cells.join(' | ')} |`;
  });

  const footer: string[] = [];

  if (input.findings.length > shown.length) {
    footer.push('', `_${input.findings.length - shown.length} further finding(s) were not shown._`);
  }

  // A model that reported findings which all pointed outside the diff
  // reported something, even though nothing survives sanitizing. Saying
  // "the model reported nothing" would be false.
  //
  // A partial review must not claim the model "reported nothing" either:
  // it reported nothing about the part it was shown.
  if (rows.length === 0) {
    footer.push(
      '',
      input.reportedCount > 0
        ? `No findings to show. The model reported ${input.reportedCount} finding(s), but none of them referenced a file the model was shown, so none were kept.`
        : input.coverage.omittedFiles > 0
          ? `No findings in the files that were reviewed. ${notShownSentence(input.coverage.omittedFiles)}`
          : 'No findings. The model reported nothing against this diff.',
    );
  }

  const sections: string[] = [header.join('\n')];

  if (summary.length > 0) {
    sections.push(summary, '');
  }

  if (rows.length > 0) {
    sections.push(
      withIds ? '| Severity | Location | Finding | ID |' : '| Severity | Location | Finding |',
      withIds ? '|---|---|---|---|' : '|---|---|---|',
      ...rows,
    );
  }

  if (footer.length > 0) {
    sections.push(...footer);
  }

  return fitBodyToBudget(sections.join('\n'));
}

/**
 * Renders the body for a review that could not be completed.
 *
 * A broken agent is reported as an error, never as a finding about the
 * pull request. Conflating the two would make a false positive look like a
 * defect in the code under review.
 */
export function renderFailureBody(
  reason: string,
  commitSha: string,
  mode: ReviewMode = 'comment-only',
  durationMs?: number,
): string {
  const lines = [
    REVIEW_MARKER,
    '',
    '## QA agent review',
    '',
    'The review could not be completed, so no findings are reported.',
    '',
    '**Gate outcome: `fail-closed`**',
    `Reviewed commit: \`${escapeMarkdown(commitSha)}\``,
    ...durationLines(durationMs),
    SUPERSEDED_NOTE,
    '',
    `Reason: ${escapeMarkdown(truncate(reason, MAX_SUMMARY_CHARS))}`,
    '',
    'This is a failure of the review agent, not a finding about this pull request.',
  ];

  if (mode === 'comment-only') {
    lines.push(
      '',
      'The agent is not the merge gate in this mode, so this does not block the merge.',
    );
  }

  return fitBodyToBudget(lines.join('\n'));
}

/**
 * Fits the body inside the length GitHub accepts.
 *
 * This is a backstop. The per-field limits already bound the body well
 * below the limit, so this only matters if a field grows or a new one is
 * added. It keeps the gate outcome, because that is the one line the
 * reader must not lose, and says that the body was shortened.
 */
export function fitBodyToBudget(body: string): string {
  if (body.length <= MAX_BODY_CHARS) {
    return body;
  }

  const lines = body.split('\n');
  const outcomeIndex = lines.findIndex((line) => line.startsWith('**Gate outcome:'));
  const head = lines.slice(0, outcomeIndex + 1);
  const tail = lines.slice(outcomeIndex + 1);

  // Drop the findings table first, then the rest of the body.
  const kept: string[] = [...head];
  let used = kept.join('\n').length;

  for (const line of tail) {
    if (used + line.length + 1 > MAX_BODY_CHARS) {
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }

  kept.push('', '_The review body was shortened to fit the length limit._');

  return kept.join('\n').slice(0, MAX_BODY_CHARS);
}
