import { EVAL_MAX_QUESTION_CHARS } from '../../contract.js';

/**
 * Masks what could identify a chat visitor before a question is stored in
 * the eval set (#85): email addresses and phone numbers. Masking runs before
 * truncation, so a contact detail cut in half at the limit cannot slip through.
 */

export const EMAIL_MASK = '[email]';
export const PHONE_MASK = '[phone]';

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** A run of digits with phone-like separators; the replacer decides by digit count. */
const PHONE_LIKE = /\+?\(?\d[\d\s().-]{5,}\d/g;
/** "2019 - 2024" is a year range, not a phone number. */
const YEAR_RANGE = /^\(?(?:19|20)\d{2}\)?\s*[-–.]\s*\(?(?:19|20)\d{2}\)?$/;

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '').length;
  if (digits < 7 || digits > 15 || YEAR_RANGE.test(match.trim())) return match;
  return PHONE_MASK;
}

/** The question as stored: whitespace collapsed, contact details masked, then truncated. */
export function redactQuestion(question: string, maxChars = EVAL_MAX_QUESTION_CHARS): string {
  const masked = question
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EMAIL, EMAIL_MASK)
    .replace(PHONE_LIKE, maskPhone);
  // Counted in code points, so a surrogate pair is never split.
  const chars = Array.from(masked);
  return chars.length <= maxChars ? masked : `${chars.slice(0, maxChars - 1).join('')}…`;
}
