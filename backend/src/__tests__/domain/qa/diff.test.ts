import { buildReviewDiff, type ChangedFile, type DiffBudget } from '../../../domain/qa/diff';

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: 'backend/src/index.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new',
    ...overrides,
  };
}

const BUDGET: DiffBudget = {
  perFileChars: 400,
  totalChars: 4000,
  skipPatchesFor: [],
};

describe('buildReviewDiff', () => {
  it('lists every file in order with its path and status', () => {
    const diff = buildReviewDiff(
      [
        file({ filename: 'backend/src/a.ts' }),
        file({ filename: 'backend/src/b.ts', status: 'added' }),
      ],
      BUDGET,
    );

    expect(diff).toContain('### backend/src/a.ts (modified) +2 -1');
    expect(diff).toContain('### backend/src/b.ts (added) +2 -1');
    expect(diff.indexOf('backend/src/a.ts')).toBeLessThan(diff.indexOf('backend/src/b.ts'));
  });

  it('includes the patch of a normal file', () => {
    const diff = buildReviewDiff([file()], BUDGET);

    expect(diff).toContain('+new');
  });

  it('lists a lockfile but never includes its patch', () => {
    const diff = buildReviewDiff(
      [file({ filename: 'pnpm-lock.yaml', patch: 'lockfile noise' })],
      BUDGET,
    );

    expect(diff).toContain('### pnpm-lock.yaml');
    expect(diff).not.toContain('lockfile noise');
    expect(diff).toContain('[patch not included]');
  });

  it('lists a file named in skipPatchesFor but never includes its patch', () => {
    const diff = buildReviewDiff([file({ filename: 'docs/generated.md' })], {
      ...BUDGET,
      skipPatchesFor: ['docs/generated.md'],
    });

    expect(diff).toContain('### docs/generated.md');
    expect(diff).not.toContain('+new');
  });

  it('omits the patch when GitHub did not return one', () => {
    const diff = buildReviewDiff([file({ patch: undefined })], BUDGET);

    expect(diff).toContain('### backend/src/index.ts');
    expect(diff).toContain('[patch not included]');
  });

  it('shortens a patch that exceeds the per-file budget and says so', () => {
    const diff = buildReviewDiff([file({ patch: 'x'.repeat(500) })], {
      ...BUDGET,
      perFileChars: 50,
    });

    expect(diff).toContain('x'.repeat(50));
    expect(diff).not.toContain('x'.repeat(51));
    expect(diff).toContain('[patch shortened to 50 characters]');
  });

  it('drops files that do not fit the total budget and says how many', () => {
    const diff = buildReviewDiff(
      [
        file({ filename: 'a.ts', patch: 'p'.repeat(100) }),
        file({ filename: 'b.ts', patch: 'p'.repeat(100) }),
        file({ filename: 'c.ts', patch: 'p'.repeat(100) }),
      ],
      { ...BUDGET, totalChars: 200 },
    );

    expect(diff.length).toBeLessThanOrEqual(200);
    expect(diff).toContain('### a.ts');
    expect(diff).not.toContain('### c.ts');
    expect(diff).toContain('[diff truncated: 2 files omitted]');
  });

  it('never exceeds the total budget', () => {
    const diff = buildReviewDiff(
      Array.from({ length: 20 }, (_, index) =>
        file({ filename: `file-${index}.ts`, patch: 'y'.repeat(300) }),
      ),
      { ...BUDGET, totalChars: 500 },
    );

    expect(diff.length).toBeLessThanOrEqual(500);
  });

  it('says nothing about truncation when nothing was dropped', () => {
    const diff = buildReviewDiff([file()], BUDGET);

    expect(diff).not.toContain('[diff truncated');
    expect(diff).not.toContain('[patch shortened');
  });

  it('returns an empty string when there are no files', () => {
    expect(buildReviewDiff([], BUDGET)).toBe('');
  });
});
