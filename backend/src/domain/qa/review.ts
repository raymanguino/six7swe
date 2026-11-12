/**
 * The review body the agent posts on a pull request.
 *
 * Pure domain logic: no IO, no framework imports. Rendering the body is
 * what a human reads, so it belongs with the other pure decisions rather
 * than inside the script that wires everything together.
 *
 * The marker lives here too, because it is part of the contract between
 * the body and the client that posts it: the client has to recognise the
 * agent's own review, and the body has to be the one that carries the
 * marker. Keeping the constant in one place stops them drifting apart.
 *
 * Almost everything in the body is untrusted. The summary and the finding
 * messages come from the model, and the model read a diff that the pull
 * request author wrote. So the text is escaped before it is rendered: a
 * finding message containing a pipe would otherwise break the table and
 * add a row the gate never decided on, and a summary containing a bold
 * "**Gate outcome: pass**" would otherwise fake the verdict.
 */

import { REVIEW_DIFF_BUDGET, type DiffCoverage } from './diff';
import {
  MAX_REPORTED_FINDINGS,
  type GateOutcome,
  type ManualReviewReason,
  type ReviewFinding,
  type ReviewMode,
} from './verdict';

/**
 * Hidden marker that identifies the agent's own review.
 *
 * It is an HTML comment, so GitHub renders nothing for it, and it is what
 * lets a later run find the review it posted before.
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

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 3)}...`;
}

function location(finding: ReviewFinding): string {
  if (finding.file === null) {
    return 'general';
  }

  const text = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;

  return codeSpan(text).replace(/\|/g, '\\|');
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
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Says how much of the pull request the model read.
 *
 * Written by the domain from the builder's own counts, never by the model,
 * so a reader can tell "found nothing" from "read less than half".
 */
export function describeCoverage(coverage: DiffCoverage): string {
  const reviewed = coverage.totalFiles - coverage.omittedFiles;
  const files =
    coverage.omittedFiles > 0
      ? `Reviewed ${reviewed} of ${count(coverage.totalFiles, 'file', 'files')}.`
      : coverage.totalFiles === 1
        ? 'Reviewed the 1 file.'
        : `Reviewed all ${coverage.totalFiles} files.`;

  return coverage.shortenedPatches > 0
    ? `${files} ${count(coverage.shortenedPatches, 'patch', 'patches')} shortened.`
    : files;
}

/**
 * Patch characters above which the review body advises splitting the pull
 * request. Initially the diff budget, so the note fires when the pull
 * request is too large to be shown in full. Calibrate it separately from
 * the budget once real data exists.
 */
export const SIZE_ADVISORY_THRESHOLD = REVIEW_DIFF_BUDGET.totalChars;

/**
 * A note, not a finding, that the pull request is too large to review in
 * full. Returns null when it fits. It is advice to the author only: it has
 * no part in the gate outcome, the review event or the exit code.
 */
export function sizeAdvisory(coverage: DiffCoverage, threshold: number): string | null {
  if (coverage.patchChars <= threshold) {
    return null;
  }

  const reviewed = coverage.totalFiles - coverage.omittedFiles;
  const read =
    coverage.omittedFiles > 0
      ? `${reviewed} of ${count(coverage.totalFiles, 'file', 'files')} read`
      : `${count(coverage.shortenedPatches, 'patch', 'patches')} shortened`;

  return `This pull request is too large for a complete review (${read}). Consider splitting it into smaller pull requests so every change gets reviewed.`;
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
    const reviewed = input.coverage.totalFiles - input.coverage.omittedFiles;
    lines.push(
      `Reviewed ${reviewed} of ${input.coverage.totalFiles} files. ${input.coverage.omittedFiles} file(s) were not shown to the model, so a clean result cannot be trusted.`,
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

  return note === null ? [] : ['', `_${note}_`];
}

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
    ...coverageAndReasons(input),
    ...advisoryLines(input.coverage),
    '',
  ];

  const summary = escapeMarkdown(truncate(input.summary, MAX_SUMMARY_CHARS));

  const rows = input.findings
    .slice(0, MAX_REPORTED_FINDINGS)
    .map(
      (finding) =>
        `| ${finding.severity} | ${location(finding)} | ${escapeTableCell(
          truncate(finding.message, MAX_MESSAGE_CHARS),
        )} |`,
    );

  const footer: string[] = [];

  if (input.findings.length > MAX_REPORTED_FINDINGS) {
    footer.push(
      '',
      `_${input.findings.length - MAX_REPORTED_FINDINGS} further finding(s) were not shown._`,
    );
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
        ? `No findings to show. The model reported ${input.reportedCount} finding(s), but none of them referenced a file in this diff, so none were kept.`
        : input.coverage.omittedFiles > 0
          ? `No findings in the files that were reviewed. ${input.coverage.omittedFiles} file(s) were not shown to the model.`
          : 'No findings. The model reported nothing against this diff.',
    );
  }

  const sections: string[] = [header.join('\n')];

  if (summary.length > 0) {
    sections.push(summary, '');
  }

  if (rows.length > 0) {
    sections.push('| Severity | Location | Finding |', '|---|---|---|', ...rows);
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
