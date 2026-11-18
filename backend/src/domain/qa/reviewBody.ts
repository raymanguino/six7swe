/**
 * Reads the findings table back out of a review body the agent posted
 * (#146), so the machine-filled columns of the verdict file come from what
 * was posted, not from memory.
 *
 * The parser and `renderReviewBody` have to agree on escaping: the message
 * is escaped with `escapeMarkdown`, and the location is a code span whose
 * pipes are escaped. Only `\|` is an escaped pipe; every other backslash is
 * kept as it is, so a path containing a backslash still splits correctly.
 */

import { FINDING_ID_PATTERN } from './findingId';
import { REVIEW_MARKER } from './review';
import { severitySchema } from './verdictSchema';
import type { FindingSeverity } from './verdict';

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
 * Only `\|` is an escaped pipe, which is how the body escapes a pipe in
 * the message and in the location; every other pipe is a boundary. Any
 * other backslash is ordinary text. The escapes are kept in the cell text,
 * and each cell is unescaped by its reader.
 */
function splitRow(row: string): string[] | null {
  if (!row.startsWith('| ') || !row.endsWith(' |')) return null;
  const inner = row.slice(2, -2);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '\\' && inner[index + 1] === '|') {
      current += '\\|';
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

  const severityCellMatch = SEVERITY_CELL.exec(severityCell);
  const severity = severitySchema.safeParse(severityCellMatch?.[1]);
  const location = readLocation(locationCell);
  const findingId = codeSpanText(idCell);
  const message = unescapeMarkdown(messageCell);
  if (!severityCellMatch || !severity.success || !location) return null;
  if (findingId === null || message.length === 0) return null;
  if (!FINDING_ID_PATTERN.test(findingId)) return null;

  return {
    findingId,
    severity: severity.data,
    steering: severityCellMatch[2] !== undefined,
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
