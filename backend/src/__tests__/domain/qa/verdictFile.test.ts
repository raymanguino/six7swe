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
      '**Blocker/major:** 3 real of 7 (1 unsure, left out of the percentage) -- 42.9%, against a target of at least 80%',
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
    ).toContain('judged "false positive"; only a real or useful finding can have found a defect');
    expect(
      errorsOf(file({ findings: [row({ verdict: 'unsure' })], groundTruth: [truth([ID_1])] }))[0],
    ).toContain('judged "unsure"; only a real or useful finding');
    expect(errorsOf(file({ findings: [row()], groundTruth: [truth([ID_1])] }))[0]).toContain(
      'is not judged; only a real or useful finding',
    );
    expect(errorsOf(file({ legacy: [legacy()], groundTruth: [truth(['legacy-1'])] }))[0]).toContain(
      'is a finding on #5, not #7',
    );
    expect(
      errorsOf(file({ findings: [row({ verdict: 'real' })], groundTruth: [truth([ID_1, ID_1])] })),
    ).toEqual([`groundTruth.0.defects.0.foundBy: ${ID_1} is listed more than once`]);
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

  it('reads back a path with a backslash before a pipe, as the body escapes it', () => {
    const findings: ReviewFinding[] = [
      { severity: 'major', file: 'a\\|b', line: 4, message: 'Odd \\| name.' },
    ];
    const [id] = findingIds({ pr: 7, sha: SHA_A }, findings, hashData);

    expect(parseAgentReview(body(findings))?.findings).toEqual([
      {
        findingId: id,
        severity: 'major',
        steering: false,
        file: 'a\\|b',
        line: 4,
        message: 'Odd \\| name.',
      },
    ]);
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

  it('never replaces a value the row has with one the run did not record', () => {
    const entered = row({ coverage: { files: 9, omittedFiles: 0, shortenedPatches: 0 } });
    const run4 = run({ v: 4, promptVersion: null, omittedFiles: null, shortenedPatches: null });

    const result = syncVerdictFile(file({ findings: [entered] }), [run4], []);

    expect(result.updated).toEqual([]);
    expect(result.file.findings).toEqual([entered]);
  });

  it('reports a row whose pull request or commit is not the run that logged its id', () => {
    const wrong = row({ sha: SHA_B, coverage: null });

    const result = syncVerdictFile(file({ findings: [wrong] }), [run()], []);

    expect(result.mismatched).toEqual([
      { findingId: ID_1, row: { pr: 7, sha: SHA_B }, run: { pr: 7, sha: SHA_A } },
    ]);
    expect(result.file.findings).toEqual([wrong]);
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

    expect(summary.misses).toEqual({
      independentPrs: [7],
      independent: { defects: 3, found: 1, missed: 1, missedUnseen: 1 },
      noticedOnlyPrs: [],
      noticedOnly: { defects: 0, found: 0, missed: 0, missedUnseen: 0 },
      prsWithoutGroundTruth: [9],
    });
  });

  it('keeps the misses of a pull request not read independently out of the measurement', () => {
    const mixed = file({
      groundTruth: [
        {
          pr: 8,
          readIndependently: false,
          note: '',
          defects: [
            {
              id: 'noticed',
              severity: 'major',
              file: null,
              description: 'x',
              shownToModel: true,
              foundBy: [],
            },
          ],
        },
        { pr: 7, readIndependently: true, note: '', defects: [] },
      ],
    });
    const summary = summarizeVerdicts(mixed, null);

    expect(summary.misses.independentPrs).toEqual([7]);
    expect(summary.misses.independent.missed).toBe(0);
    expect(summary.misses.noticedOnlyPrs).toEqual([8]);
    expect(summary.misses.noticedOnly.missed).toBe(1);

    const report = renderVerdictReport(mixed, null, { command: 'x', filePath: 'y' });
    expect(report).toContain(
      '**Missed:** 0 missed, 0 missed (unseen), over the 1 pull request(s) read independently of the agent (#7).',
    );
    expect(report).toContain(
      '**Noticed only:** 1 defect(s) recorded, 0 found by the agent, 1 missed, 0 missed (unseen), in #8, which were not read independently.',
    );
    expect(report).toContain('this is a floor, not a measurement');
  });

  it('reports recall over every defect and over the files the model was shown', () => {
    const defect = (id: string, shownToModel: boolean, foundBy: string[]) => ({
      id,
      severity: 'major' as const,
      file: null,
      description: 'x',
      shownToModel,
      foundBy,
    });
    const report = renderVerdictReport(
      file({
        findings: [row({ verdict: 'real' })],
        groundTruth: [
          {
            pr: 7,
            readIndependently: true,
            note: '',
            defects: [
              defect('found', true, [ID_1]),
              defect('missed', true, []),
              defect('unseen', false, []),
            ],
          },
        ],
      }),
      null,
      { command: 'x', filePath: 'y' },
    );

    expect(report).toContain(
      '**Recall:** 1 of 3 defects found (33.3%); 1 of 2 among the files the model was shown (50.0%).',
    );
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
    expect(report).toContain('**Missed:** not measured.');
    expect(report).toContain('_No findings with an id are in the file yet.');
  });

  it('renders model text as a code span, so a mention or a link stays inert', () => {
    const report = renderVerdictReport(
      file({
        findings: [
          row({
            message: 'Ping @raymanguino, see https://example.com/x',
            file: 'src/@scope/a.ts',
          }),
        ],
      }),
      null,
      context,
    );

    expect(report).toContain('`Ping @raymanguino, see https://example.com/x`');
    expect(report).toContain('`src/@scope/a.ts:3`');
  });

  it('strips bidi and zero-width characters from what it renders', () => {
    const invisible = [0x202e, 0x200b, 0x2066, 0xfeff, 0x00ad, 0x180e, 0xfe0f].map((code) =>
      String.fromCharCode(code),
    );
    const hidden = `a${invisible[0]}b${invisible[1]}c${invisible[2]}d${invisible[3]}e${invisible.slice(4).join('')}`;
    const report = renderVerdictReport(
      file({
        findings: [row({ message: hidden, note: hidden, verdict: 'real' })],
        notes: [hidden],
      }),
      null,
      context,
    );

    for (const char of invisible) expect(report).not.toContain(char);
    expect(report).toContain('`abcde`');
  });

  it('prints percentages to one decimal place, so a near miss is not rounded onto the target', () => {
    const findings = [
      ...['0', '1', '2', '3'].map((n) =>
        row({ findingId: `${n}123456789abcdee`, verdict: 'real' }),
      ),
      row({ findingId: '4123456789abcdee', verdict: 'false positive' }),
    ];
    const legacyRows = Array.from({ length: 44 }, (_, index) =>
      legacy({ ref: `legacy-${index + 1}`, verdict: index < 35 ? 'real' : 'false positive' }),
    );

    // 39 real of 49: 79.6%, below the 80% target.
    expect(renderVerdictReport(file({ findings, legacy: legacyRows }), null, context)).toContain(
      '39 real of 49 -- 79.6%, against a target of at least 80%',
    );
  });

  it('marks a prompt version this checkout does not know, rather than dropping the row', () => {
    const report = renderVerdictReport(
      file({ findings: [row({ promptVersion: 99, verdict: 'real' })] }),
      null,
      context,
    );

    expect(report).toContain('| v99 (unknown to this checkout, update) |');
    expect(report).toContain('v99 (unknown to this checkout, update): 1 real of 1');
  });

  it('says "no defects recorded" for pull requests not read independently that list none', () => {
    const report = renderVerdictReport(
      file({ groundTruth: [{ pr: 72, readIndependently: false, note: '', defects: [] }] }),
      null,
      context,
    );

    expect(report).toContain('**Noticed only:** no defects recorded, in #72,');
  });
});

describe('rendering hand-kept text', () => {
  const context = { command: 'x', filePath: 'y' };
  const hostile =
    'Ask @raymanguino, see [here](https://evil.example) and ![x](https://evil.example/i.png), <b>bold</b> <!-- hide';

  function render(overrides: Partial<VerdictFile>): string {
    return renderVerdictReport(file(overrides), null, context);
  }

  it('makes a mention, a link, an image and HTML inert in a table cell', () => {
    const report = render({ legacy: [legacy({ note: hostile })] });
    const line = report.split('\n').find((candidate) => candidate.startsWith('| legacy-1')) ?? '';

    expect(line).toContain('`@raymanguino`');
    expect(line).toContain('\\[here\\](`https://evil.example`)');
    expect(line).toContain('!\\[x\\](`https://evil.example/i.png`)');
    expect(line).toContain('\\<b\\>bold\\</b\\>');
    expect(line).toContain('\\<!-- hide');
    expect(line).not.toMatch(/(^|[^\\`])[<[]/);
  });

  it('does the same in the notes, and keeps code spans and emphasis readable', () => {
    const report = render({
      notes: [`**Bold** with \`a <tag> @inside\` and ${hostile}`, 'An unclosed ` tick <!--'],
    });

    expect(report).toContain('**Bold** with `a <tag> @inside` and Ask `@raymanguino`');
    expect(report).toContain('\\<!-- hide');
    expect(report).toContain('An unclosed \\` tick \\<!--');
  });
});
