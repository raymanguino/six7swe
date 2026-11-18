import {
  fitBodyToBudget,
  renderFailureBody,
  renderReviewBody,
  type ReviewBodyInput,
} from '../../../domain/qa/review';

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
    expect(renderReviewBody({ ...INPUT, durationMs: 42_400 })).toContain('Review took 42.4s.');
  });

  it('reports it whatever the gate outcome', () => {
    const body = renderReviewBody({ ...INPUT, gate: 'fail', durationMs: 1_600 });

    expect(body).toContain('Gate outcome: `fail`');
    expect(body).toContain('Review took 1.6s.');
  });

  it('omits the line when no duration is given', () => {
    expect(renderReviewBody(INPUT)).not.toContain('Review took');
  });
});

describe('review body duration format and placement', () => {
  it.each([
    [0, '0.0s'],
    [500, '0.5s'],
    [1500, '1.5s'],
    [42_400, '42.4s'],
  ])('renders %i ms as %s', (ms, text) => {
    expect(renderReviewBody({ ...INPUT, durationMs: ms })).toContain(`Review took ${text}.`);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('omits the line for %s', (ms) => {
    expect(renderReviewBody({ ...INPUT, durationMs: ms })).not.toContain('Review took');
    expect(renderFailureBody('boom', 'abc123', 'comment-only', ms)).not.toContain('Review took');
  });

  it('puts the gate line before the duration line', () => {
    const body = renderReviewBody({ ...INPUT, durationMs: 1000 });

    expect(body.indexOf('Gate outcome:')).toBeLessThan(body.indexOf('Review took'));
  });

  it('is carried by the fail-closed body, after the reviewed commit', () => {
    const body = renderFailureBody('model timeout', 'abc123', 'comment-only', 300_000);

    expect(body).toContain('Review took 300.0s.');
    expect(body.indexOf('Reviewed commit:')).toBeLessThan(body.indexOf('Review took'));
  });

  it('omits the line from the fail-closed body when no duration is given', () => {
    expect(renderFailureBody('boom', 'abc123')).not.toContain('Review took');
  });

  it('survives fitBodyToBudget when the body is within budget', () => {
    const body = renderReviewBody({ ...INPUT, durationMs: 2000 });

    expect(fitBodyToBudget(body)).toContain('Review took 2.0s.');
  });
});
