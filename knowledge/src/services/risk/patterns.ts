import { RISK_EXCERPT_MAX_CHARS, type RiskCategory, type RiskFinding } from '../../contract.js';
import { EMAIL, isPhoneNumber, PHONE_LIKE } from '../evalSet/redact.js';

/**
 * The risk scan's deterministic checks (#212): email addresses, phone numbers
 * and postal addresses. The model pass looks for more, but sometimes misses
 * the obvious, so these always run. The email and phone patterns are the eval
 * set's masking patterns, so both features agree on what a contact detail is.
 */

/** "123 Main Street", "45 King St. W" style street addresses. */
const STREET_ADDRESS =
  /\b\d{1,6}\s+(?:[\p{L}\p{N}'.-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|crescent|cres|place|pl|terrace|parkway|pkwy|highway|hwy|circle|cir)\b\.?/giu;
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+/gi;
/** A Canadian postal code, e.g. "M5V 2T6". */
const CANADIAN_POSTAL_CODE =
  /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g;
/** A US state code followed by a ZIP code, e.g. "CA 94107". */
const US_STATE_ZIP =
  /\b(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+\d{5}(?:-\d{4})?\b/g;

interface PatternCheck {
  pattern: RegExp;
  category: RiskCategory;
  reason: string;
  /** Rejects a match the pattern alone cannot tell apart (a year range is not a phone number). */
  accept?: (match: string) => boolean;
}

const ADDRESS_REASON =
  'Looks like a postal address. A home address should not be searchable by visitors.';

const CHECKS: PatternCheck[] = [
  {
    pattern: EMAIL,
    category: 'contact_details',
    reason: 'An email address. Anyone who can search the knowledge base could read it.',
  },
  {
    pattern: PHONE_LIKE,
    category: 'contact_details',
    reason: 'Looks like a phone number. Anyone who can search the knowledge base could read it.',
    accept: isPhoneNumber,
  },
  { pattern: STREET_ADDRESS, category: 'home_address', reason: ADDRESS_REASON },
  { pattern: PO_BOX, category: 'home_address', reason: ADDRESS_REASON },
  { pattern: CANADIAN_POSTAL_CODE, category: 'home_address', reason: ADDRESS_REASON },
  { pattern: US_STATE_ZIP, category: 'home_address', reason: ADDRESS_REASON },
];

/** Cut to `max` code points, so a surrogate pair is never split. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Every match of the deterministic checks, in text order, each distinct
 * excerpt once (at its first offset): an email repeated on every page is
 * one finding.
 */
export function detectPatternFindings(text: string): RiskFinding[] {
  const found: RiskFinding[] = [];
  const seen = new Set<string>();
  for (const { pattern, category, reason, accept } of CHECKS) {
    for (const match of text.matchAll(pattern)) {
      const excerpt = match[0].trim();
      if (!excerpt || (accept && !accept(excerpt))) continue;
      const key = `${category}\u0000${excerpt.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        category,
        source: 'pattern',
        excerpt: truncate(excerpt, RISK_EXCERPT_MAX_CHARS),
        reason,
        location: { page: null, offset: match.index + match[0].indexOf(excerpt) },
      });
    }
  }
  return found.sort((a, b) => (a.location.offset ?? 0) - (b.location.offset ?? 0));
}
