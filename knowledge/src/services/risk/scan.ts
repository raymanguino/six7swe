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
 * It never throws and never reports a document clean when it could not look:
 * a model failure (provider down, timeout, garbled answer) or text too long
 * to read in full adds a `scan_failed` finding, which holds the document for
 * the owner's review like any other finding.
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

/** One finding per category and excerpt, in text order, at most `RISK_MAX_FINDINGS`. */
function finalize(findings: RiskFinding[]): RiskFinding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.category}\u0000${f.excerpt.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const failed = unique.filter((f) => f.category === 'scan_failed');
  const rest = unique
    .filter((f) => f.category !== 'scan_failed')
    .sort(
      (a, b) =>
        (a.location.offset ?? Number.MAX_SAFE_INTEGER) -
        (b.location.offset ?? Number.MAX_SAFE_INTEGER),
    );
  // A scan failure is always kept, first: it says the list is incomplete.
  return [...failed, ...rest].slice(0, RISK_MAX_FINDINGS);
}

export async function scanDocument(text: string, options: ScanOptions): Promise<RiskFinding[]> {
  const { scanner, log, documentId } = options;
  const findings: RiskFinding[] = [];
  try {
    findings.push(...detectPatternFindings(text));
  } catch (error) {
    log.warn({ documentId, err: error }, 'Risk scan pattern checks failed');
    findings.push(scanFailedFinding(GENERIC_SCAN_FAILURE));
  }
  if (!scanner) return finalize(findings);

  const { windows, covered } = windowsOf(text);
  const deadline = AbortSignal.timeout(options.deadlineMs ?? SCAN_DEADLINE_MS);
  try {
    for (const window of windows) {
      if (deadline.aborted) throw new RiskScanError('The risk scan did not finish in time.');
      const found = await scanner.scan(window.text, deadline);
      for (const f of found) {
        findings.push({
          category: f.category,
          source: 'model',
          excerpt: truncate(f.excerpt, RISK_EXCERPT_MAX_CHARS),
          reason: truncate(f.reason, RISK_REASON_MAX_CHARS),
          location: { page: null, offset: locateExcerpt(text, f.excerpt, window.start) },
        });
      }
    }
    if (covered < text.length) {
      findings.push(
        scanFailedFinding(
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
            ? 'The risk scan did not finish in time.'
            : GENERIC_SCAN_FAILURE,
      ),
    );
  }
  return finalize(findings);
}
