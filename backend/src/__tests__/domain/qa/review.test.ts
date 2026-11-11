import { renderFailureBody, renderReviewBody, REVIEW_MARKER } from '../../../domain/qa/review';
import type { ReviewFinding } from '../../../domain/qa/verdict';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    file: 'backend/src/index.ts',
    line: null,
    message: 'Something worth mentioning.',
    ...overrides,
  };
}

describe('renderReviewBody', () => {
  it('carries the marker the client looks for', () => {
    const body = renderReviewBody('Looks fine.', [], 'pass', 'abc123');

    expect(body).toContain(REVIEW_MARKER);
  });

  it('states the gate outcome and the commit it refers to', () => {
    const body = renderReviewBody('Looks fine.', [], 'pass', 'abc123');

    expect(body).toContain('**Gate outcome: `pass`**');
    expect(body).toContain('Reviewed commit: `abc123`');
  });

  it('states a manual-review outcome plainly', () => {
    const body = renderReviewBody('Looks fine.', [], 'manual-review', 'abc123');

    expect(body).toContain('**Gate outcome: `manual-review`**');
  });

  it('says so plainly when there are no findings', () => {
    const body = renderReviewBody('Looks fine.', [], 'pass', 'abc123');

    expect(body).toContain('No findings.');
    expect(body).not.toContain('| Severity |');
  });

  it('renders a findings table', () => {
    const body = renderReviewBody(
      'Something is wrong.',
      [finding({ severity: 'major', file: 'backend/src/a.ts', line: 42, message: 'It breaks.' })],
      'fail',
      'abc123',
    );

    expect(body).toContain('| Severity | Location | Finding |');
    expect(body).toContain('| major | `backend/src/a.ts:42` | It breaks. |');
  });

  it('renders a finding with a file but no line', () => {
    const body = renderReviewBody(
      'Something is wrong.',
      [finding({ file: 'backend/src/a.ts', line: null })],
      'fail',
      'abc123',
    );

    expect(body).toContain('`backend/src/a.ts`');
  });

  it('renders a general finding without a location', () => {
    const body = renderReviewBody(
      'Something is wrong.',
      [finding({ file: null, line: null })],
      'fail',
      'abc123',
    );

    expect(body).toContain('| minor | general |');
  });

  it('trims the table to the reported maximum', () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({ message: `Observation ${index}.` }),
    );

    const body = renderReviewBody('Many.', findings, 'fail', 'abc123');

    expect(body).toContain('Observation 0.');
    expect(body).not.toContain('Observation 8.');
    expect(body).toContain('4 further finding(s) were not shown');
  });

  it('includes the summary', () => {
    const body = renderReviewBody('The refresh path swallows a failure.', [], 'pass', 'abc123');

    expect(body).toContain('The refresh path swallows a failure.');
  });
});

describe('renderFailureBody', () => {
  it('reports the failure as a fail-closed outcome, not as a finding', () => {
    const body = renderFailureBody('the model timed out', 'abc123');

    expect(body).toContain(REVIEW_MARKER);
    expect(body).toContain('**Gate outcome: `fail-closed`**');
    expect(body).toContain('the model timed out');
    expect(body).toContain('not a finding about this pull request');
  });

  it('does not render a findings table', () => {
    const body = renderFailureBody('the model timed out', 'abc123');

    expect(body).not.toContain('| Severity |');
  });
});
