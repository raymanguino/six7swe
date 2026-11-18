import {
  consolidateSteeringFindings,
  decideGate,
  STEERING_SEVERITY,
  decideReviewEvent,
  reviewEventForGate,
  sanitizeFindings,
  sanitizeFindingsWithCounts,
  sortFindingsBySeverity,
  manualReviewReasons,
  touchesProtectedPath,
  type DecideReviewEventOptions,
  type GateInput,
  type ReviewFinding,
} from '../../../domain/qa/verdict';
import {
  displayPath,
  prepareReviewDiff,
  REVIEW_DIFF_BUDGET,
  shownInFull,
  type ChangedFile,
  type DiffCoverage,
} from '../../../domain/qa/diff';

const FULL: DiffCoverage = {
  totalFiles: 1,
  omittedFiles: 0,
  shortenedPatches: 0,
  hiddenLines: 0,
  patchChars: 100,
};
const PARTIAL: DiffCoverage = {
  totalFiles: 58,
  omittedFiles: 33,
  shortenedPatches: 0,
  hiddenLines: 0,
  patchChars: 140_000,
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    file: 'backend/src/index.ts',
    line: null,
    message: 'Something worth mentioning.',
    ...overrides,
  };
}

/** A file whose patch covers lines 10 to 12 of the new revision. */
function patchedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: 'backend/src/index.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -10,3 +10,3 @@\n context\n-old\n+new\n more',
    ...overrides,
  };
}

describe('decideReviewEvent', () => {
  it('comments by default, whatever the findings are', () => {
    expect(decideReviewEvent([])).toBe('COMMENT');
    expect(decideReviewEvent([finding()])).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'blocker' })])).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'major' })])).toBe('COMMENT');
  });

  it('never approves, not even for a clean pull request in enforce mode', () => {
    expect(decideReviewEvent([], 'enforce')).toBe('COMMENT');
    expect(decideReviewEvent([finding({ severity: 'nit' })], 'enforce')).toBe('COMMENT');
  });

  it('requests changes for a blocking finding in enforce mode', () => {
    expect(
      decideReviewEvent([finding({ severity: 'major' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('REQUEST_CHANGES');
    expect(
      decideReviewEvent([finding({ severity: 'blocker' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('REQUEST_CHANGES');
  });

  it('does not request changes for a minor or a nit in enforce mode', () => {
    expect(
      decideReviewEvent([finding({ severity: 'minor' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('COMMENT');
    expect(
      decideReviewEvent([finding({ severity: 'nit' })], 'enforce', {
        changedFiles: [patchedFile()],
      }),
    ).toBe('COMMENT');
  });

  it('does not request changes for a finding about a file outside the diff', () => {
    expect(
      decideReviewEvent(
        [finding({ severity: 'blocker', file: 'backend/src/made-up.ts' })],
        'enforce',
        {
          changedFiles: [patchedFile()],
        },
      ),
    ).toBe('COMMENT');
  });

  it('does not request changes when a protected path was touched', () => {
    const event = decideReviewEvent([], 'enforce', {
      changedFiles: [
        {
          filename: '.github/workflows/qa-review.yml',
          status: 'modified',
          additions: 1,
          deletions: 1,
        },
      ],
    });

    expect(event).toBe('COMMENT');
  });
});

describe('reviewEventForGate', () => {
  it('requests changes only for a failing gate', () => {
    expect(reviewEventForGate('fail')).toBe('REQUEST_CHANGES');
  });

  it('comments for every other outcome', () => {
    expect(reviewEventForGate('pass')).toBe('COMMENT');
    expect(reviewEventForGate('manual-review')).toBe('COMMENT');
    expect(reviewEventForGate('fail-closed')).toBe('COMMENT');
  });
});

describe('decideGate', () => {
  it('fails closed when the review could not be completed', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [],
        shown: shownInFull([]),
        mode: 'comment-only',
        reviewCompleted: false,
        coverage: FULL,
      }),
    ).toBe('fail-closed');

    expect(
      decideGate({
        findings: [],
        changedFiles: [],
        shown: shownInFull([]),
        mode: 'enforce',
        reviewCompleted: false,
        coverage: FULL,
      }),
    ).toBe('fail-closed');
  });

  it('fails closed even when the findings look clean', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'nit' })],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: false,
        coverage: FULL,
      }),
    ).toBe('fail-closed');
  });

  it('passes for every input in comment-only mode', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [],
        shown: shownInFull([]),
        mode: 'comment-only',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');

    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: [
          {
            filename: '.github/workflows/qa-review.yml',
            status: 'modified',
            additions: 1,
            deletions: 1,
          },
        ],
        shown: [],
        mode: 'comment-only',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');
  });

  it('passes a clean pull request in enforce mode', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');
  });

  it('passes when only minor and nit findings are present in enforce mode', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'minor' }), finding({ severity: 'nit' })],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');
  });

  it('fails on a blocking finding in enforce mode', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'major' })],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('fail');

    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('fail');
  });

  it('asks for a human when a protected path was touched', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [
          {
            filename: '.github/workflows/qa-review.yml',
            status: 'modified',
            additions: 1,
            deletions: 1,
          },
        ],
        shown: [],
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('manual-review');
  });

  it('asks for a human even when the model found a blocker', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'blocker' })],
        changedFiles: [
          { filename: 'package.json', status: 'modified', additions: 1, deletions: 1 },
        ],
        shown: [],
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('manual-review');
  });

  it('asks for a human when a protected file was moved out of a protected directory', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [
          {
            filename: 'backend/src/qa/verdict.ts',
            previousFilename: 'backend/src/domain/qa/verdict.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
          },
        ],
        shown: [],
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('manual-review');
  });

  it('does not let a hallucinated path fail the gate', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'blocker', file: 'backend/src/made-up.ts' })],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');
  });

  it('accepts a custom protected path list', () => {
    expect(
      decideGate({
        findings: [],
        changedFiles: [
          { filename: 'docs/readme.md', status: 'modified', additions: 1, deletions: 1 },
        ],
        shown: [],
        mode: 'enforce',
        protectedPaths: ['docs/**'],
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('manual-review');
  });
});

describe('sanitizeFindings', () => {
  const changedFiles = [
    { filename: 'backend/src/index.ts', status: 'modified', additions: 1, deletions: 1 },
    { filename: 'backend/src/routes/portfolio.ts', status: 'modified', additions: 1, deletions: 1 },
  ];

  it('drops a finding that references a file outside the diff', () => {
    const findings = [finding({ file: 'backend/src/does-not-exist.ts' })];

    expect(sanitizeFindings(findings, shownInFull(changedFiles))).toEqual([]);
  });

  it('keeps a finding that references a file in the diff', () => {
    const kept = finding({ file: 'backend/src/routes/portfolio.ts' });

    expect(sanitizeFindings([kept], shownInFull(changedFiles))).toEqual([kept]);
  });

  it('keeps findings without a file', () => {
    const general = finding({ file: null, line: null });

    expect(sanitizeFindings([general], shownInFull(changedFiles))).toEqual([general]);
  });

  it('preserves the order of the findings that survive', () => {
    const first = finding({ file: 'backend/src/index.ts', message: 'first' });
    const dropped = finding({ file: 'nope.ts', message: 'dropped' });
    const last = finding({ file: null, message: 'last' });

    expect(sanitizeFindings([first, dropped, last], shownInFull(changedFiles))).toEqual([
      first,
      last,
    ]);
  });

  it('keeps a finding whose line is part of the diff', () => {
    const onLine = finding({ file: 'backend/src/index.ts', line: 11 });

    expect(sanitizeFindings([onLine], shownInFull([patchedFile()]))).toEqual([onLine]);
  });

  it('clears a line that the diff does not contain but keeps the finding', () => {
    const wrongLine = finding({ file: 'backend/src/index.ts', line: 999 });

    expect(sanitizeFindings([wrongLine], shownInFull([patchedFile()]))).toEqual([
      { ...wrongLine, line: null, correctedFromLine: 999 },
    ]);
  });

  it('clears a line on a file that has no patch at all', () => {
    const noPatch = finding({ file: 'backend/src/index.ts', line: 4 });

    expect(sanitizeFindings([noPatch], shownInFull(changedFiles))).toEqual([
      { ...noPatch, line: null, correctedFromLine: 4 },
    ]);
  });

  it('keeps a finding about the path a file was moved from', () => {
    const moved = [
      {
        filename: 'backend/src/qa/verdict.ts',
        previousFilename: 'backend/src/domain/qa/verdict.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
    ];

    expect(
      sanitizeFindings([finding({ file: 'backend/src/domain/qa/verdict.ts' })], shownInFull(moved)),
    ).toHaveLength(1);
  });
});

describe('sanitizeFindings against the budgeted diff', () => {
  // Every patch line plus its "\n" is 10 characters after a 16-character
  // hunk header, so a per-file budget of 67 shows lines 1 to 5 only.
  const longPatch = [
    '@@ -0,0 +1,20 @@',
    ...Array.from({ length: 20 }, (_, i) => `+line-${String(i + 1).padStart(3, '0')}`),
  ].join('\n');

  const shortened = patchedFile({ filename: 'backend/src/long.ts', patch: longPatch });
  const kept = patchedFile({ filename: 'backend/src/kept.ts' });
  const omitted = patchedFile({ filename: 'backend/src/omitted.ts', patch: 'x'.repeat(500) });
  const changedFiles = [shortened, kept, omitted];
  const budget = { perFileChars: 67, totalChars: 340, skipPatchesFor: [] };
  const prepared = prepareReviewDiff(changedFiles, budget);

  it('is set up with one shortened patch and one omitted file', () => {
    expect(prepared.coverage.shortenedPatches).toBe(1);
    expect(prepared.coverage.omittedFiles).toBe(1);
    expect(prepared.shown.map((entry) => entry.filename)).not.toContain('backend/src/omitted.ts');
  });

  it('drops a finding on a file that was omitted from the diff', () => {
    const onOmitted = finding({ file: 'backend/src/omitted.ts' });

    expect(sanitizeFindings([onOmitted], prepared.shown)).toEqual([]);
    // The full pull request would have kept it: the file is in it.
    expect(sanitizeFindings([onOmitted], shownInFull(changedFiles))).toEqual([onOmitted]);
  });

  it('clears the line of a finding on a line that was truncated away', () => {
    const pastTheCut = finding({ file: 'backend/src/long.ts', line: 18 });

    expect(sanitizeFindings([pastTheCut], prepared.shown)).toEqual([
      { ...pastTheCut, line: null, correctedFromLine: 18 },
    ]);
    expect(sanitizeFindings([pastTheCut], shownInFull(changedFiles))).toEqual([pastTheCut]);
  });

  it('keeps the line of a finding on a line the shortened patch still shows', () => {
    const beforeTheCut = finding({ file: 'backend/src/long.ts', line: 5 });

    expect(sanitizeFindings([beforeTheCut], prepared.shown)).toEqual([beforeTheCut]);
  });

  it('keeps a steering finding on an omitted file, as a general finding', () => {
    const onOmitted = finding({ kind: 'steering', file: 'backend/src/omitted.ts', line: 1 });

    expect(sanitizeFindings([onOmitted], prepared.shown)).toEqual([
      { ...onOmitted, severity: STEERING_SEVERITY, file: null, line: null },
    ]);
  });

  it('does not let a blocker on an omitted file fail the gate', () => {
    const input: GateInput = {
      findings: [finding({ severity: 'blocker', file: 'backend/src/omitted.ts' })],
      changedFiles,
      shown: prepared.shown,
      mode: 'enforce',
      reviewCompleted: true,
      coverage: prepared.coverage,
    };

    // Partial coverage still needs a human; it is not a failure.
    expect(decideGate(input)).toBe('manual-review');
    expect(decideGate({ ...input, shown: shownInFull(changedFiles) })).toBe('fail');
  });

  it('still fails the gate on a blocker in a shortened file, without its line', () => {
    expect(
      decideGate({
        findings: [finding({ severity: 'blocker', file: 'backend/src/long.ts', line: 18 })],
        changedFiles,
        shown: prepared.shown,
        mode: 'enforce',
        reviewCompleted: true,
        coverage: prepared.coverage,
      }),
    ).toBe('fail');
  });

  it('defaults decideReviewEvent to every changed file shown in full only without coverage', () => {
    const blocker = finding({ severity: 'blocker', file: 'backend/src/omitted.ts' });

    expect(decideReviewEvent([blocker], 'enforce', { changedFiles: [omitted] })).toBe(
      'REQUEST_CHANGES',
    );
    expect(decideReviewEvent([blocker], 'enforce', { changedFiles: [omitted], shown: [] })).toBe(
      'COMMENT',
    );
    expect(
      decideReviewEvent([blocker], 'enforce', {
        changedFiles,
        coverage: prepared.coverage,
        shown: prepared.shown,
      }),
    ).toBe('COMMENT');
  });

  it('requires shown whenever decideReviewEvent is given a coverage', () => {
    // A coverage that says files were omitted must not be paired with a
    // default that treats every file as shown.
    // @ts-expect-error `shown` is required alongside `coverage`.
    const options: DecideReviewEventOptions = { changedFiles, coverage: prepared.coverage };

    expect(options.coverage).toBe(prepared.coverage);
  });
});

describe('sanitizeFindings: path spellings and renames', () => {
  it('keeps a finding written with the displayed spelling of a path with a newline', () => {
    const raw = 'backend/src/odd\nname.ts';
    const changed = [patchedFile({ filename: raw })];
    const { shown, text } = prepareReviewDiff(changed, REVIEW_DIFF_BUDGET);
    const displayed = displayPath(raw);

    expect(displayed).toBe('backend/src/odd\\u000aname.ts');
    expect(text).toContain(`### ${displayed} (`);

    const blocker = finding({ severity: 'blocker', file: displayed, line: 11 });
    expect(sanitizeFindings([blocker], shown)).toEqual([blocker]);
    expect(sanitizeFindings([{ ...blocker, file: raw }], shown)).toEqual([
      { ...blocker, file: raw },
    ]);
    expect(
      decideGate({
        findings: [blocker],
        changedFiles: changed,
        shown,
        mode: 'enforce',
        reviewCompleted: true,
        coverage: { ...FULL, totalFiles: 1 },
      }),
    ).toBe('fail');
  });

  it('lets a current filename win over another file’s old path', () => {
    // a.ts was renamed to b.ts, and a new a.ts was added.
    const renamed = patchedFile({
      filename: 'backend/src/b.ts',
      previousFilename: 'backend/src/a.ts',
      patch: '@@ -1,2 +1,2 @@\n x\n+y',
    });
    const recreated = patchedFile({ filename: 'backend/src/a.ts' });
    const shown = shownInFull([renamed, recreated]);

    // Line 11 is in the new a.ts's hunk (10-12), not in b.ts's (1-2).
    const onNew = finding({ file: 'backend/src/a.ts', line: 11 });
    expect(sanitizeFindings([onNew], shown)).toEqual([onNew]);
  });

  it('clears the line of a finding on an old path whose re-created file was dropped', () => {
    const renamed = patchedFile({
      filename: 'backend/src/b.ts',
      previousFilename: 'backend/src/a.ts',
      patch: '@@ -1,2 +1,2 @@\n x\n+y',
    });
    const recreated = patchedFile({
      filename: 'backend/src/a.ts',
      patch: `@@ -0,0 +1,3 @@\n+${'z'.repeat(400)}`,
    });
    const prepared = prepareReviewDiff([renamed, recreated], {
      perFileChars: 1_000,
      totalChars: 200,
      skipPatchesFor: [],
    });

    expect(prepared.coverage.omittedFiles).toBe(1);
    expect(prepared.shown.map((entry) => entry.filename)).toEqual(['backend/src/b.ts']);

    // Line 1 is a line of b.ts, the new revision; it says nothing about a.ts.
    const onOldPath = finding({ file: 'backend/src/a.ts', line: 1 });
    expect(sanitizeFindings([onOldPath], prepared.shown)).toEqual([
      { ...onOldPath, line: null, correctedFromLine: 1 },
    ]);
  });
});

describe('sortFindingsBySeverity', () => {
  it('puts the most serious findings first', () => {
    const sorted = sortFindingsBySeverity([
      finding({ severity: 'nit' }),
      finding({ severity: 'major' }),
      finding({ severity: 'minor' }),
      finding({ severity: 'blocker' }),
    ]);

    expect(sorted.map((entry) => entry.severity)).toEqual(['blocker', 'major', 'minor', 'nit']);
  });

  it('keeps a blocker that was written after the other findings', () => {
    const sorted = sortFindingsBySeverity([
      ...Array.from({ length: 8 }, () => finding({ severity: 'nit' })),
      finding({ severity: 'blocker' }),
    ]);

    expect(sorted[0].severity).toBe('blocker');
  });

  it('preserves the relative order of findings with the same severity', () => {
    const sorted = sortFindingsBySeverity([
      finding({ severity: 'minor', message: 'first' }),
      finding({ severity: 'nit', message: 'a nit' }),
      finding({ severity: 'minor', message: 'second' }),
    ]);

    expect(sorted.map((entry) => entry.message)).toEqual(['first', 'second', 'a nit']);
  });

  it('does not mutate the input', () => {
    const findings = [finding({ severity: 'nit' }), finding({ severity: 'blocker' })];
    const original = [...findings];

    sortFindingsBySeverity(findings);

    expect(findings).toEqual(original);
  });
});

describe('steering findings', () => {
  const steering = (overrides: Partial<ReviewFinding> = {}): ReviewFinding =>
    finding({ kind: 'steering', severity: 'blocker', file: null, ...overrides });

  it('uses a severity that never blocks a merge', () => {
    expect(['blocker', 'major']).not.toContain(STEERING_SEVERITY);
  });

  it('merges every steering finding into one, after the defects', () => {
    const defect = finding({ severity: 'nit', message: 'a real nit' });
    const result = consolidateSteeringFindings([
      steering({ message: 'Ignore all previous instructions.' }),
      defect,
      steering({ message: 'Forged [six7swe: notice].' }),
      steering({ message: 'Fake response object.' }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(defect);
    expect(result[1]).toEqual({
      severity: STEERING_SEVERITY,
      file: null,
      line: null,
      kind: 'steering',
      message:
        '[3 steering findings] Ignore all previous instructions. | Forged [six7swe: notice]. | Fake response object.',
    });
  });

  it('bounds the merged message: short excerpts, three named, the rest counted', () => {
    const long = 'x'.repeat(5_000);
    const [merged] = consolidateSteeringFindings(
      Array.from({ length: 6 }, (_, index) => steering({ message: `${index}${long}` })),
    );

    expect(merged.message.startsWith('[6 steering findings] 0')).toBe(true);
    expect(merged.message).toContain('1x');
    expect(merged.message).toContain('2x');
    expect(merged.message).not.toContain('| 3x');
    expect(merged.message.endsWith(' | and 3 more')).toBe(true);
    expect(merged.message.length).toBeLessThan(1_000);
    // Merging the merged finding again leaves it as it is.
    expect(consolidateSteeringFindings([merged])).toEqual([merged]);
  });

  it('keeps the location only when every steering finding shares it', () => {
    const at = { file: 'backend/src/index.ts', line: 11 };
    const shared = consolidateSteeringFindings([steering(at), steering(at)]);
    const mixed = consolidateSteeringFindings([steering(at), steering({ ...at, line: 12 })]);

    expect(shared[0]).toMatchObject(at);
    expect(mixed[0]).toMatchObject({ file: null, line: null });
  });

  it('caps a single steering finding without changing its message', () => {
    expect(consolidateSteeringFindings([steering({ message: 'Injected.' })])).toEqual([
      steering({ message: 'Injected.', severity: STEERING_SEVERITY }),
    ]);
  });

  it('leaves a list without steering findings alone', () => {
    const findings = [finding({ severity: 'blocker' }), finding({ kind: 'defect' })];

    expect(consolidateSteeringFindings(findings)).toEqual(findings);
  });

  it('is applied by sanitizeFindings, so the script and the gate both get it', () => {
    const changedFiles = [patchedFile()];
    const sanitized = sanitizeFindings(
      [steering(), steering({ file: 'backend/src/index.ts', line: 11 })],
      shownInFull(changedFiles),
    );

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].severity).toBe(STEERING_SEVERITY);
    // Sanitizing twice, as the script and the gate do, changes nothing more.
    expect(sanitizeFindings(sanitized, shownInFull(changedFiles))).toEqual(sanitized);
  });

  it('keeps a steering finding whose file is outside the diff, as a general finding', () => {
    const sanitized = sanitizeFindings(
      [
        steering({ file: 'pull-request-description.md', line: 3, message: 'Injected.' }),
        finding({ file: 'backend/src/not-in-diff.ts' }),
      ],
      shownInFull([patchedFile()]),
    );

    expect(sanitized).toEqual([
      {
        ...steering({ message: 'Injected.' }),
        severity: STEERING_SEVERITY,
        file: null,
        line: null,
      },
    ]);
  });

  it('passes the enforce gate with only a blocker-rated steering finding', () => {
    expect(
      decideGate({
        findings: [steering({ severity: 'blocker' })],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');
  });

  it('cannot fail the enforce gate on its own, however it was rated', () => {
    expect(
      decideGate({
        findings: [steering(), steering({ severity: 'major' }), steering()],
        changedFiles: [patchedFile()],
        shown: shownInFull([patchedFile()]),
        mode: 'enforce',
        reviewCompleted: true,
        coverage: FULL,
      }),
    ).toBe('pass');
  });

  it('does not hide a real blocker in the same pull request', () => {
    const findings = [
      ...Array.from({ length: 10 }, () => steering()),
      finding({ severity: 'blocker', message: 'real defect' }),
    ];
    const input: GateInput = {
      findings,
      changedFiles: [patchedFile()],
      shown: shownInFull([patchedFile()]),
      mode: 'enforce',
      reviewCompleted: true,
      coverage: FULL,
    };

    expect(decideGate(input)).toBe('fail');

    const shown = sortFindingsBySeverity(sanitizeFindings(findings, shownInFull([patchedFile()])));
    expect(shown.map((entry) => entry.message)[0]).toBe('real defect');
    expect(shown).toHaveLength(2);
  });

  it('sorts a steering finding after every defect, even a nit', () => {
    const sorted = sortFindingsBySeverity([
      steering({ severity: 'minor', message: 'steering' }),
      finding({ severity: 'nit', message: 'nit' }),
      finding({ severity: 'major', message: 'major' }),
    ]);

    expect(sorted.map((entry) => entry.message)).toEqual(['major', 'nit', 'steering']);
  });
});

describe('touchesProtectedPath', () => {
  it('matches a workflow file against the workflows glob', () => {
    expect(touchesProtectedPath(['.github/workflows/qa-review.yml'])).toBe(true);
    expect(touchesProtectedPath(['.github/workflows/ci.yml'])).toBe(true);
  });

  it('does not match an ordinary source file', () => {
    expect(touchesProtectedPath(['backend/src/routes/portfolio.ts'])).toBe(false);
    expect(touchesProtectedPath(['frontend/src/App.tsx'])).toBe(false);
  });

  it('does not match the agent code against the workflows glob', () => {
    expect(
      touchesProtectedPath(['backend/src/domain/qa/verdict.ts'], ['.github/workflows/**']),
    ).toBe(false);
  });

  it('matches the agent code and the client it uses', () => {
    expect(touchesProtectedPath(['backend/src/domain/qa/diff.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/services/github/prClient.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/services/ai/prReview.ts'])).toBe(true);
  });

  it('matches the review script', () => {
    expect(touchesProtectedPath(['backend/scripts/review-pr.ts'])).toBe(true);
  });

  it('matches the schema, the migrations and the auth code', () => {
    expect(touchesProtectedPath(['backend/src/db/schema/jobHunt.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/migrations/0001_new.sql'])).toBe(true);
    expect(touchesProtectedPath(['backend/drizzle.config.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/plugins/auth.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/config/auth.ts'])).toBe(true);
  });

  it('matches the dependency manifests at the root and in the backend', () => {
    expect(touchesProtectedPath(['package.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/package.json'])).toBe(true);
    expect(touchesProtectedPath(['pnpm-lock.yaml'])).toBe(true);
    expect(touchesProtectedPath(['pnpm-workspace.yaml'])).toBe(true);
    expect(touchesProtectedPath(['.npmrc'])).toBe(true);
  });

  it('matches the build and test configuration', () => {
    expect(touchesProtectedPath(['backend/tsconfig.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/tsconfig.scripts.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/tsconfig.test.json'])).toBe(true);
    expect(touchesProtectedPath(['tsconfig.base.json'])).toBe(true);
    expect(touchesProtectedPath(['backend/jest.config.js'])).toBe(true);
    expect(touchesProtectedPath(['eslint.config.js'])).toBe(true);
  });

  it('matches a pattern that names a directory without a glob', () => {
    expect(
      touchesProtectedPath(['backend/src/db/schema/users.ts'], ['backend/src/db/schema']),
    ).toBe(true);
  });

  it('does not match a prefix of a longer path', () => {
    expect(
      touchesProtectedPath(['backend/src/services/ai-extra/x.ts'], ['backend/src/services/ai']),
    ).toBe(false);
  });

  it('matches a single star within one segment only', () => {
    expect(touchesProtectedPath(['backend/src/ai.ts'], ['backend/src/*.ts'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/ai/prReview.ts'], ['backend/src/*.ts'])).toBe(false);
  });

  it('matches everything with a bare glob', () => {
    expect(touchesProtectedPath(['anything/at/all.ts'], ['**'])).toBe(true);
    expect(touchesProtectedPath(['backend/src/index.ts'], ['**'])).toBe(true);
  });

  it('returns false for an empty file list', () => {
    expect(touchesProtectedPath([])).toBe(false);
  });
});

describe('decideGate with partial coverage', () => {
  const changedFiles: ChangedFile[] = [
    {
      filename: 'backend/src/services/thing.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    },
  ];

  function gate(overrides: Partial<GateInput> = {}): ReturnType<typeof decideGate> {
    return decideGate({
      findings: [],
      changedFiles,
      shown: shownInFull(changedFiles),
      mode: 'enforce',
      reviewCompleted: true,
      coverage: FULL,
      ...overrides,
    });
  }

  it('needs a human in enforce mode when files were omitted and nothing blocks', () => {
    expect(gate({ coverage: PARTIAL })).toBe('manual-review');
    expect(
      gate({
        coverage: PARTIAL,
        findings: [finding({ severity: 'minor', file: 'backend/src/services/thing.ts' })],
      }),
    ).toBe('manual-review');
  });

  it('still fails on a blocking finding in the files that were read', () => {
    expect(
      gate({
        coverage: PARTIAL,
        findings: [finding({ severity: 'major', file: 'backend/src/services/thing.ts' })],
      }),
    ).toBe('fail');
  });

  it('passes in comment-only mode whatever the coverage', () => {
    expect(gate({ mode: 'comment-only', coverage: PARTIAL })).toBe('pass');
  });

  it('passes when nothing was omitted and nothing blocks', () => {
    expect(gate()).toBe('pass');
  });

  it('does not let shortened patches change the outcome', () => {
    expect(gate({ coverage: { ...FULL, shortenedPatches: 5 } })).toBe('pass');
  });

  it('is still fail-closed when the review did not complete', () => {
    expect(gate({ coverage: PARTIAL, reviewCompleted: false })).toBe('fail-closed');
  });

  it('defaults to full coverage in decideReviewEvent, and honours a partial one', () => {
    expect(decideReviewEvent([], 'enforce', { changedFiles })).toBe('COMMENT');
    expect(
      decideReviewEvent(
        [finding({ severity: 'major', file: changedFiles[0].filename })],
        'enforce',
        {
          changedFiles,
          coverage: PARTIAL,
          shown: shownInFull(changedFiles),
        },
      ),
    ).toBe('REQUEST_CHANGES');
  });
});

describe('manualReviewReasons', () => {
  const plain: ChangedFile = {
    filename: 'backend/src/services/thing.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
  };
  const guarded: ChangedFile = { ...plain, filename: '.github/workflows/qa-review.yml' };

  it('names nothing for a complete review of ordinary files', () => {
    expect(manualReviewReasons({ changedFiles: [plain], coverage: FULL })).toEqual([]);
  });

  it('names each cause, and both when both apply', () => {
    expect(manualReviewReasons({ changedFiles: [plain], coverage: PARTIAL })).toEqual([
      'partial-coverage',
    ]);
    expect(manualReviewReasons({ changedFiles: [guarded], coverage: FULL })).toEqual([
      'protected-path',
    ]);
    expect(manualReviewReasons({ changedFiles: [guarded], coverage: PARTIAL })).toEqual([
      'protected-path',
      'partial-coverage',
    ]);
  });

  it('ignores shortened patches', () => {
    expect(
      manualReviewReasons({ changedFiles: [plain], coverage: { ...FULL, shortenedPatches: 3 } }),
    ).toEqual([]);
  });
});

describe('sanitizeFindingsWithCounts', () => {
  const files = [patchedFile(), patchedFile({ filename: 'backend/src/omitted.ts' })];
  const shown = shownInFull([files[0]]);

  function steering(message: string): ReviewFinding {
    return finding({ file: null, kind: 'steering', severity: 'blocker', message });
  }

  it('counts each reason under its own name', () => {
    const reported = [
      finding({ file: 'nowhere.ts' }),
      finding({ file: 'backend/src/omitted.ts' }),
      finding({ file: 'backend/src/index.ts', line: 999 }),
      finding({ file: 'backend/src/index.ts', line: 11 }),
      steering('one'),
      steering('two'),
      steering('three'),
    ];
    const result = sanitizeFindingsWithCounts(reported, shown, files);

    expect(result.counts).toEqual({
      outsidePr: 1,
      notShown: 1,
      steeringMerged: 2,
      lineCorrected: 1,
    });
    // reported = kept + every loss; a corrected line is kept, so not a loss.
    const { outsidePr, notShown, steeringMerged } = result.counts;
    expect(reported.length).toBe(result.findings.length + outsidePr + notShown + steeringMerged);
  });

  it('does not count a steering finding or a corrected line as outside the diff', () => {
    const result = sanitizeFindingsWithCounts(
      [steering('a'), steering('b'), finding({ file: 'backend/src/index.ts', line: 999 })],
      shown,
      files,
    );

    expect(result.counts).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 1,
      lineCorrected: 1,
    });
  });

  it('counts a corrected line once, from what is kept, not from what was merged', () => {
    const onLine = (message: string): ReviewFinding =>
      finding({
        file: 'backend/src/index.ts',
        line: 999,
        kind: 'steering',
        severity: 'blocker',
        message,
      });

    const result = sanitizeFindingsWithCounts(
      [onLine('a'), onLine('b'), onLine('c')],
      shown,
      files,
    );

    expect(result.findings).toHaveLength(1);
    expect(result.counts).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 2,
      lineCorrected: 0,
    });

    // A single corrected steering finding is kept as it is, and counted.
    expect(sanitizeFindingsWithCounts([onLine('a')], shown, files).counts.lineCorrected).toBe(1);
  });

  it('keeps a steering finding on an unshown file or outside the pull request, uncounted', () => {
    const reported = [
      steering('x'),
      finding({ file: 'backend/src/omitted.ts', kind: 'steering', message: 'unshown' }),
      finding({ file: 'nowhere.ts', kind: 'steering', message: 'outside' }),
    ];
    const result = sanitizeFindingsWithCounts(reported, shown, files);

    expect(result.counts).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 2,
      lineCorrected: 0,
    });
    expect(reported.length).toBe(result.findings.length + 2);
  });

  it('keeps a defect with no file, and counts nothing', () => {
    const result = sanitizeFindingsWithCounts([finding({ file: null })], shown, files);

    expect(result.findings).toHaveLength(1);
    expect(result.counts).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 0,
      lineCorrected: 0,
    });
  });

  it('counts a rename old path as a corrected line, and a dropped renamed file as not shown', () => {
    const moved: ChangedFile = {
      filename: 'backend/src/new.ts',
      previousFilename: 'backend/src/old.ts',
      status: 'renamed',
      additions: 1,
      deletions: 1,
      patch: '@@ -1,1 +1,1 @@\n-a\n+b',
    };
    const gone = patchedFile({ filename: 'backend/src/gone.ts' });

    const result = sanitizeFindingsWithCounts(
      [
        finding({ file: 'backend/src/old.ts', line: 1 }),
        finding({ file: 'backend/src/gone.ts', line: 1 }),
      ],
      shownInFull([moved]),
      [moved, gone],
    );

    expect(result.counts).toEqual({
      outsidePr: 0,
      notShown: 1,
      steeringMerged: 0,
      lineCorrected: 1,
    });
  });

  it('accepts the displayed spelling of a path with a control character', () => {
    const odd = patchedFile({ filename: 'backend/src/odd\u001bname.ts' });
    const result = sanitizeFindingsWithCounts(
      [finding({ file: displayPath(odd.filename), line: 11 })],
      shownInFull([odd]),
      [odd],
    );

    expect(result.findings).toHaveLength(1);
    expect(result.counts).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 0,
      lineCorrected: 0,
    });
  });

  it('is idempotent: sanitizing its own output changes nothing and drops nothing more', () => {
    const first = sanitizeFindingsWithCounts(
      [
        finding({ file: 'nowhere.ts' }),
        finding({ file: 'backend/src/index.ts', line: 999 }),
        steering('a'),
        steering('b'),
      ],
      shown,
      files,
    );
    const second = sanitizeFindingsWithCounts(first.findings, shown, files);

    expect(second.findings).toEqual(first.findings);
    expect(second.counts).toEqual({
      outsidePr: 0,
      notShown: 0,
      steeringMerged: 0,
      lineCorrected: first.counts.lineCorrected,
    });
  });
});
