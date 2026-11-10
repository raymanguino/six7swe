import {
  addedLineNumbers,
  allTouchedPaths,
  buildReviewDiff,
  NO_PATCH_MARKER,
  PATCH_SKIPPED_MARKER,
  type ChangedFile,
  type DiffBudget,
} from '../../../domain/qa/diff';

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
    expect(diff).toContain(PATCH_SKIPPED_MARKER);
  });

  it('skips a nested lockfile too', () => {
    const diff = buildReviewDiff(
      [file({ filename: 'frontend/package-lock.json', patch: 'lockfile noise' })],
      BUDGET,
    );

    expect(diff).not.toContain('lockfile noise');
    expect(diff).toContain(PATCH_SKIPPED_MARKER);
  });

  it('lists a file named in skipPatchesFor but never includes its patch', () => {
    const diff = buildReviewDiff([file({ filename: 'docs/generated.md' })], {
      ...BUDGET,
      skipPatchesFor: ['docs/generated.md'],
    });

    expect(diff).toContain('### docs/generated.md');
    expect(diff).not.toContain('+new');
    expect(diff).toContain(PATCH_SKIPPED_MARKER);
  });

  it('marks a file with no patch as having none, not as truncation', () => {
    const diff = buildReviewDiff([file({ patch: undefined })], BUDGET);

    expect(diff).toContain('### backend/src/index.ts');
    expect(diff).toContain(NO_PATCH_MARKER);
    expect(diff).not.toContain('[diff truncated');
    expect(diff).toContain('[diff note: 1 file have no patch]');
  });

  it('names the path a file was moved from', () => {
    const diff = buildReviewDiff(
      [file({ filename: 'backend/src/new.ts', previousFilename: 'backend/src/old.ts' })],
      BUDGET,
    );

    expect(diff).toContain('### backend/src/new.ts (moved from backend/src/old.ts)');
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

  it('keeps the small files that follow one that does not fit', () => {
    const diff = buildReviewDiff(
      [
        file({ filename: 'huge.ts', patch: 'p'.repeat(500) }),
        file({ filename: 'small.ts', patch: 'tiny' }),
      ],
      { ...BUDGET, totalChars: 200 },
    );

    expect(diff).toContain('### small.ts');
    expect(diff).toContain('[diff truncated: 1 file omitted]');
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

  it('reports what was left out even when nothing fits', () => {
    const diff = buildReviewDiff([file({ filename: 'huge.ts', patch: 'p'.repeat(500) })], {
      ...BUDGET,
      totalChars: 40,
    });

    expect(diff.length).toBeLessThanOrEqual(40);
    expect(diff).toContain('[diff truncated');
    expect(diff).not.toMatch(/^\n/);
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

describe('allTouchedPaths', () => {
  it('returns the path of every file', () => {
    const paths = allTouchedPaths([file({ filename: 'a.ts' }), file({ filename: 'b.ts' })]);

    expect(paths).toEqual(['a.ts', 'b.ts']);
  });

  it('includes the path a file was moved from', () => {
    const paths = allTouchedPaths([file({ filename: 'new.ts', previousFilename: 'old.ts' })]);

    expect(paths).toEqual(['new.ts', 'old.ts']);
  });
});

describe('addedLineNumbers', () => {
  it('reads the new-side line range of a hunk', () => {
    const lines = addedLineNumbers('@@ -10,3 +10,3 @@\n context\n-old\n+new\n more');

    expect([...lines].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it('treats a hunk without a count as a single line', () => {
    expect([...addedLineNumbers('@@ -1 +7 @@\n-old\n+new')]).toEqual([7]);
  });

  it('handles several hunks', () => {
    const lines = addedLineNumbers('@@ -1,2 +1,2 @@\n a\n-b\n@@ -20,2 +30,2 @@\n c\n-d');

    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 30, 31]);
  });

  it('returns nothing for a patch with no hunks', () => {
    expect(addedLineNumbers('').size).toBe(0);
  });
});
