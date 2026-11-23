import type { ChangedFile, DiffBudget } from '../../../domain/qa/diff';
import { parseUnifiedDiff } from '../../../domain/qa/gitDiff';
import { measurePrSize } from '../../../domain/qa/prSize';

function file(filename: string, patchChars: number): ChangedFile {
  return {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: `@@ -1 +1 @@\n+${'x'.repeat(Math.max(0, patchChars - 14))}`,
  };
}

const BUDGET: DiffBudget = { perFileChars: 1_000, totalChars: 3_000, skipPatchesFor: [] };

describe('measurePrSize', () => {
  it('fits when every file is shown', () => {
    const report = measurePrSize([file('src/a.ts', 500), file('src/b.ts', 500)], BUDGET, 'main');

    expect(report.fits).toBe(true);
    expect(report.notShown).toEqual([]);
    expect(report.text).toContain('FITS');
    expect(report.text).toContain('Base: main');
  });

  it('is over budget and names the files the reviewer would not see', () => {
    const files = [
      file('src/a.ts', 900),
      file('src/b.ts', 900),
      file('src/c.ts', 900),
      file('src/d.ts', 900),
    ];
    const report = measurePrSize(files, BUDGET, 'main');

    expect(report.fits).toBe(false);
    expect(report.notShown.map((f) => f.filename)).toEqual(['src/d.ts']);
    expect(report.text).toContain('OVER BUDGET: 1 of 4 files');
    expect(report.text).toContain('  src/d.ts');
  });

  it('reports a shortened patch without failing the check', () => {
    const report = measurePrSize([file('src/big.ts', 1_500)], BUDGET, 'main');

    expect(report.fits).toBe(true);
    expect(report.shortened.map((f) => f.filename)).toEqual(['src/big.ts']);
    expect(report.text).toContain('Shortened to 1,000 characters');
  });

  it('measures a parsed diff the way the review does, end to end', () => {
    const big = `+${'y'.repeat(1_200)}`;
    const diff = ['src/a.ts', 'src/b.ts', 'src/c.ts']
      .map((name) =>
        [
          `diff --git a/${name} b/${name}`,
          `--- a/${name}`,
          `+++ b/${name}`,
          '@@ -0,0 +1 @@',
          big,
        ].join('\n'),
      )
      .join('\n');
    const report = measurePrSize(parseUnifiedDiff(diff), BUDGET, 'main');

    expect(report.coverage.totalFiles).toBe(3);
    expect(report.notShown.length).toBe(report.coverage.omittedFiles);
    expect(report.fits).toBe(report.coverage.omittedFiles === 0);
  });

  it('does not list a file the budget skips on purpose as missed', () => {
    const skipping: DiffBudget = { ...BUDGET, skipPatchesFor: ['gen/schema.json'] };
    const report = measurePrSize(
      [file('gen/schema.json', 900), file('src/a.ts', 500)],
      skipping,
      'main',
    );

    expect(report.notShown).toEqual([]);
    expect(report.fits).toBe(true);
  });

  it('never counts a lockfile', () => {
    const report = measurePrSize([file('pnpm-lock.yaml', 50_000)], BUDGET, 'main');

    expect(report.fits).toBe(true);
    expect(report.coverage.patchChars).toBe(0);
    expect(report.shortened).toEqual([]);
  });

  it('warns when the branch is near the limit', () => {
    const files = [file('src/a.ts', 800), file('src/b.ts', 800), file('src/c.ts', 800)];

    expect(measurePrSize(files, BUDGET, 'main').text).toContain('Near the limit');
  });
});
