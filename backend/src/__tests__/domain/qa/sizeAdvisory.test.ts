import type { DiffCoverage } from '../../../domain/qa/diff';
import {
  renderFailureBody,
  renderReviewBody,
  SIZE_ADVISORY_THRESHOLD,
  sizeAdvisory,
  type ReviewBodyInput,
} from '../../../domain/qa/review';
import {
  decideGate,
  decideReviewEvent,
  gateBlocksMerge,
  type GateInput,
  type ReviewMode,
} from '../../../domain/qa/verdict';

const SMALL: DiffCoverage = {
  totalFiles: 3,
  omittedFiles: 0,
  shortenedPatches: 0,
  patchChars: 900,
};
const LARGE: DiffCoverage = {
  totalFiles: 58,
  omittedFiles: 33,
  shortenedPatches: 2,
  patchChars: 140_000,
};

function body(coverage: DiffCoverage, overrides: Partial<ReviewBodyInput> = {}): string {
  return renderReviewBody({
    summary: 'Looks fine.',
    findings: [],
    reportedCount: 0,
    gate: 'pass',
    commitSha: 'abc123',
    coverage,
    manualReviewReasons: [],
    ...overrides,
  });
}

const MODES: readonly ReviewMode[] = ['comment-only', 'enforce'];
const NOTE = 'too large for a complete review';

describe('sizeAdvisory', () => {
  it('fires exactly when files are omitted: the threshold of 0 tolerates none', () => {
    expect(SIZE_ADVISORY_THRESHOLD).toBe(0);
    expect(
      sizeAdvisory(
        { ...SMALL, totalFiles: 8, omittedFiles: 1, patchChars: 59_000 },
        SIZE_ADVISORY_THRESHOLD,
      ),
    ).not.toBeNull();
  });

  it('gives no note when every file was shown', () => {
    expect(sizeAdvisory(SMALL, SIZE_ADVISORY_THRESHOLD)).toBeNull();
  });

  it('gives no note when patches were only shortened', () => {
    const shortened = { totalFiles: 7, omittedFiles: 0, shortenedPatches: 3, patchChars: 90_000 };

    expect(sizeAdvisory(shortened, SIZE_ADVISORY_THRESHOLD)).toBeNull();
  });

  it('respects a higher threshold', () => {
    expect(sizeAdvisory(LARGE, 33)).toBeNull();
    expect(sizeAdvisory(LARGE, 32)).not.toBeNull();
  });

  it('is exactly two lines with the files read', () => {
    expect(sizeAdvisory(LARGE, SIZE_ADVISORY_THRESHOLD)).toBe(
      'This pull request is too large for a complete review (25 of 58 files read).\n' +
        'Consider splitting it, for example schema, ingestion and API as separate pull requests.',
    );
  });
});

describe('size advisory in the review body', () => {
  it.each(MODES)('appears once, below the coverage line, in %s mode', (mode) => {
    const gate = decideGate({
      findings: [],
      changedFiles: [],
      mode,
      reviewCompleted: true,
      coverage: LARGE,
    });
    const text = body(LARGE, {
      gate,
      manualReviewReasons: gate === 'manual-review' ? ['partial-coverage'] : [],
    });

    expect(text.match(new RegExp(NOTE, 'g'))).toHaveLength(1);
    expect(text.indexOf('Reviewed')).toBeLessThan(text.indexOf(NOTE));
    expect(text).toContain(
      '_This pull request is too large for a complete review (25 of 58 files read)._',
    );
    expect(text).toContain(
      '_Consider splitting it, for example schema, ingestion and API as separate pull requests._',
    );
  });

  it('is absent for a pull request that fits and for shortened patches', () => {
    expect(body(SMALL)).not.toContain(NOTE);
    expect(
      body({ totalFiles: 7, omittedFiles: 0, shortenedPatches: 3, patchChars: 90_000 }),
    ).not.toContain(NOTE);
  });

  it('is absent from a failure body', () => {
    for (const mode of MODES) {
      expect(renderFailureBody('model unavailable', 'abc123', mode)).not.toContain(NOTE);
    }
  });
});

describe('the advisory and the gate', () => {
  const fits = SMALL;
  const oversized = { ...LARGE };

  it.each([
    ['comment-only', 'pass', 'COMMENT', false],
    ['enforce', 'manual-review', 'COMMENT', true],
  ] as const)(
    'omitted files give the same outcome, event and merge decision in %s mode',
    (mode, outcome, event, blocks) => {
      const input: GateInput = {
        findings: [],
        changedFiles: [],
        mode,
        reviewCompleted: true,
        coverage: oversized,
      };

      // The advisory is derived from coverage alone and is never an input to
      // the gate, so the verdict must match what partial coverage alone gives.
      expect(sizeAdvisory(oversized, SIZE_ADVISORY_THRESHOLD)).not.toBeNull();
      expect(decideGate(input)).toBe(outcome);
      expect(decideReviewEvent([], mode, { coverage: oversized })).toBe(event);
      expect(gateBlocksMerge(decideGate(input), mode)).toBe(blocks);
      expect(decideGate({ ...input, coverage: fits })).toBe('pass');
    },
  );
});
