import { REVIEW_DIFF_BUDGET, type DiffCoverage } from '../../../domain/qa/diff';
import {
  renderReviewBody,
  SIZE_ADVISORY_THRESHOLD,
  sizeAdvisory,
  type ReviewBodyInput,
} from '../../../domain/qa/review';
import { decideGate, type GateInput } from '../../../domain/qa/verdict';

const SMALL: DiffCoverage = { totalFiles: 3, omittedFiles: 0, shortenedPatches: 0, patchChars: 900 };
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

describe('sizeAdvisory', () => {
  it('starts out equal to the diff budget', () => {
    expect(SIZE_ADVISORY_THRESHOLD).toBe(REVIEW_DIFF_BUDGET.totalChars);
  });

  it('is null at or under the threshold', () => {
    expect(sizeAdvisory(SMALL, 1_000)).toBeNull();
    expect(sizeAdvisory({ ...SMALL, patchChars: 1_000 }, 1_000)).toBeNull();
  });

  it('suggests splitting and says how many files were read', () => {
    const note = sizeAdvisory(LARGE, SIZE_ADVISORY_THRESHOLD);

    expect(note).toContain('too large for a complete review (25 of 58 files read)');
    expect(note).toContain('Consider splitting');
  });

  it('does not claim omitted files when only patches were shortened', () => {
    const note = sizeAdvisory(
      { totalFiles: 2, omittedFiles: 0, shortenedPatches: 2, patchChars: 90_000 },
      SIZE_ADVISORY_THRESHOLD,
    );

    expect(note).toContain('2 patches shortened');
    expect(note).not.toContain('files read');
  });
});

describe('size advisory in the review body', () => {
  it('appears once, below the coverage line, for a large pull request', () => {
    const text = body(LARGE, { gate: 'manual-review', manualReviewReasons: ['partial-coverage'] });

    expect(text.indexOf('Reviewed 25 of 58 files')).toBeLessThan(text.indexOf('too large'));
    expect(text.match(/too large for a complete review/g)).toHaveLength(1);
  });

  it('is absent for a small pull request', () => {
    expect(body(SMALL)).not.toContain('too large');
  });

  it('does not take part in the gate outcome in either mode', () => {
    for (const mode of ['comment-only', 'enforce'] as const) {
      const input: GateInput = {
        findings: [],
        changedFiles: [],
        mode,
        reviewCompleted: true,
        coverage: SMALL,
      };

      expect(decideGate({ ...input, coverage: { ...SMALL, patchChars: 500_000 } })).toBe(
        decideGate(input),
      );
    }
  });
});
