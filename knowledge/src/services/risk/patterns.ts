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

/*
 * Every pattern here runs over whole documents (up to 50 MB) on the single
 * ingest worker, so each is linear: repetitions are bounded or anchored, so
 * a failed attempt never rescans the rest of the text.
 */

/**
 * "123 Maple Street", "45 King St. W" style street addresses: a number, one
 * to three capitalised words, and a capitalised street suffix. Case matters,
 * so prose like "Led 5 engineers to drive adoption" or "3 services on the
 * road map" is not an address; nor is "won 1 place", since suffixes that are
 * everyday words ("place", "court", "circle") are left out.
 */
const STREET_ADDRESS =
  /\b\d{1,6}\s+(?:\p{Lu}[\p{L}'.-]{0,30}\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Crescent|Cres|Terrace|Parkway|Pkwy|Highway|Hwy)\b\.?/gu;
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+/gi;
/** A Canadian postal code, e.g. "M5V 2T6". */
const CANADIAN_POSTAL_CODE =
  /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g;
/**
 * A city, a US state code and a ZIP code, e.g. "San Francisco, CA 94107".
 * The city and comma are required: "ID 12345" or "OR 12345" alone is a
 * reference number, not an address.
 */
const US_STATE_ZIP =
  /\b\p{Lu}[\p{L}.'-]{0,30}(?:\s\p{Lu}[\p{L}.'-]{0,30}){0,2},\s?(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s\d{5}(?:-\d{4})?\b/gu;

/** A PEM key block header, e.g. "-----BEGIN RSA PRIVATE KEY-----". */
const PEM_KEY = /-----BEGIN [A-Z0-9 ]{0,40}KEY-----/g;
/** An AWS access key id. */
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
/** GitHub tokens: classic (ghp_, gho_, ...) and fine-grained (github_pat_). */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g;
/** `sk-...` style API keys (OpenAI, Anthropic, Stripe and others). */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,255}/g;
/**
 * A credential assigned a value: "password: hunter22", `"api_key": "abcd..."`,
 * `API_KEY=...`, `token: ...`. The separator stays on one line (so a
 * "Password:" heading does not flag the next line), quotes around the key
 * and value are allowed, and the value is 4 or more non-space characters.
 * Group 1 is everything before the value; group 2 is the value.
 */
const CREDENTIAL_ASSIGNMENT =
  /(\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)["']?[ \t]{0,10}[:=][ \t]{0,10}["']?)([^\s"']{4,200})/gi;

/**
 * Text that addresses the scan instead of a reader: the document is the
 * model's input, so it can try to talk the model out of its findings. These
 * run over a normalised view of the text (NFKC, zero-width characters
 * removed), so look-alike or split-up letters do not slip past.
 */
const IGNORE_INSTRUCTIONS =
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|every|everything|your|these|those|of)\s+){0,6}(?:previous|above|prior|earlier|preceding|former)\b[^\n]{0,80}/gi;
/**
 * An order about the system prompt. The bare phrase is left alone: the
 * owner's own documents may well describe LLM work.
 */
const SYSTEM_PROMPT_ORDER =
  /\b(?:reveal|print|show|repeat|output|ignore|disregard|override|forget)\s+(?:(?:the|your|this|my|its)\s+)?system\s+prompt\b/gi;
/** Text shaped like the scan's own answer. */
const FINDINGS_JSON = /["']?findings["']?\s{0,10}:\s{0,10}\[/gi;

/** A credential's excerpt: a short prefix and the length, never the secret itself. */
export function maskSecret(secret: string): string {
  const prefix = secret.slice(0, Math.min(4, Math.floor(secret.length / 4)));
  return `${prefix}[redacted, ${secret.length} chars]`;
}

const maskWhole = (match: RegExpMatchArray) => maskSecret(match[0]);
/** Keeps the key ("password: "), redacts the value. */
const maskValue = (match: RegExpMatchArray) => {
  const [, key = '', value = ''] = match;
  return `${key}[redacted, ${value.length} chars]`;
};

interface PatternCheck {
  pattern: RegExp;
  category: RiskCategory;
  reason: string;
  /** Rejects a match the pattern alone cannot tell apart (a year range is not a phone number). */
  accept?: (match: string) => boolean;
  /** The stored excerpt, when it must not be the match itself (a credential). */
  excerpt?: (match: RegExpMatchArray) => string;
  /** Matched against the normalised view; such findings have no offset. */
  normalized?: boolean;
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
  // The header names the key type and is not secret itself.
  { pattern: PEM_KEY, category: 'credentials', reason: CREDENTIAL_REASON },
  {
    pattern: AWS_ACCESS_KEY,
    category: 'credentials',
    reason: CREDENTIAL_REASON,
    excerpt: maskWhole,
  },
  { pattern: GITHUB_TOKEN, category: 'credentials', reason: CREDENTIAL_REASON, excerpt: maskWhole },
  { pattern: SK_KEY, category: 'credentials', reason: CREDENTIAL_REASON, excerpt: maskWhole },
  {
    pattern: CREDENTIAL_ASSIGNMENT,
    category: 'credentials',
    reason: CREDENTIAL_REASON,
    excerpt: maskValue,
  },
  {
    pattern: IGNORE_INSTRUCTIONS,
    category: 'other',
    reason: INSTRUCTION_REASON,
    normalized: true,
  },
  {
    pattern: SYSTEM_PROMPT_ORDER,
    category: 'other',
    reason: INSTRUCTION_REASON,
    normalized: true,
  },
  { pattern: FINDINGS_JSON, category: 'other', reason: INSTRUCTION_REASON, normalized: true },
];

/** Zero-width and soft-hyphen characters that can split a word without showing. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** The text as the instruction checks see it: NFKC, invisible characters removed. */
function normalizedView(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

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
 * Every match of the deterministic checks, in text order, each distinct match
 * once (at its first offset): an email repeated on every page is one
 * finding. Credentials are stored masked, but told apart by the raw match.
 */
export function detectPatternFindings(text: string): RiskFinding[] {
  const found: RiskFinding[] = [];
  const seen = new Set<string>();
  let normalized: string | undefined;
  for (const check of CHECKS) {
    const { pattern, category, reason, accept } = check;
    const view = check.normalized ? (normalized ??= normalizedView(text)) : text;
    for (const match of view.matchAll(pattern)) {
      const raw = match[0].trim();
      if (!raw || (accept && !accept(raw))) continue;
      const key = `${category}\u0000${raw.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        category,
        source: 'pattern',
        excerpt: truncate(check.excerpt ? check.excerpt(match) : raw, RISK_EXCERPT_MAX_CHARS),
        reason,
        location: {
          page: null,
          // Offsets into the normalised view would point at the wrong place.
          offset: check.normalized ? null : match.index + match[0].indexOf(raw),
        },
      });
    }
  }
  return found.sort(
    (a, b) =>
      (a.location.offset ?? Number.MAX_SAFE_INTEGER) -
      (b.location.offset ?? Number.MAX_SAFE_INTEGER),
  );
}
