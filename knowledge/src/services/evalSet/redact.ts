import { EVAL_MAX_QUESTION_CHARS } from '../../contract.js';

/**
 * Masks what could identify a chat visitor before a question is stored in
 * the eval set (#85): email addresses, links (which can carry names, profile
 * slugs or tokens), @handles and phone numbers. Masking runs before
 * truncation, so a contact detail cut in half at the limit cannot slip through.
 */

export const EMAIL_MASK = '[email]';
export const LINK_MASK = '[link]';
export const HANDLE_MASK = '[handle]';
export const PHONE_MASK = '[phone]';

/**
 * Also the risk scan's email check (#212), which runs over whole documents.
 * The lookbehind starts a match only at the start of a run of local-part
 * characters, and the local part is bounded (64, its RFC limit), so a long
 * run with no "@" is rejected in linear time instead of retried from every
 * position.
 */
export const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/**
 * A URL with a scheme or `www.`, or a bare domain on a common TLD followed by
 * a path ("linkedin.com/in/jane"). Tech names like "Node.js/Express" are
 * left alone.
 */
const LINK =
  /(?:\b(?:https?:\/\/|www\.)[^\s]+|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|org|net|io|dev|co|me|ai|app|ca|uk|us|de|fr|in|xyz|info|page|site)\/[^\s]*)/giu;
/** "@jane_doe", but not the "@" inside a word. */
const HANDLE = /(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_.]{2,}/gu;
/**
 * A run of digits with phone-like separators; `isPhoneNumber` decides by
 * digit count. Also the risk scan's phone check (#212). The run is bounded,
 * so a long stretch of digits and separators costs at most 40 steps per
 * start position, not the rest of the document.
 */
export const PHONE_LIKE = /\+?\(?\d[\d\s().-]{5,40}\d/g;
/** "2019 - 2024" is a year range, not a phone number. */
const YEAR_RANGE = /^\(?(?:19|20)\d{2}\)?\s*[-–.]\s*\(?(?:19|20)\d{2}\)?$/;

/** Whether a `PHONE_LIKE` match is a phone number: 7 to 15 digits, and not a year range. */
export function isPhoneNumber(match: string): boolean {
  const digits = match.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15 && !YEAR_RANGE.test(match.trim());
}

function maskPhone(match: string): string {
  return isPhoneNumber(match) ? PHONE_MASK : match;
}

/** The question as stored: whitespace collapsed, contact details masked, then truncated. */
export function redactQuestion(question: string, maxChars = EVAL_MAX_QUESTION_CHARS): string {
  const masked = question
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EMAIL, EMAIL_MASK)
    .replace(LINK, LINK_MASK)
    .replace(HANDLE, `$1${HANDLE_MASK}`)
    .replace(PHONE_LIKE, maskPhone);
  // Counted in code points, so a surrogate pair is never split.
  const chars = Array.from(masked);
  return chars.length <= maxChars ? masked : `${chars.slice(0, maxChars - 1).join('')}…`;
}
