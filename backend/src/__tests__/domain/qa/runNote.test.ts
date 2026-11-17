import { renderFailureBody, renderReviewBody } from '../../../domain/qa/review';

describe('review body names its run', () => {
  it('states the commit and that the latest review is the current verdict', () => {
    const review = renderReviewBody({
      summary: 'Fine.',
      findings: [],
      reportedCount: 0,
      gate: 'pass',
      commitSha: 'abc123',
      coverage: { totalFiles: 1, omittedFiles: 0, shortenedPatches: 0, patchChars: 10 },
      manualReviewReasons: [],
    });
    const failure = renderFailureBody('boom', 'abc123');

    for (const text of [review, failure]) {
      expect(text).toContain('Reviewed commit: `abc123`');
      expect(text).toContain('The most recent QA agent review on this pull request is the current');
    }
  });
});
