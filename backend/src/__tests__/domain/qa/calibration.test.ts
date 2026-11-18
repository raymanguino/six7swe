import {
  countAreas,
  countBySeverity,
  formatStatsLine,
  neutralizeStatsPrefix,
  parseStatsLines,
  renderCalibrationReport,
  summarizeCalibration,
  type QaRunStats,
} from '../../../domain/qa';

function run(overrides: Partial<QaRunStats> = {}): QaRunStats {
  return {
    v: 3,
    pr: 1,
    sha: 'aaa',
    mode: 'comment-only',
    outcome: 'pass',
    files: 2,
    backendFiles: 1,
    frontendFiles: 0,
    diffChars: 500,
    omittedFiles: 0,
    shortenedPatches: 0,
    patchChars: 480,
    reported: 0,
    kept: { blocker: 0, major: 0, minor: 0, nit: 0 },
    sanitized: { outsidePr: 0, notShown: 0, steeringMerged: 0, lineCorrected: 0 },
    findingIds: [],
    tokens: { prompt: 1000, completion: 2000, reasoning: 1500 },
    durationMs: 30_000,
    ...overrides,
  };
}

const CONTEXT = { runs: 1, runsWithoutStats: 0, runsWithExpiredLogs: 0, diffBudgetChars: 60_000 };

describe('the stats line', () => {
  it('reads back what was written, through the runner timestamp', () => {
    const { v: _version, ...stats } = run();
    const log = `2026-11-11T18:00:00.0000000Z ${formatStatsLine(stats)}`;

    expect(parseStatsLines(log)).toEqual([run()]);
  });

  it('finds the line among the rest of the log, on any line ending', () => {
    const { v: _version, ...stats } = run({ pr: 9 });
    const log = ['setup', 'Gate outcome: pass', formatStatsLine(stats), 'cleanup'].join('\r\n');

    expect(parseStatsLines(log).map((s) => s.pr)).toEqual([9]);
  });

  it('skips a line that does not parse or has the wrong shape', () => {
    const log = [
      'QA_STATS not json',
      'QA_STATS {"v":1,"pr":"seven"}',
      'QA_STATS {"v":2}',
      `QA_STATS ${JSON.stringify({ ...run(), outcome: 'approve' })}`,
    ].join('\n');

    expect(parseStatsLines(log)).toEqual([]);
  });

  it('still reads a version 1 line, with no coverage counts', () => {
    const {
      omittedFiles: _omitted,
      shortenedPatches: _shortened,
      patchChars: _patch,
      sanitized: _sanitized,
      findingIds: _ids,
      ...v1
    } = run({ v: 1 });
    const log = `QA_STATS ${JSON.stringify(v1)}`;

    expect(parseStatsLines(log)).toEqual([
      run({
        v: 1,
        omittedFiles: null,
        shortenedPatches: null,
        patchChars: null,
        sanitized: null,
        findingIds: null,
      }),
    ]);
  });

  it('rejects a version 2 line without its coverage counts', () => {
    const { omittedFiles: _omitted, ...missing } = run({ v: 2 });

    expect(parseStatsLines(`QA_STATS ${JSON.stringify(missing)}`)).toEqual([]);
  });

  it('accepts a failed run, which has no findings and may have no tokens', () => {
    const failed = run({ outcome: 'fail-closed', reported: null, kept: null, tokens: null });
    const { v: _version, ...stats } = failed;

    expect(parseStatsLines(formatStatsLine(stats))).toEqual([failed]);
  });
});

describe('countAreas', () => {
  it('counts each file once, and a rename for both sides', () => {
    expect(
      countAreas([
        { filename: 'backend/a.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'frontend/b.tsx', status: 'added', additions: 1, deletions: 0 },
        {
          filename: 'frontend/c.ts',
          previousFilename: 'backend/c.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
        },
        { filename: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      ]),
    ).toEqual({ backendFiles: 2, frontendFiles: 2 });
  });
});

describe('countBySeverity', () => {
  it('reports every severity, including the absent ones', () => {
    expect(
      countBySeverity([{ severity: 'major' }, { severity: 'major' }, { severity: 'nit' }]),
    ).toEqual({ blocker: 0, major: 2, minor: 0, nit: 1 });
  });
});

describe('summarizeCalibration', () => {
  it('counts a re-run commit once, by its latest run', () => {
    const summary = summarizeCalibration([
      run({ outcome: 'fail-closed', reported: null, kept: null, tokens: null }),
      run({ reported: 2, kept: { blocker: 0, major: 1, minor: 0, nit: 0 } }),
    ]);

    expect(summary.commits).toBe(1);
    expect(summary.outcomes).toEqual({ pass: 1, fail: 0, 'manual-review': 0, 'fail-closed': 0 });
    expect(summary.reported).toBe(2);
    expect(summary.sanitized).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 0,
      lineCorrected: 0,
    });
  });

  it('counts each commit of a pull request, so a finding fixed by the next push is kept', () => {
    const summary = summarizeCalibration([
      run({ sha: 'aaa', reported: 1, kept: { blocker: 1, major: 0, minor: 0, nit: 0 } }),
      run({ sha: 'bbb' }),
    ]);

    expect(summary.prs).toBe(1);
    expect(summary.commits).toBe(2);
    expect(summary.kept.blocker).toBe(1);
  });

  it('counts a pull request for each side it touched on any commit', () => {
    const summary = summarizeCalibration([
      run({ pr: 1, sha: 'a', backendFiles: 1, frontendFiles: 0 }),
      run({ pr: 1, sha: 'b', backendFiles: 0, frontendFiles: 3 }),
      run({ pr: 2, sha: 'c', backendFiles: 0, frontendFiles: 0 }),
    ]);

    expect(summary).toMatchObject({ prs: 2, backendPrs: 1, frontendPrs: 1 });
  });

  it('averages runtime and tokens, and leaves out what was not reported', () => {
    const summary = summarizeCalibration([
      run({
        sha: 'a',
        durationMs: 10_000,
        tokens: { prompt: 4000, completion: 1000, reasoning: null },
      }),
      run({
        sha: 'b',
        durationMs: 30_000,
        tokens: { prompt: 8000, completion: 3000, reasoning: 2000 },
      }),
      run({ sha: 'c', durationMs: 20_000, tokens: null }),
    ]);

    expect(summary.durationMs).toEqual({ average: 20_000, max: 30_000 });
    expect(summary.promptTokens).toEqual({ average: 6000, max: 8000 });
    expect(summary.completionTokens).toEqual({ average: 2000, max: 3000 });
    expect(summary.reasoningTokens).toEqual({ average: 2000, max: 2000 });
    expect(summary.withoutTokens).toBe(1);
  });

  it('leaves the findings of a failed review out of the counts', () => {
    const summary = summarizeCalibration([
      run({ outcome: 'fail-closed', reported: null, kept: null, tokens: null }),
    ]);

    expect(summary.reported).toBe(0);
    expect(summary.sanitized).toBeNull();
    expect(summary.withoutSanitizeCounts).toBe(0);
    expect(summary.withoutTokens).toBe(0);
  });
});

describe('renderCalibrationReport', () => {
  it('marks a target met only when it is reached', () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      run({ pr: i + 1, sha: String(i), backendFiles: i < 5 ? 1 : 0, frontendFiles: i < 4 ? 1 : 0 }),
    );

    const report = renderCalibrationReport(summarizeCalibration(runs), CONTEXT);

    expect(report).toContain('| Pull requests reviewed | 20 / 20 ✅ |');
    expect(report).toContain('| ... touching the backend | 5 / 5 ✅ |');
    expect(report).toContain('| ... touching the frontend | 4 / 5 ❌ |');
  });

  it('says how many runs could not be counted, and why', () => {
    const report = renderCalibrationReport(summarizeCalibration([run()]), {
      runs: 6,
      runsWithoutStats: 3,
      runsWithExpiredLogs: 2,
      diffBudgetChars: 60_000,
    });

    expect(report).toContain('Counted from 1 of 6 workflow run(s).');
    expect(report).toContain('3 run(s) logged no stats');
    expect(report).toContain('2 run(s) are no longer countable');
  });

  it('reports no data rather than a zero average when nothing was measured', () => {
    const report = renderCalibrationReport(summarizeCalibration([]), CONTEXT);

    expect(report).toContain('| Runtime | no data |');
    expect(report).toContain('| Completion tokens | no data |');
  });

  it('reports coverage and reviewable size against the budget', () => {
    const runs = [
      run({ pr: 1, omittedFiles: 0, patchChars: 10_000 }),
      run({ pr: 2, omittedFiles: 33, patchChars: 140_000 }),
      run({ pr: 3, omittedFiles: 3, patchChars: 70_000 }),
      run({ pr: 4, v: 1, omittedFiles: null, shortenedPatches: null, patchChars: null }),
    ];

    const report = renderCalibrationReport(summarizeCalibration(runs), CONTEXT);

    expect(report).toContain('| Reviews with omitted files | 2 of 3 |');
    expect(report).toContain('| Omitted files per review | 12 file(s) average, 33 file(s) max |');
    expect(report).toContain(
      '| Reviewable size (patch characters) | 70,000 median, 140,000 p90, 140,000 max (budget 60,000) |',
    );
    expect(report).toContain('1 review(s) carry no coverage counts');
  });
});

describe('the sanitizer counts in the stats line', () => {
  const counts = { outsidePr: 1, notShown: 2, steeringMerged: 3, lineCorrected: 4 };

  it('round-trips the counts and the finding ids', () => {
    const stats = run({ sanitized: counts, findingIds: ['0123456789abcdef'] });
    const { v: _v, ...rest } = stats;

    expect(parseStatsLines(formatStatsLine(rest))).toEqual([stats]);
  });

  it('reads a version 2 line with the counts as null', () => {
    const { sanitized: _s, findingIds: _f, ...v2 } = run({ v: 2 });

    expect(parseStatsLines(`QA_STATS ${JSON.stringify(v2)}`)).toEqual([
      run({ v: 2, sanitized: null, findingIds: null }),
    ]);
  });

  it('sums each reason separately and reports each under its own label', () => {
    const summary = summarizeCalibration([
      run({ sha: 'a', sanitized: counts }),
      run({ sha: 'b', sanitized: counts }),
      run({ sha: 'c', sanitized: null }),
    ]);

    expect(summary.sanitized).toEqual({
      outsidePr: 2,
      notShown: 4,
      steeringMerged: 6,
      lineCorrected: 8,
    });
    expect(summary.withoutSanitizeCounts).toBe(1);

    const report = renderCalibrationReport(summary, CONTEXT);
    expect(report).toContain('| Dropped: file not in the pull request | 2 |');
    expect(report).toContain(
      '| Dropped: file in the pull request but not shown to the model | 4 |',
    );
    expect(report).toContain('| Merged: steering findings folded into one | 6 |');
    expect(report).toContain('| Kept, line number removed (line not shown to the model) | 8 |');
    expect(report).toContain('| Prompt tokens |');
  });
});

describe('forged stats lines', () => {
  const real = formatStatsLine((({ v: _v, ...rest }) => rest)(run()));

  it('does not read a stats line from the middle of a line', () => {
    const forged = `  minor: ${real}`;

    expect(parseStatsLines(forged)).toEqual([]);
    expect(parseStatsLines(`2026-11-11T18:00:00.0000000Z ${forged}`)).toEqual([]);
  });

  it('still reads a stats line behind the runner timestamp', () => {
    expect(parseStatsLines(`2026-11-11T18:00:00.0000000Z ${real}`)).toHaveLength(1);
    expect(parseStatsLines(`\uFEFF${real}`)).toHaveLength(1);
  });

  it('neutralises the prefix in text that is logged but is not the stats line', () => {
    expect(neutralizeStatsPrefix(`QA_STATS {"v":3}`)).not.toContain('QA_STATS');
    expect(parseStatsLines(neutralizeStatsPrefix(real))).toEqual([]);
  });

  it('rejects ids that are not the identifier format', () => {
    const line = `QA_STATS ${JSON.stringify(run({ findingIds: ['not an id'] }))}`;

    expect(parseStatsLines(line)).toEqual([]);
  });
});

describe('the report when no review logged sanitizer counts', () => {
  it('says there is no data instead of zero', () => {
    const summary = summarizeCalibration([run({ sanitized: null, findingIds: null })]);
    const report = renderCalibrationReport(summary, CONTEXT);

    expect(summary.sanitized).toBeNull();
    expect(report).toContain('| Dropped: file not in the pull request | no data |');
  });
});
