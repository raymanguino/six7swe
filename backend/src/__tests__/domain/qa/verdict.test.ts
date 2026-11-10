import {
  decideGate,
  decideReviewEvent,
  sanitizeFindings,
  touchesProtectedPath,
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

describe('decideGate', () => {
  it('fails closed when the review could not be completed', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [],
        mode: 'comment-only',
        reviewCompleted: false,
      }),
    ).toBe('fail-closed');

    expect(
      decideGate({
        findings: [],
        changedFiles: [],
        mode: 'enforce',
        reviewCompleted: false,
      }),
    ).toBe('fail-closed');
  });

  it('fails closed even when the findings look clean', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'nit' })],
        changedFiles: ['backend/src/index.ts'],
        mode: 'enforce',
        reviewCompleted: false,
      }),
    ).toBe('fail-closed');
  });

  it('passes for every input in comment-only mode', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [],
        mode: 'comment-only',
        reviewCompleted: true,
      }),
    ).toBe('pass');

    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: ['.github/workflows/qa-review.yml'],
        mode: 'comment-only',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('passes a clean pull request in enforce mode', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: ['backend/src/index.ts'],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('passes when only minor and nit findings are present in enforce mode', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'minor' }), finding({ severity: 'nit' })],
        changedFiles: ['backend/src/index.ts'],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('fails on a blocking finding in enforce mode', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'major' })],
        changedFiles: ['backend/src/index.ts'],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('fail');

    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: ['backend/src/index.ts'],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('fail');
  });

  it('asks for a human when a protected path was touched', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: ['.github/workflows/qa-review.yml'],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });

  it('asks for a human even when the model found a blocker', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: ['package.json'],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });

  it('accepts a custom protected path list', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: ['docs/readme.md'],
        mode: 'enforce',
        protectedPaths: ['docs/**'],
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });
});

describe('touchesProtectedPath', () => {
  it('matches a workflow file against the workflows glob', () => {
    expect(touchesProtectedPath(['.github/workflows/qa-review.yml'])).toBe(true);
    expect(touchesProtectedPath(['.github/workflows/ci.yml'])).toBe(true);
  });

  it('does not match an ordinary source file', () => {
    expect(touchesProtectedPath(['backend/src/routes/portfolio.ts'])).toBe(false);
    expect(touchesProtectedPath(['frontend/src/App.tsx'])).toBe(false);
  });

  it('does not match the agent code against the workflows glob', () => {
    expect(
      touchesProtectedPath(['backend/src/domain/qa/verdict.ts'], ['.github/workflows/**']),
    ).toBe(false);
  });

  it('matches the agent code and the client it uses', () => {
    expect(touchesProtectedPath(['backend/src/domain/qa/diff.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/services/github/prClient.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/services/ai/prReview.ts'])).toBe(true);
  });

  it('matches the review script', () => {
    expect(touchesProtectedPath(['backend/scripts/review-pr.ts'])).toBe(true);
  });

  it('matches the schema and the auth code', () => {
    expect(touchesProtectedPath(['backend/src/db/schema/jobHunt.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/plugins/auth.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/config/auth.ts'])).toBe(true);
  });

  it('matches the dependency manifest at the repository root', () => {
    expect(touchesProtectedPath(['package.json'])).toBe(true);
    expect(touchesProtectedPath(['pnpm-lock.yaml'])).toBe(true);
  });

  it('does not match a package.json in a subdirectory', () => {
    expect(touchesProtectedPath(['backend/package.json'])).toBe(false);
  });

  it('matches a pattern that names a directory without a glob', () => {
    expect(
      touchesProtectedPath(['backend/src/db/schema/users.ts'], ['backend/src/db/schema']),
    ).toBe(true);
  });

  it('does not match a prefix of a longer path', () => {
    expect(
      touchesProtectedPath(['backend/src/services/ai-extra/x.ts'], ['backend/src/services/ai']),
    ).toBe(false);
  });

  it('matches a single star within one segment only', () => {
    expect(touchesProtectedPath(['backend/src/ai.ts'], ['backend/src/*.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/ai/prReview.ts'], ['backend/src/*.ts'])).toBe(false);
  });

  it('returns false for an empty file list', () => {
    expect(touchesProtectedPath([])).toBe(false);
  });
});
