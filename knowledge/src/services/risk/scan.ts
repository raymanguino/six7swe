import type { FastifyBaseLogger } from 'fastify';
import {
  RISK_EXCERPT_MAX_CHARS,
  RISK_MAX_FINDINGS,
  RISK_REASON_MAX_CHARS,
  type RiskFinding,
} from '../../contract.js';
import { detectPatternFindings, truncate } from './patterns.js';
import { RiskScanError, type RiskScanner } from './scanner.js';

/**
 * The risk scan (#212): the deterministic checks plus, when a model is
 * configured, the model pass, over a document's extracted text.
 *
 * It never throws and never reports a document clean when it could not look.
 * A model failure (provider down, timeout, garbled answer) adds a
 * `scan_failed` finding, and the result is not `complete`: uploading the same
 * file again rescans it, and the backfill retries it on the next boot. Text
 * too long to read in full, and findings past the cap, add a note (category
 * `other`, source `scan`) instead: rescanning would not change them.
 * Either way the document is held for the owner's review like any finding.
 */

/** The model reads the text in windows of this many characters... */
export const SCAN_WINDOW_CHARS = 20_000;
/** ...overlapping by this much, so a passage cut at a boundary is seen whole once. */
export const SCAN_WINDOW_OVERLAP = 500;
/** At most this many windows (about 160,000 characters); the rest is reported unscanned. */
export const SCAN_MAX_WINDOWS = 8;
/** The whole model pass gives up after this long. */
export const SCAN_DEADLINE_MS = 5 * 60_000;

const GENERIC_SCAN_FAILURE = 'The risk scan failed unexpectedly.';
const DEADLINE_FAILURE = 'The risk scan did not finish in time.';

export interface ScanResult {
  findings: RiskFinding[];
  /**
   * False when the model pass could not finish (provider down, timeout, a
   * garbled answer): the findings then hold a `scan_failed` one, and a
   * rescan may give a different answer. True otherwise, including with no
   * model configured and for text too long to read in full.
   */
  complete: boolean;
}

export interface ScanOptions {
  /** Null: the deterministic checks only. */
  scanner: RiskScanner | null;
  log: FastifyBaseLogger;
  /** For logs. */
  documentId?: string;
  /** Overrides `SCAN_DEADLINE_MS`, for tests. */
  deadlineMs?: number;
}

export function scanFailedFinding(why: string): RiskFinding {
  return {
    category: 'scan_failed',
    source: 'scan',
    excerpt: '',
    reason: truncate(
      `${why} Check the document yourself before approving it, or upload it again to rescan.`,
      RISK_REASON_MAX_CHARS,
    ),
    location: { page: null, offset: null },
  };
}

/** A note from the scan about its own coverage; rescanning would not change it. */
export function scanNote(note: string): RiskFinding {
  return {
    category: 'other',
    source: 'scan',
    excerpt: '',
    reason: truncate(
      `${note} Check the document yourself before approving it.`,
      RISK_REASON_MAX_CHARS,
    ),
    location: { page: null, offset: null },
  };
}

/** True when the findings include a scan failure: a rescan may give another answer. */
export const hasScanFailure = (findings: readonly RiskFinding[]): boolean =>
  findings.some((f) => f.category === 'scan_failed');

interface Window {
  start: number;
  text: string;
}

function windowsOf(text: string): { windows: Window[]; covered: number } {
  const windows: Window[] = [];
  let start = 0;
  while (start < text.length && windows.length < SCAN_MAX_WINDOWS) {
    const end = Math.min(start + SCAN_WINDOW_CHARS, text.length);
    windows.push({ start, text: text.slice(start, end) });
    if (end === text.length) return { windows, covered: end };
    start = end - SCAN_WINDOW_OVERLAP;
  }
  const last = windows.at(-1);
  return { windows, covered: last ? last.start + last.text.length : 0 };
}

/**
 * Where the model's excerpt is in the text: exactly, then ignoring case and
 * runs of whitespace. Null when the model paraphrased it.
 */
export function locateExcerpt(text: string, excerpt: string, from: number): number | null {
  const exact = text.indexOf(excerpt, from);
  if (exact !== -1) return exact;
  const words = excerpt.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const loose = new RegExp(escaped.join('\\s+'), 'iu');
  const match = loose.exec(text.slice(from));
  return match ? from + match.index : null;
}

/**
 * One finding per category and excerpt (and reason, for a finding without an
 * excerpt), in text order. The scan's own findings come first: they say the
 * list is incomplete. Past `RISK_MAX_FINDINGS`, the last slot says how many
 * more were found, so nothing is dropped silently.
 */
export function finalize(findings: RiskFinding[]): RiskFinding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = [f.category, f.excerpt.toLowerCase(), f.excerpt ? '' : f.reason].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const fromScan = unique.filter((f) => f.source === 'scan');
  const rest = unique
    .filter((f) => f.source !== 'scan')
    .sort(
      (a, b) =>
        (a.location.offset ?? Number.MAX_SAFE_INTEGER) -
        (b.location.offset ?? Number.MAX_SAFE_INTEGER),
    );
  const ordered = [...fromScan, ...rest];
  if (ordered.length <= RISK_MAX_FINDINGS) return ordered;
  const kept = ordered.slice(0, RISK_MAX_FINDINGS - 1);
  const more = ordered.length - kept.length;
  return [...kept, scanNote(`${more} more findings were found but not listed.`)];
}

export async function scanDocument(text: string, options: ScanOptions): Promise<ScanResult> {
  const { scanner, log, documentId } = options;
  const findings: RiskFinding[] = [];
  let complete = true;
  try {
    findings.push(...detectPatternFindings(text));
  } catch (error) {
    log.warn({ documentId, err: error }, 'Risk scan pattern checks failed');
    findings.push(scanFailedFinding(GENERIC_SCAN_FAILURE));
    complete = false;
  }
  if (!scanner) return { findings: finalize(findings), complete };

  const { windows, covered } = windowsOf(text);
  const deadline = AbortSignal.timeout(options.deadlineMs ?? SCAN_DEADLINE_MS);
  try {
    for (const window of windows) {
      if (deadline.aborted) throw new RiskScanError(DEADLINE_FAILURE);
      const found = await scanner.scan(window.text, deadline);
      for (const f of found) {
        findings.push({
          category: f.category,
          source: 'model',
          excerpt: truncate(f.excerpt, RISK_EXCERPT_MAX_CHARS),
          reason: truncate(f.reason, RISK_REASON_MAX_CHARS),
          location: {
            page: null,
            offset: f.excerpt ? locateExcerpt(text, f.excerpt, window.start) : null,
          },
        });
      }
    }
    if (covered < text.length) {
      findings.push(
        scanNote(
          `The document is too long to scan in full: only the first ${covered} of ${text.length} characters were checked.`,
        ),
      );
    }
  } catch (error) {
    const detail = error instanceof RiskScanError ? error.detail : undefined;
    log.warn({ documentId, scanner: scanner.name, err: error, detail }, 'Risk scan failed');
    findings.push(
      scanFailedFinding(
        error instanceof RiskScanError
          ? error.message
          : deadline.aborted
            ? DEADLINE_FAILURE
            : GENERIC_SCAN_FAILURE,
      ),
    );
    complete = false;
  }
  return { findings: finalize(findings), complete };
}
