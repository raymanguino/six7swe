import { PR_REVIEW_SYSTEM_PROMPT } from '../../services/ai/prompts/prReview';
import { REVIEW_PROMPT_VERSION, REVIEW_PROMPT_VERSIONS } from '../../domain/qa/promptVersion';
import { hashData } from '../../util/hash';

/**
 * The prompt's text, pinned to its version (#146).
 *
 * Findings are compared per prompt version, so the version has to change
 * whenever the text does. If this test fails because the prompt changed,
 * add a row to `REVIEW_PROMPT_VERSIONS` (which moves `REVIEW_PROMPT_VERSION`
 * on) and record the new hash here.
 */
const PROMPT_HASHES: Record<number, string> = {
  5: 'a51628d97b5d8193065001589e0366f9c9005f7c565c382cb5aeb2dfe76180a9',
};

describe('the review prompt version', () => {
  it('matches the text of the prompt', () => {
    // Line endings are normalised so a CRLF checkout hashes the same.
    const text = PR_REVIEW_SYSTEM_PROMPT.replace(/\r\n/g, '\n');

    expect(hashData(text)).toBe(PROMPT_HASHES[REVIEW_PROMPT_VERSION]);
  });

  it('is the last version in the history, which is numbered from 1 with no gaps', () => {
    expect(REVIEW_PROMPT_VERSIONS.map((entry) => entry.version)).toEqual(
      REVIEW_PROMPT_VERSIONS.map((_, index) => index + 1),
    );
    expect(REVIEW_PROMPT_VERSIONS[REVIEW_PROMPT_VERSIONS.length - 1].version).toBe(
      REVIEW_PROMPT_VERSION,
    );
  });
});
