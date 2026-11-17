import {
  fitBodyToBudget,
  renderFailureBody,
  renderReviewBody,
  SUPERSEDED_NOTE,
  type ReviewBodyInput,
} from '../../../domain/qa/review';

const INPUT: ReviewBodyInput = {
  summary: 'Fine.',
  findings: [],
  reportedCount: 0,
  gate: 'pass',
  commitSha: 'abc123',
  coverage: { totalFiles: 1, omittedFiles: 0, shortenedPatches: 0, patchChars: 10 },
  manualReviewReasons: [],
};

describe('review body names its run', () => {
  it('states the commit and carries the note in every kind of body', () => {
    const bodies = [
      renderReviewBody(INPUT),
      renderReviewBody({
        ...INPUT,
        gate: 'manual-review',
        manualReviewReasons: ['protected-path'],
      }),
      renderFailureBody('boom', 'abc123'),
    ];

    for (const text of bodies) {
      expect(text).toContain('Reviewed commit: `abc123`');
      expect(text).toContain(SUPERSEDED_NOTE);
    }
  });

  it('keeps the note when the body is shortened to fit', () => {
    // The renderer bounds every field, so an over-budget body is built by
    // padding a rendered one: the backstop is what is under test.
    const rendered = renderReviewBody({ ...INPUT, gate: 'manual-review' });
    const text = fitBodyToBudget(`${rendered}
${'z'.repeat(100_000)}`);

    expect(text).toContain('shortened to fit');
    expect(text).toContain(SUPERSEDED_NOTE);
  });
});
