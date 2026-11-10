import {
  decideGate,
  decideReviewEvent,
  reviewEventForGate,
  sanitizeFindings,
  touchesProtectedPath,
  type ReviewFinding,
} from '../../../domain/qa/verdict';
import type { ChangedFile } from '../../../domain/qa/diff';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    file: 'backend/src/index.ts',
    line: null,
    message: 'Something worth mentioning.',
    ...overrides,
  };
}

/** A file whose patch covers lines 10 to 12 of the new revision. */
function patchedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: 'backend/src/index.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -10,3 +10,3 @@\n context\n-old\n+new\n more',
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

  it('never approves, not even for a clean pull request in enforce mode', () => {
    expect(decideReviewEvent([], 'enforce')).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'nit' })], 'enforce')).toBe('COMMENT');
  });

  it('requests changes for a blocking finding in enforce mode', () => {
    expect(
      decideReviewEvent([finding({ severity: 'major' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('REQUEST_CHANGES');
    expect(
      decideReviewEvent([finding({ severity: 'blocker' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('REQUEST_CHANGES');
  });

  it('does not request changes for a minor or a nit in enforce mode', () => {
    expect(
      decideReviewEvent([finding({ severity: 'minor' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('COMMENT');
    expect(
      decideReviewEvent([finding({ severity: 'nit' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('COMMENT');
  });

  it('does not request changes for a finding about a file outside the diff', () => {
    expect(
      decideReviewEvent(
        [finding({ severity: 'blocker', file: 'backend/src/made-up.ts' })],
        'enforce',
        {
          changedFiles: [patchedFile()],
        },
      ),
    ).toBe('COMMENT');
  });

  it('does not request changes when a protected path was touched', () => {
    const event = decideReviewEvent([], 'enforce', {
      changedFiles: [
        {
          filename: '.github/workflows/qa-review.yml',
          status: 'modified',
          additions: 1,
          deletions: 1,
        },
      ],
    });

    expect(event).toBe('COMMENT');
  });
});

describe('reviewEventForGate', () => {
  it('requests changes only for a failing gate', () => {
    expect(reviewEventForGate('fail')).toBe('REQUEST_CHANGES');
  });

  it('comments for every other outcome', () => {
    expect(reviewEventForGate('pass')).toBe('COMMENT');
    expect(reviewEventForGate('manual-review')).toBe('COMMENT');
    expect(reviewEventForGate('fail-closed')).toBe('COMMENT');
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
        changedFiles: [patchedFile()],
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
        changedFiles: [
          {
            filename: '.github/workflows/qa-review.yml',
            status: 'modified',
            additions: 1,
            deletions: 1,
          },
        ],
        mode: 'comment-only',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('passes a clean pull request in enforce mode', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [patchedFile()],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('passes when only minor and nit findings are present in enforce mode', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'minor' }), finding({ severity: 'nit' })],
        changedFiles: [patchedFile()],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('fails on a blocking finding in enforce mode', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'major' })],
        changedFiles: [patchedFile()],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('fail');

    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: [patchedFile()],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('fail');
  });

  it('asks for a human when a protected path was touched', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [
          {
            filename: '.github/workflows/qa-review.yml',
            status: 'modified',
            additions: 1,
            deletions: 1,
          },
        ],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });

  it('asks for a human even when the model found a blocker', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: [
          { filename: 'package.json', status: 'modified', additions: 1, deletions: 1 },
        ],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });

  it('asks for a human when a protected file was moved out of a protected directory', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [
          {
            filename: 'backend/src/qa/verdict.ts',
            previousFilename: 'backend/src/domain/qa/verdict.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
          },
        ],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });

  it('does not let a hallucinated path fail the gate', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'blocker', file: 'backend/src/made-up.ts' })],
        changedFiles: [patchedFile()],
        mode: 'enforce',
        reviewCompleted: true,
      }),
    ).toBe('pass');
  });

  it('accepts a custom protected path list', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [
          { filename: 'docs/readme.md', status: 'modified', additions: 1, deletions: 1 },
        ],
        mode: 'enforce',
        protectedPaths: ['docs/**'],
        reviewCompleted: true,
      }),
    ).toBe('manual-review');
  });
});

describe('sanitizeFindings', () => {
  const changedFiles = [
    { filename: 'backend/src/index.ts', status: 'modified', additions: 1, deletions: 1 },
    { filename: 'backend/src/routes/portfolio.ts', status: 'modified', additions: 1, deletions: 1 },
  ];

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

  it('keeps a finding whose line is part of the diff', () => {
    const onLine = finding({ file: 'backend/src/index.ts', line: 11 });

    expect(sanitizeFindings([onLine], [patchedFile()])).toEqual([onLine]);
  });

  it('clears a line that the diff does not contain but keeps the finding', () => {
    const wrongLine = finding({ file: 'backend/src/index.ts', line: 999 });

    expect(sanitizeFindings([wrongLine], [patchedFile()])).toEqual([{ ...wrongLine, line: null }]);
  });

  it('clears a line on a file that has no patch at all', () => {
    const noPatch = finding({ file: 'backend/src/index.ts', line: 4 });

    expect(sanitizeFindings([noPatch], changedFiles)).toEqual([{ ...noPatch, line: null }]);
  });

  it('keeps a finding about the path a file was moved from', () => {
    const moved = [
      {
        filename: 'backend/src/qa/verdict.ts',
        previousFilename: 'backend/src/domain/qa/verdict.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
    ];

    expect(
      sanitizeFindings([finding({ file: 'backend/src/domain/qa/verdict.ts' })], moved),
    ).toHaveLength(1);
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

  it('matches the schema, the migrations and the auth code', () => {
    expect(touchesProtectedPath(['backend/src/db/schema/jobHunt.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/migrations/0001_new.sql'])).toBe(true);
    expect(touchesProtectedPath(['backend/drizzle.config.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/plugins/auth.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/config/auth.ts'])).toBe(true);
  });

  it('matches the dependency manifests at the root and in the backend', () => {
    expect(touchesProtectedPath(['package.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/package.json'])).toBe(true);
    expect(touchesProtectedPath(['pnpm-lock.yaml'])).toBe(true);
    expect(touchesProtectedPath(['pnpm-workspace.yaml'])).toBe(true);
    expect(touchesProtectedPath(['.npmrc'])).toBe(true);
  });

  it('matches the build and test configuration', () => {
    expect(touchesProtectedPath(['backend/tsconfig.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/tsconfig.scripts.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/tsconfig.test.json'])).toBe(true);
    expect(touchesProtectedPath(['tsconfig.base.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/jest.config.js'])).toBe(true);
    expect(touchesProtectedPath(['eslint.config.js'])).toBe(true);
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

  it('matches everything with a bare glob', () => {
    expect(touchesProtectedPath(['anything/at/all.ts'], ['**'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/index.ts'], ['**'])).toBe(true);
  });

  it('returns false for an empty file list', () => {
    expect(touchesProtectedPath([])).toBe(false);
  });
});
