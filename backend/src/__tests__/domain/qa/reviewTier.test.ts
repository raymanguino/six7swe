import {
  buildReviewDiff,
  prepareReviewDiff,
  reviewTier,
  type ChangedFile,
} from '../../../domain/qa/diff';

function file(filename: string, patch = '@@ -1 +1 @@\n-old\n+new'): ChangedFile {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch };
}

describe('reviewTier', () => {
  it.each([
    ['knowledge/src/app.ts', 0],
    ['backend/src/services/x.ts', 0],
    ['backend/scripts/seed.ts', 0],
    ['backend/src/db/migrations/0001_a.sql', 1],
    ['.github/workflows/ci.yml', 1],
    ['package.json', 1],
    ['backend/tsconfig.build.json', 1],
    ['backend/drizzle.config.ts', 1],
    ['railway.json', 1],
    ['knowledge/src/__tests__/a.ts', 2],
    ['backend/src/a.test.ts', 2],
    ['backend/src/a.spec.tsx', 2],
    ['README.md', 3],
    ['docs/architecture.txt', 3],
    ['backend/migrations/meta/_journal.json', 4],
    ['.github/scripts/x.js', 1],
    ['.github/workflows/ci.yml', 1],
    ['backend/src/prompts/review.md', 0],
    ['backend/src/a.test.mts', 2],
    ['backend/src/__mocks__/a.ts', 2],
    ['backend\\src\\services\\x.ts', 0],
    ['pnpm-lock.yaml', 1],
    ['backend/src/__snapshots__/a.snap', 4],
  ])('classifies %s as tier %i', (path, tier) => {
    expect(reviewTier(path)).toBe(tier);
  });
});

describe('buildReviewDiff ordering', () => {
  const roomy = { perFileChars: 400, totalChars: 4000, skipPatchesFor: [] };

  it('orders by tier and keeps the original order within a tier', () => {
    const diff = buildReviewDiff(
      [
        file('docs/a.md'),
        file('backend/src/__tests__/a.test.ts'),
        file('backend/src/z.ts'),
        file('backend/src/b.ts'),
        file('package.json'),
      ],
      roomy,
    );
    const order = [...diff.matchAll(/^### (\S+)/gm)].map((m) => m[1]);

    expect(order).toEqual([
      'backend/src/z.ts',
      'backend/src/b.ts',
      'package.json',
      'backend/src/__tests__/a.test.ts',
      'docs/a.md',
    ]);
  });

  it('tiers a moved file by the stronger of its two paths', () => {
    const moved = (to: string): ChangedFile => ({
      ...file(to),
      previousFilename: 'backend/src/auth.ts',
      status: 'renamed',
    });
    const diff = buildReviewDiff(
      [file('package.json'), moved('docs/auth.ts'), moved('backend/src/__tests__/auth.ts')],
      roomy,
    );
    const order = [...diff.matchAll(/^### (\S+)/gm)].map((m) => m[1]);

    expect(order).toEqual(['docs/auth.ts', 'backend/src/__tests__/auth.ts', 'package.json']);
  });

  it('replays PR #90: runtime source is kept ahead of tests when the budget is tight', () => {
    const big = '@@ -1 +1 @@\n' + '+x'.repeat(100);
    const tests = Array.from({ length: 8 }, (_, i) =>
      file(`knowledge/src/__tests__/t${i}.test.ts`, big),
    );
    const runtime = [
      'knowledge/src/app.ts',
      'knowledge/src/plugins/serviceAuth.ts',
      'knowledge/src/services/ingestion/ingest.ts',
      'knowledge/src/routes/search.ts',
    ].map((name) => file(name, big));

    const result = prepareReviewDiff([...tests, ...runtime], {
      perFileChars: 400,
      totalChars: 1400,
      skipPatchesFor: [],
    });

    for (const r of runtime) {
      expect(result.text).toContain(`### ${r.filename}`);
    }
    expect(result.text).not.toContain('t7.test.ts');
    const firstTest = result.text.indexOf('### knowledge/src/__tests__');
    expect(result.text.indexOf('### knowledge/src/app.ts')).toBeLessThan(
      firstTest === -1 ? Infinity : firstTest,
    );
    expect(result.coverage.omittedFiles).toBeGreaterThan(0);
  });
});
