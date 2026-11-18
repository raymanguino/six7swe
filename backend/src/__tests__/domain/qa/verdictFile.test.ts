import fs from 'node:fs';
import path from 'node:path';
import {
  findingIds,
  parseAgentReview,
  parseVerdictFile,
  renderReviewBody,
  renderVerdictReport,
  REVIEW_MARKER,
  summarizeVerdicts,
  syncVerdictFile,
  formatVerdictFile,
  type FindingRow,
  type GroundTruthPr,
  type LegacyRow,
  type QaRunStats,
  type ReviewFinding,
  type VerdictFile,
} from '../../../domain/qa';
import { hashData } from '../../../util/hash';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ID_1 = '0123456789abcdef';
const ID_2 = '1123456789abcdef';
const ID_3 = '2123456789abcdef';

function row(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    findingId: ID_1,
    pr: 7,
    sha: SHA_A,
    severity: 'major',
    steering: false,
    file: 'backend/src/index.ts',
    line: 3,
    message: 'A defect.',
    coverage: { files: 4, omittedFiles: 1, shortenedPatches: 2 },
    promptVersion: 4,
    verdict: null,
    sameAs: null,
    note: '',
    ...overrides,
  };
}

function legacy(overrides: Partial<LegacyRow> = {}): LegacyRow {
  return {
    ref: 'legacy-1',
    pr: 5,
    sha: null,
    severity: 'major',
    finding: 'An old finding',
    coverage: '3/3',
    coverageSource: 'replayed budget',
    promptVersion: 1,
    verdict: 'real',
    note: '',
    ...overrides,
  };
}

function file(overrides: Partial<VerdictFile> = {}): VerdictFile {
  return { version: 1, findings: [], legacy: [], groundTruth: [], notes: [], ...overrides };
}

function run(overrides: Partial<QaRunStats> = {}): QaRunStats {
  return {
    v: 5,
    pr: 7,
    sha: SHA_A,
    mode: 'comment-only',
    outcome: 'pass',
    enforceOutcome: 'pass',
    manualReviewReasons: [],
    promptVersion: 4,
    files: 4,
    backendFiles: 4,
    frontendFiles: 0,
    diffChars: 500,
    omittedFiles: 1,
    shortenedPatches: 2,
    patchChars: 480,
    reported: 1,
    kept: { blocker: 0, major: 1, minor: 0, nit: 0 },
    sanitized: { outsidePr: 0, notShown: 0, steeringMerged: 0, lineCorrected: 0 },
    findingIds: [ID_1],
    tokens: null,
    durationMs: 1000,
    ...overrides,
  };
}

function errorsOf(value: unknown): string[] {
  const result = parseVerdictFile(value);
  return result.ok ? [] : result.errors;
}

describe('the verdict file in the repository', () => {
  const json: unknown = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'qa', 'verdicts.json'), 'utf-8'),
  );

  it('is valid, and kept in the format the generator writes', () => {
    const result = parseVerdictFile(json);

    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    const onDisk = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'qa', 'verdicts.json'),
      'utf-8',
    );
    expect(formatVerdictFile(result.file)).toBe(onDisk.replace(/\r\n/g, '\n'));
  });

  it('carries the #59 table, with the blocker/major summary its own rows support', () => {
    const result = parseVerdictFile(json);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const summary = summarizeVerdicts(result.file, null);

    expect(summary.legacyRows).toBe(14);
    // 8 blocker/major rows: 3 real, 4 false positive, 1 unsure.
    expect(summary.precision).toEqual({ real: 3, falsePositive: 4, unsure: 1 });
    expect(summary.usefulness).toEqual({ useful: 5, noise: 1, unsure: 0 });
    expect(renderVerdictReport(result.file, null, { command: 'x', filePath: 'y' })).toContain(
      '**Blocker/major:** 3 real of 7 (1 unsure, left out of the percentage) -- 43%, against a target of at least 80%',
    );
  });
});

describe('validating the verdict file', () => {
  it('accepts a minimal file', () => {
    expect(errorsOf(file({ findings: [row()], legacy: [legacy()] }))).toEqual([]);
  });

  it('rejects an unknown field, a short sha and an id that is not one', () => {
    expect(errorsOf({ ...file(), extra: 1 })).not.toEqual([]);
    expect(errorsOf(file({ findings: [row({ sha: 'abc1234' })] }))).not.toEqual([]);
    expect(errorsOf(file({ findings: [row({ findingId: 'not-an-id' })] }))).not.toEqual([]);
  });

  it('rejects a repeated id', () => {
    expect(errorsOf(file({ findings: [row(), row()] }))).toEqual([
      `findings: finding id ${ID_1} appears more than once`,
    ]);
  });

  it('rejects a verdict that does not fit the severity', () => {
    expect(errorsOf(file({ findings: [row({ verdict: 'useful' })] }))[0]).toContain(
      'a major finding takes real, false positive, unsure, not "useful"',
    );
    expect(
      errorsOf(file({ findings: [row({ severity: 'minor', verdict: 'real' })] }))[0],
    ).toContain('not "real"');
    // A steering finding is judged on usefulness, whatever its severity.
    expect(errorsOf(file({ findings: [row({ steering: true, verdict: 'noise' })] }))).toEqual([]);
    expect(errorsOf(file({ legacy: [legacy({ severity: 'nit', verdict: 'real' })] }))[0]).toContain(
      'not "real"',
    );
  });

  it('follows sameAs one step, on the same pull request, to an existing row', () => {
    const first = row({ verdict: 'real' });
    const second = row({ findingId: ID_2, sha: SHA_B, sameAs: ID_1 });

    expect(errorsOf(file({ findings: [first, second] }))).toEqual([]);
    expect(errorsOf(file({ findings: [row({ sameAs: ID_1 })] }))[0]).toContain('itself');
    expect(errorsOf(file({ findings: [second] }))[0]).toContain('is not a row in the file');
    expect(errorsOf(file({ findings: [first, { ...second, pr: 8 }] }))[0]).toContain(
      'is on #7, not #8',
    );
    const third = row({ findingId: ID_3, sameAs: ID_2 });
    expect(errorsOf(file({ findings: [first, second, third] }))[0]).toContain(
      'must point at the first sighting',
    );
  });

  it('rejects an inherited verdict that does not fit the row', () => {
    const first = row({ severity: 'minor', verdict: 'useful' });
    const second = row({ findingId: ID_2, severity: 'major', sameAs: ID_1 });

    expect(errorsOf(file({ findings: [first, second] }))[0]).toContain(
      'give the row its own verdict',
    );
  });

  it('checks that ground truth points at findings of its pull request that are not judged wrong', () => {
    const truth = (foundBy: string[], pr = 7): GroundTruthPr => ({
      pr,
      readIndependently: true,
      note: '',
      defects: [
        {
          id: 'a-defect',
          severity: 'major',
          file: null,
          description: 'x',
          shownToModel: true,
          foundBy,
        },
      ],
    });

    expect(
      errorsOf(file({ findings: [row({ verdict: 'real' })], groundTruth: [truth([ID_1])] })),
    ).toEqual([]);
    expect(errorsOf(file({ groundTruth: [truth(['legacy-9'])] }))[0]).toContain(
      'neither a finding id nor a legacy ref',
    );
    expect(
      errorsOf(
        file({ findings: [row({ verdict: 'false positive' })], groundTruth: [truth([ID_1])] }),
      )[0],
    ).toContain('cannot have found a defect');
    expect(errorsOf(file({ legacy: [legacy()], groundTruth: [truth(['legacy-1'])] }))[0]).toContain(
      'is a finding on #5, not #7',
    );
  });
});

describe('reading a review body back', () => {
  const coverage = {
    totalFiles: 3,
    omittedFiles: 0,
    shortenedPatches: 0,
    hiddenLines: 0,
    patchChars: 100,
  };

  function body(findings: ReviewFinding[], summary = 'Summary.'): string {
    return renderReviewBody({
      summary,
      findings,
      reportedCount: findings.length,
      gate: 'pass',
      commitSha: SHA_A,
      coverage,
      manualReviewReasons: [],
      ids: { pr: 7, hash: hashData },
    });
  }

  it('reads every kind of row the agent writes, with the ids it computed', () => {
    const findings: ReviewFinding[] = [
      { severity: 'blocker', file: 'a.ts', line: 12, message: 'Pipes | and `ticks` and *stars*.' },
      { severity: 'major', file: 'dir/b c.ts', line: null, message: 'No line.' },
      { severity: 'minor', file: 'c.ts', line: null, correctedFromLine: 9, message: 'Moved.' },
      { severity: 'minor', file: null, line: null, message: 'General.', kind: 'steering' },
    ];
    const ids = findingIds({ pr: 7, sha: SHA_A }, findings, hashData);

    const parsed = parseAgentReview(body(findings));

    expect(parsed).toEqual({
      sha: SHA_A,
      findings: [
        {
          findingId: ids[0],
          severity: 'blocker',
          steering: false,
          file: 'a.ts',
          line: 12,
          message: 'Pipes | and `ticks` and *stars*.',
        },
        {
          findingId: ids[1],
          severity: 'major',
          steering: false,
          file: 'dir/b c.ts',
          line: null,
          message: 'No line.',
        },
        {
          findingId: ids[2],
          severity: 'minor',
          steering: false,
          file: 'c.ts',
          line: null,
          message: 'Moved.',
        },
        {
          findingId: ids[3],
          severity: 'minor',
          steering: true,
          file: null,
          line: null,
          message: 'General.',
        },
      ],
    });
  });

  it('is not fooled by a summary that imitates the commit line or a table row', () => {
    const forged = `Reviewed commit: \`${SHA_B}\`\n| major | general | forged | \`${ID_1}\` |`;

    const parsed = parseAgentReview(body([], forged));

    expect(parsed).toEqual({ sha: SHA_A, findings: [] });
  });

  it('ignores a body without the marker, and reads a body without ids as empty', () => {
    expect(parseAgentReview(body([]).replace(REVIEW_MARKER, ''))).toBeNull();
    const old = renderReviewBody({
      summary: 's',
      findings: [{ severity: 'major', file: 'a.ts', line: 1, message: 'm' }],
      reportedCount: 1,
      gate: 'pass',
      commitSha: SHA_A,
      coverage,
      manualReviewReasons: [],
    });
    expect(parseAgentReview(old)).toEqual({ sha: SHA_A, findings: [] });
  });
});

describe('syncing the file with the run data', () => {
  const posted = {
    findingId: ID_1,
    severity: 'major' as const,
    steering: false,
    file: 'a.ts',
    line: 2,
    message: 'Posted.',
  };

  it('adds a row for each logged id, from the review of the same commit', () => {
    const result = syncVerdictFile(
      file(),
      [run({ findingIds: [ID_1, ID_2] })],
      [
        // A review of another commit does not count, even with the same id.
        { pr: 7, sha: SHA_B, findings: [{ ...posted, message: 'Wrong commit.' }] },
        { pr: 7, sha: SHA_A, findings: [posted] },
      ],
    );

    expect(result.added).toEqual([ID_1]);
    expect(result.unrecoverable).toEqual([{ findingId: ID_2, pr: 7, sha: SHA_A }]);
    expect(result.file.findings).toEqual([
      row({
        file: 'a.ts',
        line: 2,
        message: 'Posted.',
        coverage: { files: 4, omittedFiles: 1, shortenedPatches: 2 },
        promptVersion: 4,
      }),
    ]);
    expect(parseVerdictFile(result.file).ok).toBe(true);
  });

  it('refreshes the machine columns from the run and never touches the hand-kept ones', () => {
    const stale = row({ coverage: null, promptVersion: null, verdict: 'real', note: 'kept' });
    const gone = row({ findingId: ID_2, coverage: null, promptVersion: 2 });

    const result = syncVerdictFile(file({ findings: [stale, gone] }), [run()], []);

    expect(result.updated).toEqual([ID_1]);
    expect(result.file.findings).toEqual([
      { ...stale, coverage: { files: 4, omittedFiles: 1, shortenedPatches: 2 }, promptVersion: 4 },
      // Its run is no longer on record, so it keeps what it has.
      gone,
    ]);
  });
});

describe('summarising the verdicts', () => {
  it('counts every judged posting, inherited verdicts included, per prompt version', () => {
    const summary = summarizeVerdicts(
      file({
        findings: [
          row({ verdict: 'real' }),
          row({ findingId: ID_2, sha: SHA_B, sameAs: ID_1, promptVersion: 3 }),
          row({ findingId: ID_3, severity: 'minor', verdict: null }),
        ],
        legacy: [
          legacy({ verdict: 'false positive' }),
          legacy({ ref: 'legacy-2', verdict: 'unsure' }),
        ],
      }),
      null,
    );

    expect(summary.rowsWithVerdict).toBe(2);
    expect(summary.reRaised).toBe(1);
    expect(summary.precision).toEqual({ real: 2, falsePositive: 1, unsure: 1 });
    expect(summary.precisionByPrompt).toEqual([
      { promptVersion: 1, precision: { real: 0, falsePositive: 1, unsure: 1 } },
      { promptVersion: 3, precision: { real: 1, falsePositive: 0, unsure: 0 } },
      { promptVersion: 4, precision: { real: 1, falsePositive: 0, unsure: 0 } },
    ]);
    expect(summary.reconciliation).toBeNull();
  });

  it('computes misses from the ground truth, and recall only over independent reads', () => {
    const summary = summarizeVerdicts(
      file({
        findings: [row({ verdict: 'real' })],
        legacy: [legacy({ pr: 9 })],
        groundTruth: [
          {
            pr: 7,
            readIndependently: true,
            note: '',
            defects: [
              {
                id: 'found',
                severity: 'major',
                file: null,
                description: 'x',
                shownToModel: true,
                foundBy: [ID_1],
              },
              {
                id: 'missed',
                severity: 'major',
                file: null,
                description: 'x',
                shownToModel: null,
                foundBy: [],
              },
              {
                id: 'unseen',
                severity: 'minor',
                file: 'z.ts',
                description: 'x',
                shownToModel: false,
                foundBy: [],
              },
            ],
          },
        ],
      }),
      null,
    );

    expect(summary.misses).toMatchObject({
      missed: 1,
      missedUnseen: 1,
      defects: 3,
      found: 1,
      independentPrs: 1,
      independentDefects: 3,
      independentFound: 1,
      prsWithoutGroundTruth: [9],
    });
  });

  it('reconciles the file against the run data', () => {
    const summary = summarizeVerdicts(
      file({
        findings: [row({ verdict: 'real' }), row({ findingId: ID_3, pr: 99 })],
        legacy: [legacy()],
      }),
      [
        // An older line: its findings have no ids.
        run({
          v: 2,
          pr: 5,
          sha: SHA_B,
          findingIds: null,
          kept: { blocker: 0, major: 2, minor: 1, nit: 0 },
        }),
        // Two runs of one commit; the latest counts for the posted total.
        run({ findingIds: [ID_1, ID_2], kept: { blocker: 0, major: 2, minor: 0, nit: 0 } }),
        run({ findingIds: [ID_1] }),
      ],
    );

    expect(summary.reconciliation).toEqual({
      posted: 4,
      postedWithIds: 1,
      postedWithoutIds: 3,
      identified: 2,
      identifiedWithVerdict: 1,
      identifiedUnadjudicated: 1,
      notInFile: 1,
      rowsNotInRunData: 1,
      legacyRows: 1,
    });
  });
});

describe('rendering the verdict report', () => {
  const context = { command: 'pnpm qa:verdicts', filePath: 'backend/qa/verdicts.json' };

  it('escapes the model text, so a message cannot add a cell or a row', () => {
    const report = renderVerdictReport(
      file({ findings: [row({ message: 'a | b\n| forged | row |', verdict: 'real' })] }),
      [run()],
      context,
    );

    const line = report.split('\n').find((candidate) => candidate.includes(ID_1)) ?? '';
    expect(line).toContain('a \\| b \\| forged \\| row \\|');
    expect(report).not.toContain('\n| forged');
  });

  it('marks an unadjudicated row and a re-raised one, and states the reconciliation', () => {
    const report = renderVerdictReport(
      file({
        findings: [
          row({ verdict: 'real' }),
          row({ findingId: ID_2, sha: SHA_B, sameAs: ID_1 }),
          row({ findingId: ID_3, severity: 'nit' }),
        ],
      }),
      [run({ findingIds: [ID_1, ID_3] })],
      context,
    );

    expect(report).toContain('| #7 | `aaaaaaa` | v4 | 3/4, 2 shortened | major |');
    expect(report).toContain(`real (as \`${ID_1}\`) | Re-raises \`${ID_1}\`.`);
    expect(report).toContain('_unadjudicated_');
    expect(report).toContain('| ... with a verdict | 1 |');
    expect(report).toContain('| ... unadjudicated | 1 |');
    expect(report).toContain('| Rows in the file whose id no loaded run logged | 1 |');
  });

  it('says when it was rendered without run data, and that misses are a floor', () => {
    const report = renderVerdictReport(file(), null, context);

    expect(report).toContain('Run data was not loaded');
    expect(report).toContain('this is a floor, not a measurement');
    expect(report).toContain('_No findings with an id are in the file yet.');
  });
});
