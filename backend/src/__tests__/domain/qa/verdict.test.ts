import {
  decideReviewEvent,
  sanitizeFindings,
  type ReviewFinding,
} from '../../../domain/qa/verdict';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    file: 'backend/src/index.ts',
    line: 10,
    message: 'Something worth mentioning.',
    ...overrides,
  };
}

describe('decideReviewEvent', () => {
  it('comments by default, whatever the findings are', () => {
    expect(decideReviewEvent([])).toBe('COMMENT');
    expect(decideReviewEvent([finding()])).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'blocker' })])).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'major' })])).toBe('COMMENT');
  });

  it('approves an empty findings list in enforce mode', () => {
    expect(decideReviewEvent([], 'enforce')).toBe('APPROVE');
  });

  it('approves when only minor and nit findings remain in enforce mode', () => {
    expect(decideReviewEvent([finding({ severity: 'minor' })], 'enforce')).toBe('APPROVE');
    expect(decideReviewEvent([finding({ severity: 'nit' })], 'enforce')).toBe('APPROVE');
    expect(
      decideReviewEvent([finding({ severity: 'nit' }), finding({ severity: 'minor' })], 'enforce'),
    ).toBe('APPROVE');
  });

  it('requests changes when a blocker or major finding is present in enforce mode', () => {
    expect(decideReviewEvent([finding({ severity: 'blocker' })], 'enforce')).toBe(
      'REQUEST_CHANGES',
    );
    expect(decideReviewEvent([finding({ severity: 'major' })], 'enforce')).toBe('REQUEST_CHANGES');
    expect(
      decideReviewEvent([finding({ severity: 'nit' }), finding({ severity: 'major' })], 'enforce'),
    ).toBe('REQUEST_CHANGES');
  });

  it('never approves in comment-only mode', () => {
    expect(decideReviewEvent([], 'comment-only')).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'blocker' })], 'comment-only')).toBe('COMMENT');
  });
});

describe('sanitizeFindings', () => {
  const changedFiles = ['backend/src/index.ts', 'backend/src/routes/portfolio.ts'];

  it('drops a finding that references a file outside the diff', () => {
    const findings = [finding({ file: 'backend/src/does-not-exist.ts' })];

    expect(sanitizeFindings(findings, changedFiles)).toEqual([]);
  });

  it('keeps a finding that references a file in the diff', () => {
    const kept = finding({ file: 'backend/src/routes/portfolio.ts' });

    expect(sanitizeFindings([kept], changedFiles)).toEqual([kept]);
  });

  it('keeps findings without a file', () => {
    const general = finding({ file: null, line: null });

    expect(sanitizeFindings([general], changedFiles)).toEqual([general]);
  });

  it('preserves the order of the findings that survive', () => {
    const first = finding({ file: 'backend/src/index.ts', message: 'first' });
    const dropped = finding({ file: 'nope.ts', message: 'dropped' });
    const last = finding({ file: null, message: 'last' });

    expect(sanitizeFindings([first, dropped, last], changedFiles)).toEqual([first, last]);
  });

  it('drops file-specific findings when the diff is empty but keeps general ones', () => {
    const general = finding({ file: null });
    const findings = [finding({ file: 'backend/src/index.ts' }), general];

    expect(sanitizeFindings(findings, [])).toEqual([general]);
  });
});
