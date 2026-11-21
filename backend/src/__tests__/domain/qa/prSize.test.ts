import type { ChangedFile, DiffBudget } from '../../../domain/qa/diff';
import { measurePrSize, parseUnifiedDiff } from '../../../domain/qa/prSize';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' ',
  'diff --git a/docs/new file.md b/docs/new file.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/new file.md\t',
  '@@ -0,0 +1 @@',
  '+# Title',
  'diff --git a/old.ts b/lib/new.ts',
  'similarity index 90%',
  'rename from old.ts',
  'rename to lib/new.ts',
  'index 4444444..5555555 100644',
  '--- a/old.ts',
  '+++ b/lib/new.ts',
  '@@ -1 +1 @@',
  '-export const x = 1;',
  '+export const x = 2;',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  'index 6666666..0000000',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/img/logo one.png b/img/logo one.png',
  'new file mode 100644',
  'index 0000000..7777777',
  'Binary files /dev/null and b/img/logo one.png differ',
  'diff --git a/pure.ts b/moved/pure.ts',
  'similarity index 100%',
  'rename from pure.ts',
  'rename to moved/pure.ts',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF);

  it('lists every file in order', () => {
    expect(files.map((file) => file.filename)).toEqual([
      'src/app.ts',
      'docs/new file.md',
      'lib/new.ts',
      'gone.ts',
      'img/logo one.png',
      'moved/pure.ts',
    ]);
  });

  it('keeps only the hunks as the patch, as the GitHub API does', () => {
    expect(files[0]?.patch).toBe(
      [
        '@@ -1,3 +1,4 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' ',
      ].join('\n'),
    );
  });

  it('counts additions and deletions from the hunks', () => {
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1, status: 'modified' });
  });

  it('reads the status and the previous path of a rename', () => {
    expect(files[1]).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(files[2]).toMatchObject({ status: 'renamed', previousFilename: 'old.ts' });
    expect(files[3]).toMatchObject({ status: 'removed', deletions: 1 });
    expect(files[5]).toMatchObject({ status: 'renamed', previousFilename: 'pure.ts' });
  });

  it('gives a file with no hunks no patch', () => {
    expect(files[4]?.patch).toBeUndefined();
    expect(files[5]?.patch).toBeUndefined();
  });

  it('handles CRLF output and an empty diff', () => {
    expect(parseUnifiedDiff(DIFF.replace(/\n/g, '\r\n')).map((file) => file.filename)).toEqual(
      files.map((file) => file.filename),
    );
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

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
