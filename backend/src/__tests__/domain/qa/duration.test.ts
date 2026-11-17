import { renderReviewBody, type ReviewBodyInput } from '../../../domain/qa/review';

const INPUT: ReviewBodyInput = {
  summary: 'Fine.',
  findings: [],
  reportedCount: 0,
  gate: 'pass',
  commitSha: 'abc123',
  coverage: { totalFiles: 1, omittedFiles: 0, shortenedPatches: 0, hiddenLines: 0, patchChars: 10 },
  manualReviewReasons: [],
};

describe('review body duration', () => {
  it('reports the measured duration in seconds', () => {
    expect(renderReviewBody({ ...INPUT, durationMs: 42_400 })).toContain('Review took 42s.');
  });

  it('reports it whatever the gate outcome', () => {
    const body = renderReviewBody({ ...INPUT, gate: 'fail', durationMs: 1_600 });

    expect(body).toContain('Gate outcome: `fail`');
    expect(body).toContain('Review took 2s.');
  });

  it('omits the line when no duration is given', () => {
    expect(renderReviewBody(INPUT)).not.toContain('Review took');
  });
});
