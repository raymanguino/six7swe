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

/** A full commit sha that starts with `prefix`, as the script logs one. */
function sha(prefix: string): string {
  return prefix.padEnd(40, 'f');
}

function run(overrides: Partial<QaRunStats> = {}): QaRunStats {
  return {
    v: 5,
    pr: 1,
    sha: sha('aaa'),
    mode: 'comment-only',
    outcome: 'pass',
    enforceOutcome: 'pass',
    manualReviewReasons: [],
    promptVersion: 4,
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

/** A run as a line older than version 5 writes it: without the prompt version. */
function withoutPrompt(stats: QaRunStats): Omit<QaRunStats, 'promptVersion'> {
  const { promptVersion: _promptVersion, ...rest } = stats;
  return rest;
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
      enforceOutcome: _enforce,
      manualReviewReasons: _reasons,
      promptVersion: _prompt,
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
        enforceOutcome: null,
        manualReviewReasons: null,
        promptVersion: null,
      }),
    ]);
  });

  it('rejects a version 2 line without its coverage counts', () => {
    const {
      omittedFiles: _omitted,
      sanitized: _s,
      findingIds: _f,
      enforceOutcome: _e,
      manualReviewReasons: _r,
      promptVersion: _p,
      ...missing
    } = run({ v: 2 });

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
      run({ sha: sha('aaa'), reported: 1, kept: { blocker: 1, major: 0, minor: 0, nit: 0 } }),
      run({ sha: sha('bbb') }),
    ]);

    expect(summary.prs).toBe(1);
    expect(summary.commits).toBe(2);
    expect(summary.kept.blocker).toBe(1);
  });

  it('counts a pull request for each side it touched on any commit', () => {
    const summary = summarizeCalibration([
      run({ pr: 1, sha: sha('a'), backendFiles: 1, frontendFiles: 0 }),
      run({ pr: 1, sha: sha('b'), backendFiles: 0, frontendFiles: 3 }),
      run({ pr: 2, sha: sha('c'), backendFiles: 0, frontendFiles: 0 }),
    ]);

    expect(summary).toMatchObject({ prs: 2, backendPrs: 1, frontendPrs: 1 });
  });

  it('averages runtime and tokens, and leaves out what was not reported', () => {
    const summary = summarizeCalibration([
      run({
        sha: sha('a'),
        durationMs: 10_000,
        tokens: { prompt: 4000, completion: 1000, reasoning: null },
      }),
      run({
        sha: sha('b'),
        durationMs: 30_000,
        tokens: { prompt: 8000, completion: 3000, reasoning: 2000 },
      }),
      run({ sha: sha('c'), durationMs: 20_000, tokens: null }),
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
      run({
        pr: i + 1,
        sha: sha(String(i)),
        backendFiles: i < 5 ? 1 : 0,
        frontendFiles: i < 4 ? 1 : 0,
      }),
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
    const {
      sanitized: _s,
      findingIds: _f,
      enforceOutcome: _e,
      manualReviewReasons: _r,
      promptVersion: _p,
      ...v2
    } = run({ v: 2 });

    expect(parseStatsLines(`QA_STATS ${JSON.stringify(v2)}`)).toEqual([
      run({
        v: 2,
        sanitized: null,
        findingIds: null,
        enforceOutcome: null,
        manualReviewReasons: null,
        promptVersion: null,
      }),
    ]);
  });

  it('sums each reason separately and reports each under its own label', () => {
    const summary = summarizeCalibration([
      run({ sha: sha('a'), sanitized: counts }),
      run({ sha: sha('b'), sanitized: counts }),
      run({ sha: sha('c'), sanitized: null }),
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

describe('the outcome if enforced', () => {
  const major = { blocker: 0, major: 1, minor: 0, nit: 0 };

  it('round-trips through the stats line', () => {
    const stats = run({ enforceOutcome: 'manual-review' });
    const { v: _v, ...rest } = stats;

    expect(parseStatsLines(formatStatsLine(rest))).toEqual([stats]);
  });

  it('reads a version 3 line with it as null', () => {
    const { enforceOutcome: _e, manualReviewReasons: _r, ...v3 } = withoutPrompt(run({ v: 3 }));

    expect(parseStatsLines(`QA_STATS ${JSON.stringify(v3)}`)).toEqual([
      run({ v: 3, enforceOutcome: null, manualReviewReasons: null, promptVersion: null }),
    ]);
  });

  it('rejects an older line that carries it, and a value that is not an outcome', () => {
    const lines = [
      `QA_STATS ${JSON.stringify(withoutPrompt(run({ v: 3, enforceOutcome: 'fail' })))}`,
      `QA_STATS ${JSON.stringify({ ...run(), enforceOutcome: 'block' })}`,
    ].join('\n');

    expect(parseStatsLines(lines)).toEqual([]);
  });

  it('is reported next to the real outcome, with the commits it would have blocked', () => {
    const summary = summarizeCalibration([
      run({ sha: sha('a000000'), enforceOutcome: 'pass' }),
      run({ sha: sha('b000000'), enforceOutcome: 'fail', reported: 1, kept: major }),
      run({ sha: sha('c000000'), enforceOutcome: 'manual-review' }),
      run({ sha: sha('d000000'), enforceOutcome: null }),
      run({
        sha: sha('e000000'),
        outcome: 'fail-closed',
        enforceOutcome: 'fail-closed',
        reported: null,
        kept: null,
      }),
    ]);

    expect(summary.enforceOutcomes).toEqual({
      pass: 1,
      fail: 1,
      'manual-review': 1,
      'fail-closed': 1,
    });
    expect(summary.withoutEnforceOutcome).toBe(1);
    expect(summary.enforceDecided).toBe(3);
    expect(summary.wouldBlock.map((commit) => [commit.sha, commit.cause])).toEqual([
      [sha('b000000'), 'blocking-finding'],
      [sha('c000000'), 'protected-path'],
    ]);

    const report = renderCalibrationReport(summary, CONTEXT);
    expect(report).toContain(
      '| Gate outcomes (comment-only) | 4 pass, 0 fail, 0 manual-review, 1 fail-closed |',
    );
    expect(report).toContain(
      '| Gate outcomes (if enforced) | 1 pass, 1 fail, 1 manual-review, 1 fail-closed |',
    );
    expect(report).toContain(
      '| Would have blocked if enforced | 2 of 3 (66.7%): 1 fail, 1 manual-review |',
    );
    expect(report).toContain('- #1 `b000000`: fail (blocking finding), findings 1 major');
    expect(report).toContain('- #1 `c000000`: manual-review (protected path), findings none');
    expect(report).toContain('verdict table on #59');
    expect(report).toContain('1 review(s) recorded no outcome if enforced');
  });

  it('reports no data when no run recorded it', () => {
    const report = renderCalibrationReport(
      summarizeCalibration([run({ enforceOutcome: null })]),
      CONTEXT,
    );

    expect(report).toContain('| Gate outcomes (if enforced) | no data |');
    expect(report).toContain('| Would have blocked if enforced | no data |');
  });

  it('labels the real outcome row "as run" when the modes differ', () => {
    const report = renderCalibrationReport(
      summarizeCalibration([run({ sha: sha('a') }), run({ sha: sha('b'), mode: 'enforce' })]),
      CONTEXT,
    );

    expect(report).toContain('| Gate outcomes (as run) |');
  });
});

describe('commits reviewed more than once', () => {
  const major = { blocker: 0, major: 1, minor: 0, nit: 0 };
  const minor = { blocker: 0, major: 0, minor: 1, nit: 0 };

  it('counts the commits whose enforce outcome or findings changed, and names them', () => {
    const summary = summarizeCalibration([
      // Flipped: the same commit failed, then passed.
      run({ sha: sha('a000000'), enforceOutcome: 'fail', reported: 1, kept: major }),
      run({ sha: sha('a000000'), enforceOutcome: 'pass', reported: 1, kept: minor }),
      // Stable.
      run({ sha: sha('b000000'), enforceOutcome: 'pass' }),
      run({ sha: sha('b000000'), enforceOutcome: 'pass' }),
      // Older lines: no enforce outcome, but the findings can still be compared.
      run({ sha: sha('c000000'), v: 3, enforceOutcome: null, kept: major }),
      run({ sha: sha('c000000'), v: 3, enforceOutcome: null, kept: minor }),
      // A failed run reached no verdict, so it is not compared.
      run({
        sha: sha('d000000'),
        outcome: 'fail-closed',
        enforceOutcome: 'fail-closed',
        reported: null,
        kept: null,
      }),
      run({ sha: sha('d000000'), enforceOutcome: 'pass' }),
      // Reviewed once.
      run({ sha: sha('e000000') }),
    ]);

    expect(summary.commits).toBe(5);
    expect(summary.rereviewed.map((commit) => [commit.sha, commit.runs])).toEqual([
      [sha('a000000'), 2],
      [sha('b000000'), 2],
      [sha('c000000'), 2],
      [sha('d000000'), 2],
    ]);
    expect(summary.rereviewed.map((commit) => commit.outcomeChanged)).toEqual([
      true,
      false,
      null,
      null,
    ]);
    expect(summary.rereviewed.map((commit) => commit.findingsChanged)).toEqual([
      true,
      false,
      true,
      null,
    ]);

    const report = renderCalibrationReport(summary, CONTEXT);
    expect(report).toContain('| Commits reviewed more than once | 4 |');
    expect(report).toContain('| ... outcome if enforced changed between runs | 1 of 2 (50.0%) |');
    expect(report).toContain(
      '| ... findings changed between runs (count by severity) | 2 of 3 (66.7%) |',
    );
    expect(report).toContain(
      '- #1 `a000000`: 2 runs; if enforced fail -> pass (changed); findings 1 major -> 1 minor (changed)',
    );
    expect(report).toContain('- #1 `c000000`: 2 runs; if enforced not recorded (not comparable)');
  });

  it('does not echo a sha that is not hex into the report', () => {
    const report = renderCalibrationReport(
      summarizeCalibration([run({ sha: '<img>' }), run({ sha: '<img>' })]),
      CONTEXT,
    );

    expect(report).not.toContain('<img>');
    expect(report).toContain('(unreadable sha)');
  });
});

describe('enforce outcomes across re-runs and line versions', () => {
  const major = { blocker: 0, major: 1, minor: 0, nit: 0 };
  const line = (value: unknown): string => `QA_STATS ${JSON.stringify(value)}`;

  it('rejects a version 4 line without an enforce outcome, or with a null one', () => {
    const { enforceOutcome: _e, ...missing } = run();

    expect(
      parseStatsLines([line(missing), line(run({ enforceOutcome: null }))].join('\n')),
    ).toEqual([]);
  });

  it('rejects a version 3 line that carries an enforce outcome, even a null one', () => {
    expect(parseStatsLines(line(withoutPrompt(run({ v: 3, enforceOutcome: 'pass' }))))).toEqual([]);
    expect(parseStatsLines(line(withoutPrompt(run({ v: 3, enforceOutcome: null }))))).toEqual([]);
  });

  it('rejects a sha that is short or not hex, and lowercases a full one', () => {
    const upper = sha('ABC').toUpperCase();
    const log = [
      line(run({ sha: 'abc123' })),
      line(run({ sha: 'z'.repeat(40) })),
      line(run({ sha: `${sha('a')}0` })),
      line(run({ sha: upper })),
    ].join('\n');

    expect(parseStatsLines(log)).toEqual([run({ sha: upper.toLowerCase() })]);
  });

  it('counts a re-run of one commit with differently cased shas as one commit', () => {
    const log = [line(run({ sha: sha('abc') })), line(run({ sha: sha('abc').toUpperCase() }))].join(
      '\n',
    );

    expect(summarizeCalibration(parseStatsLines(log)).commits).toBe(1);
  });

  it('reads a history that mixes version 3 and current lines', () => {
    const {
      enforceOutcome: _e,
      manualReviewReasons: _r,
      ...v3
    } = withoutPrompt(run({ v: 3, sha: sha('a') }));
    const v4 = run({ sha: sha('b'), enforceOutcome: 'fail', reported: 1, kept: major });
    const { v: _v, ...v4Stats } = v4;

    const runs = parseStatsLines([line(v3), formatStatsLine(v4Stats)].join('\n'));
    expect(runs).toEqual([
      run({
        v: 3,
        sha: sha('a'),
        enforceOutcome: null,
        manualReviewReasons: null,
        promptVersion: null,
      }),
      v4,
    ]);

    const summary = summarizeCalibration(runs);
    expect(summary.commits).toBe(2);
    expect(summary.withoutEnforceOutcome).toBe(1);
    expect(summary.enforceDecided).toBe(1);

    const report = renderCalibrationReport(summary, CONTEXT);
    expect(report).toContain(
      '| Gate outcomes (if enforced) | 0 pass, 1 fail, 0 manual-review, 0 fail-closed |',
    );
    expect(report).toContain(
      '| Would have blocked if enforced | 1 of 1 (100.0%): 1 fail, 0 manual-review |',
    );
    expect(report).toContain('1 review(s) recorded no outcome if enforced');
  });

  it('keeps an earlier block when the re-run of the commit failed closed', () => {
    const summary = summarizeCalibration([
      run({ sha: sha('a'), enforceOutcome: 'fail', reported: 1, kept: major }),
      run({
        sha: sha('a'),
        outcome: 'fail-closed',
        enforceOutcome: 'fail-closed',
        reported: null,
        kept: null,
      }),
      run({ sha: sha('b'), enforceOutcome: 'pass' }),
    ]);

    // The real outcome still counts the latest run.
    expect(summary.outcomes['fail-closed']).toBe(1);
    // The enforce rows count the latest run that reached a verdict.
    expect(summary.enforceOutcomes).toEqual({
      pass: 1,
      fail: 1,
      'manual-review': 0,
      'fail-closed': 0,
    });
    expect(summary.enforceDecided).toBe(2);
    expect(summary.wouldBlock.map((commit) => commit.sha)).toEqual([sha('a')]);
    expect(renderCalibrationReport(summary, CONTEXT)).toContain(
      'the rows about enforce mode use its latest run that reached a verdict',
    );
  });

  it('falls back to the latest run when no run of the commit reached a verdict', () => {
    const failed = {
      outcome: 'fail-closed',
      enforceOutcome: 'fail-closed',
      reported: null,
      kept: null,
    } as const;
    const summary = summarizeCalibration([run(failed), run(failed)]);

    expect(summary.enforceOutcomes['fail-closed']).toBe(1);
    expect(summary.enforceDecided).toBe(0);
  });

  it('splits the blocks by outcome and names the cause of each', () => {
    const summary = summarizeCalibration([
      run({ sha: sha('a'), enforceOutcome: 'fail', reported: 1, kept: major }),
      run({ sha: sha('b'), enforceOutcome: 'manual-review', omittedFiles: 0 }),
      run({ sha: sha('c'), enforceOutcome: 'manual-review', omittedFiles: 4 }),
      run({ sha: sha('d'), enforceOutcome: 'pass' }),
    ]);

    expect(summary.wouldBlock.map((commit) => commit.cause)).toEqual([
      'blocking-finding',
      'protected-path',
      'protected-path-or-partial-coverage',
    ]);

    const report = renderCalibrationReport(summary, CONTEXT);
    expect(report).toContain(
      '| Would have blocked if enforced | 3 of 4 (75.0%): 1 fail, 2 manual-review |',
    );
    expect(report).toContain('- #1 `affffff`: fail (blocking finding), findings 1 major');
    expect(report).toContain('manual-review (protected path or partial coverage)');
  });
});

describe('the manual-review reasons in the stats line', () => {
  const line = (value: unknown): string => `QA_STATS ${JSON.stringify(value)}`;

  it('round-trips the reasons', () => {
    const stats = run({
      enforceOutcome: 'manual-review',
      manualReviewReasons: ['protected-path', 'partial-coverage'],
    });
    const { v: _v, ...rest } = stats;

    expect(parseStatsLines(formatStatsLine(rest))).toEqual([stats]);
  });

  it('rejects an unknown reason, a repeated one, or a list that is not one', () => {
    const log = [
      line(run({ manualReviewReasons: ['flaky' as never] })),
      line(run({ manualReviewReasons: ['protected-path', 'protected-path'] })),
      line({ ...run(), manualReviewReasons: 'protected-path' }),
    ].join('\n');

    expect(parseStatsLines(log)).toEqual([]);
  });

  it('requires the reasons on a version 4 line unless the review failed closed', () => {
    const { manualReviewReasons: _r, ...missing } = run();
    const failed = run({
      outcome: 'fail-closed',
      enforceOutcome: 'fail-closed',
      manualReviewReasons: null,
      reported: null,
      kept: null,
    });

    expect(parseStatsLines(line(missing))).toEqual([]);
    expect(parseStatsLines(line(run({ manualReviewReasons: null })))).toEqual([]);
    expect(parseStatsLines(line(failed))).toEqual([failed]);
  });

  it('rejects an older line that carries them', () => {
    const { enforceOutcome: _e, ...v3 } = run({ v: 3 });

    expect(parseStatsLines(line(v3))).toEqual([]);
    expect(parseStatsLines(line({ ...v3, manualReviewReasons: null }))).toEqual([]);
  });

  it('names the recorded cause of each block, before any inference', () => {
    const summary = summarizeCalibration([
      // Recorded: a protected path, though files were also omitted.
      run({
        sha: sha('a'),
        enforceOutcome: 'manual-review',
        omittedFiles: 3,
        manualReviewReasons: ['protected-path', 'partial-coverage'],
      }),
      // Recorded: partial coverage only.
      run({
        sha: sha('b'),
        enforceOutcome: 'manual-review',
        omittedFiles: 3,
        manualReviewReasons: ['partial-coverage'],
      }),
      // Older line: inferred from the omitted files.
      run({
        sha: sha('c'),
        v: 3,
        enforceOutcome: 'manual-review',
        omittedFiles: 3,
        manualReviewReasons: null,
      }),
    ]);

    expect(summary.wouldBlock.map((commit) => commit.cause)).toEqual([
      'protected-path',
      'partial-coverage',
      'protected-path-or-partial-coverage',
    ]);

    const report = renderCalibrationReport(summary, CONTEXT);
    expect(report).toContain('- #1 `affffff`: manual-review (protected path)');
    expect(report).toContain('- #1 `bffffff`: manual-review (partial coverage)');
    expect(report).toContain('- #1 `cffffff`: manual-review (protected path or partial coverage)');
  });
});

describe('the prompt version in the stats line', () => {
  const line = (value: unknown): string => `QA_STATS ${JSON.stringify(value)}`;

  it('round-trips through the stats line', () => {
    const stats = run({ promptVersion: 7 });
    const { v: _v, ...rest } = stats;

    expect(parseStatsLines(formatStatsLine(rest))).toEqual([stats]);
  });

  it('reads a version 4 line with it as null', () => {
    expect(parseStatsLines(line(withoutPrompt(run({ v: 4 }))))).toEqual([
      run({ v: 4, promptVersion: null }),
    ]);
  });

  it('rejects a version 4 line that carries it, a current line without it, and a bad value', () => {
    const log = [
      line(run({ v: 4 })),
      line(withoutPrompt(run())),
      line(run({ promptVersion: 0 })),
      line({ ...run(), promptVersion: '4' }),
    ].join('\n');

    expect(parseStatsLines(log)).toEqual([]);
  });

  it('still requires the enforce outcome on a current line', () => {
    expect(parseStatsLines(line(run({ enforceOutcome: null })))).toEqual([]);
  });
});
