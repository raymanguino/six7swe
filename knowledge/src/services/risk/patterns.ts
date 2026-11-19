import { RISK_EXCERPT_MAX_CHARS, type RiskCategory, type RiskFinding } from '../../contract.js';
import { EMAIL, isPhoneNumber, PHONE_LIKE } from '../evalSet/redact.js';

/**
 * The risk scan's deterministic checks (#212): email addresses, phone numbers,
 * postal addresses, credential shapes, and text aimed at the scan itself. The
 * model pass looks for more, but sometimes misses the obvious and can be
 * talked out of a finding by the document it reads, so these always run. The
 * email and phone patterns are the eval set's masking patterns, so both
 * features agree on what a contact detail is.
 */

/**
 * "123 Main Street", "45 King St. W" style street addresses. Suffixes that are
 * also everyday words ("place", "court", "circle") are left out: "won 1 place
 * at the hackathon" is not an address.
 */
const STREET_ADDRESS =
  /\b\d{1,6}\s+(?:[\p{L}\p{N}'.-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|crescent|cres|terrace|parkway|pkwy|highway|hwy)\b\.?/giu;
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+/gi;
/** A Canadian postal code, e.g. "M5V 2T6". */
const CANADIAN_POSTAL_CODE =
  /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g;
/** A US state code followed by a ZIP code, e.g. "CA 94107". */
const US_STATE_ZIP =
  /\b(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+\d{5}(?:-\d{4})?\b/g;

/** A PEM key block header, e.g. "-----BEGIN RSA PRIVATE KEY-----". */
const PEM_KEY = /-----BEGIN [A-Z0-9 ]*KEY-----/g;
/** An AWS access key id. */
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
/** GitHub tokens: classic (ghp_, gho_, ...) and fine-grained (github_pat_). */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
/** `sk-...` style API keys (OpenAI, Anthropic, Stripe and others). */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
/** "password: hunter2", "pwd=..." */
const PASSWORD_ASSIGNMENT = /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/gi;

/**
 * Text that addresses the scan instead of a reader: the document is the
 * model's input, so it can try to talk the model out of its findings.
 */
const IGNORE_INSTRUCTIONS = /\bignore\s+(?:all\s+|the\s+)?(?:previous|above|prior)\b[^\n]{0,80}/gi;
const SYSTEM_PROMPT = /\bsystem\s+prompt\b/gi;
/** A JSON object shaped like the scan's own answer. */
const FINDINGS_JSON = /\{\s*"findings"\s*:/g;

interface PatternCheck {
  pattern: RegExp;
  category: RiskCategory;
  reason: string;
  /** Rejects a match the pattern alone cannot tell apart (a year range is not a phone number). */
  accept?: (match: string) => boolean;
}

const ADDRESS_REASON =
  'Looks like a postal address. A home address should not be searchable by visitors.';
const CREDENTIAL_REASON =
  'Looks like a password, key or token. A credential must never be published.';
const INSTRUCTION_REASON =
  'Looks like text written to steer the automatic scan. Check this document by hand.';

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
  { pattern: PEM_KEY, category: 'credentials', reason: CREDENTIAL_REASON },
  { pattern: AWS_ACCESS_KEY, category: 'credentials', reason: CREDENTIAL_REASON },
  { pattern: GITHUB_TOKEN, category: 'credentials', reason: CREDENTIAL_REASON },
  { pattern: SK_KEY, category: 'credentials', reason: CREDENTIAL_REASON },
  { pattern: PASSWORD_ASSIGNMENT, category: 'credentials', reason: CREDENTIAL_REASON },
  { pattern: IGNORE_INSTRUCTIONS, category: 'other', reason: INSTRUCTION_REASON },
  { pattern: SYSTEM_PROMPT, category: 'other', reason: INSTRUCTION_REASON },
  { pattern: FINDINGS_JSON, category: 'other', reason: INSTRUCTION_REASON },
];

/**
 * Cut to at most `max` UTF-16 code units (the unit zod's `.max()` and
 * `String.length` count), ending in "…", never splitting a surrogate pair.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  // Don't leave a lone high surrogate before the ellipsis.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
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
