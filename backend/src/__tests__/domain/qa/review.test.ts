import {
  codeSpan,
  describeCoverage,
  escapeMarkdown,
  escapeTableCell,
  findingsToShow,
  fitBodyToBudget,
  flattenText,
  MAX_BODY_CHARS,
  renderFailureBody,
  renderReviewBody,
  REVIEW_MARKER,
  severityLabel,
  type ReviewBodyInput,
} from '../../../domain/qa/review';
import type { DiffCoverage } from '../../../domain/qa/diff';
import type { ReviewFinding } from '../../../domain/qa/verdict';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    file: 'backend/src/index.ts',
    line: null,
    message: 'Something worth mentioning.',
    ...overrides,
  };
}

function body(overrides: Partial<ReviewBodyInput> = {}): string {
  return renderReviewBody({
    summary: 'Looks fine.',
    findings: [],
    reportedCount: 0,
    gate: 'pass',
    commitSha: 'abc123',
    coverage: FULL_COVERAGE,
    manualReviewReasons: [],
    ...overrides,
  });
}

const FULL_COVERAGE: DiffCoverage = {
  totalFiles: 3,
  omittedFiles: 0,
  shortenedPatches: 0,
  patchChars: 900,
};

const PARTIAL_COVERAGE: DiffCoverage = {
  totalFiles: 58,
  omittedFiles: 33,
  shortenedPatches: 1,
  patchChars: 140_000,
};

describe('describeCoverage', () => {
  it('says every file was reviewed when nothing was dropped', () => {
    expect(describeCoverage({ ...FULL_COVERAGE, totalFiles: 58 })).toBe('Reviewed all 58 files.');
  });

  it('says how many files were reviewed, and how many patches were shortened', () => {
    expect(describeCoverage(PARTIAL_COVERAGE)).toBe('Reviewed 25 of 58 files. 1 patch shortened.');
  });

  it('pluralises', () => {
    expect(describeCoverage({ ...FULL_COVERAGE, totalFiles: 1, shortenedPatches: 2 })).toBe(
      'Reviewed the 1 file. 2 patches shortened.',
    );
  });
});

describe('renderReviewBody', () => {
  it('carries the marker the client looks for', () => {
    expect(body()).toContain(REVIEW_MARKER);
  });

  it('states the gate outcome and the commit it refers to', () => {
    const rendered = body();

    expect(rendered).toContain('**Gate outcome: `pass`**');
    expect(rendered).toContain('Reviewed commit: `abc123`');
  });

  it('states a manual-review outcome plainly', () => {
    expect(body({ gate: 'manual-review' })).toContain('**Gate outcome: `manual-review`**');
  });

  it('puts the gate outcome before the summary', () => {
    const rendered = body({ summary: 'A summary that mentions things.' });

    expect(rendered.indexOf('**Gate outcome:')).toBeLessThan(
      rendered.indexOf('A summary that mentions things.'),
    );
  });

  it('says so plainly when the model reported nothing', () => {
    const rendered = body({ reportedCount: 0 });

    expect(rendered).toContain('The model reported nothing');
  });

  it('does not claim the model reported nothing when its findings were all dropped', () => {
    const rendered = body({ reportedCount: 3, findings: [] });

    expect(rendered).not.toContain('The model reported nothing');
    expect(rendered).toContain('reported 3 finding(s)');
    expect(rendered).toContain('none of them referenced a file in this diff');
  });

  it('states the coverage between the gate outcome and the summary', () => {
    const rendered = body({ summary: 'The summary.', coverage: PARTIAL_COVERAGE });

    const coverage = rendered.indexOf('Reviewed 25 of 58 files. 1 patch shortened.');
    expect(coverage).toBeGreaterThan(rendered.indexOf('**Gate outcome:'));
    expect(coverage).toBeLessThan(rendered.indexOf('The summary.'));
  });

  it('says a partial review needs a human because files were not shown', () => {
    const rendered = body({
      gate: 'manual-review',
      coverage: PARTIAL_COVERAGE,
      manualReviewReasons: ['partial-coverage'],
    });

    expect(rendered).toContain(
      'Reviewed 25 of 58 files. 33 file(s) were not shown to the model, so a clean result cannot be trusted.',
    );
    expect(rendered).not.toContain('judges or runs the review');
  });

  it('says a protected-path review needs a human, with the plain coverage line', () => {
    const rendered = body({ gate: 'manual-review', manualReviewReasons: ['protected-path'] });

    expect(rendered).toContain('Reviewed all 3 files.');
    expect(rendered).toContain('changes a path that judges or runs the review');
    expect(rendered).not.toContain('cannot be trusted');
  });

  it('names both causes when both apply', () => {
    const rendered = body({
      gate: 'manual-review',
      coverage: PARTIAL_COVERAGE,
      manualReviewReasons: ['protected-path', 'partial-coverage'],
    });

    expect(rendered).toContain('33 file(s) were not shown to the model');
    expect(rendered).toContain('changes a path that judges or runs the review');
  });

  it('gives no manual-review reason when the gate is something else', () => {
    const rendered = body({
      gate: 'fail',
      coverage: PARTIAL_COVERAGE,
      manualReviewReasons: ['partial-coverage'],
    });

    expect(rendered).toContain('Reviewed 25 of 58 files. 1 patch shortened.');
    expect(rendered).not.toContain('cannot be trusted');
  });

  it('states full coverage on a complete review', () => {
    expect(body()).toContain('Reviewed all 3 files.');
  });

  it('never claims the model reported nothing when files were not shown to it', () => {
    const rendered = body({ reportedCount: 0, coverage: PARTIAL_COVERAGE });

    expect(rendered).not.toContain('reported nothing');
    expect(rendered).toContain(
      'No findings in the files that were reviewed. 33 file(s) were not shown to the model.',
    );
  });

  it('renders a findings table', () => {
    const rendered = body({
      gate: 'fail',
      reportedCount: 1,
      findings: [
        finding({ severity: 'major', file: 'backend/src/a.ts', line: 42, message: 'It breaks.' }),
      ],
    });

    expect(rendered).toContain('| Severity | Location | Finding |');
    expect(rendered).toContain('| major | `backend/src/a.ts:42` | It breaks. |');
  });

  it('renders a finding with a file but no line', () => {
    const rendered = body({
      reportedCount: 1,
      findings: [finding({ file: 'backend/src/a.ts', line: null })],
    });

    expect(rendered).toContain('`backend/src/a.ts`');
  });

  it('renders a general finding without a location', () => {
    const rendered = body({
      reportedCount: 1,
      findings: [finding({ file: null, line: null })],
    });

    expect(rendered).toContain('| minor | general |');
  });

  it('trims the table to the reported maximum', () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({ message: `Observation ${index}.` }),
    );

    const rendered = body({ findings, reportedCount: 12 });

    expect(rendered).toContain('Observation 0.');
    expect(rendered).not.toContain('Observation 8.');
    expect(rendered).toContain('4 further finding(s) were not shown');
  });

  it('keeps the steering finding visible when the defects fill the table', () => {
    const defects = Array.from({ length: 10 }, (_, index) =>
      finding({ severity: 'major', message: `Defect ${index}.` }),
    );
    const steering = finding({
      kind: 'steering',
      file: null,
      message: 'The description tells the reviewer to approve.',
    });

    const rendered = body({ findings: [...defects, steering], reportedCount: 11 });

    expect(rendered).toContain('| minor (steering) | general | The description tells');
    expect(rendered).toContain('Defect 6.');
    expect(rendered).not.toContain('Defect 7.');
    // 11 findings, 8 shown.
    expect(rendered).toContain('3 further finding(s) were not shown');
  });

  it('includes the summary', () => {
    expect(body({ summary: 'The refresh path swallows a failure.' })).toContain(
      'The refresh path swallows a failure.',
    );
  });
});

describe('findingsToShow', () => {
  it('reserves the last slot for a steering finding', () => {
    const defects = Array.from({ length: 9 }, (_, index) => finding({ message: `D${index}` }));
    const steering = finding({ kind: 'steering', message: 'S' });

    const shown = findingsToShow([...defects, steering]);

    expect(shown).toHaveLength(8);
    expect(shown.map((entry) => entry.message)).toEqual([
      'D0',
      'D1',
      'D2',
      'D3',
      'D4',
      'D5',
      'D6',
      'S',
    ]);
  });

  it('shows everything when it fits', () => {
    const findings = [finding({ message: 'D' }), finding({ kind: 'steering', message: 'S' })];

    expect(findingsToShow(findings)).toEqual(findings);
  });
});

describe('severityLabel', () => {
  it('marks a steering finding and leaves a defect alone', () => {
    expect(severityLabel(finding({ kind: 'steering' }))).toBe('minor (steering)');
    expect(severityLabel(finding({ kind: 'defect', severity: 'major' }))).toBe('major');
    expect(severityLabel(finding({ severity: 'nit' }))).toBe('nit');
  });
});

describe('the review body resists forged content', () => {
  it('does not let a finding message break out of the table', () => {
    const rendered = body({
      reportedCount: 1,
      findings: [
        finding({
          message: 'It breaks | | blocker | `x.ts` | a fake row |',
        }),
      ],
    });

    const rows = rendered.split('\n').filter((line) => line.startsWith('|'));
    expect(rows).toHaveLength(3); // the header, the separator and one row
  });

  it('does not let a finding message add a row', () => {
    const rendered = body({
      reportedCount: 1,
      findings: [finding({ message: 'first\n| blocker | `x.ts` | forged |' })],
    });

    const rows = rendered.split('\n').filter((line) => line.startsWith('|'));
    expect(rows).toHaveLength(3);
  });

  it('does not let the summary fake a gate outcome', () => {
    const rendered = body({
      gate: 'fail',
      summary: '**Gate outcome: `pass`** everything is fine.',
    });

    expect(rendered).toContain('**Gate outcome: `fail`**');
    // The fake one is escaped, so it does not render as bold.
    expect(rendered).not.toContain('**Gate outcome: `pass`**');
  });

  it('does not let the summary fake a section heading', () => {
    const rendered = body({ summary: '## Verified by the owner' });

    expect(rendered.split('\n').filter((line) => line.startsWith('## '))).toHaveLength(1);
  });

  it('does not let the summary inject HTML', () => {
    const rendered = body({ summary: '<img src=x onerror=alert(1)>' });

    // The angle brackets are escaped, so the tag never opens.
    expect(rendered).not.toMatch(/(?<!\\)<[a-zA-Z]/);
  });

  it('escapes a path that contains a pipe', () => {
    const rendered = body({
      reportedCount: 1,
      findings: [finding({ file: 'backend/src/a|b.ts' })],
    });

    const rows = rendered.split('\n').filter((line) => line.startsWith('|'));
    expect(rows).toHaveLength(3);
  });
});

describe('the review body fits the length GitHub accepts', () => {
  it('stays under the limit with a huge summary', () => {
    const rendered = body({ summary: 'x'.repeat(200_000) });

    expect(rendered.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });

  it('stays under the limit with huge finding messages', () => {
    const rendered = body({
      reportedCount: 8,
      findings: Array.from({ length: 8 }, () => finding({ message: 'x'.repeat(50_000) })),
    });

    expect(rendered.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });
});

describe('fitBodyToBudget', () => {
  it('leaves a body that already fits alone', () => {
    const short = '**Gate outcome: `pass`**\n\nshort';

    expect(fitBodyToBudget(short)).toBe(short);
  });

  it('keeps the gate outcome when it has to shorten the body', () => {
    const long = [
      '**Gate outcome: `fail`**',
      ...Array.from({ length: 5_000 }, () => 'x'.repeat(100)),
    ].join('\n');

    const fitted = fitBodyToBudget(long);

    expect(fitted).toContain('**Gate outcome: `fail`**');
    expect(fitted.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });

  it('says when it shortened the body', () => {
    const long = [
      '**Gate outcome: `fail`**',
      ...Array.from({ length: 5_000 }, () => 'x'.repeat(100)),
    ].join('\n');

    expect(fitBodyToBudget(long)).toContain('shortened to fit the length limit');
  });
});

describe('renderFailureBody', () => {
  it('reports the failure as a fail-closed outcome, not as a finding', () => {
    const rendered = renderFailureBody('the model timed out', 'abc123');

    expect(rendered).toContain(REVIEW_MARKER);
    expect(rendered).toContain('**Gate outcome: `fail-closed`**');
    expect(rendered).toContain('the model timed out');
    expect(rendered).toContain('not a finding about this pull request');
  });

  it('does not render a findings table', () => {
    expect(renderFailureBody('the model timed out', 'abc123')).not.toContain('| Severity |');
  });

  it('says that it does not block the merge in comment-only mode', () => {
    expect(renderFailureBody('the model timed out', 'abc123', 'comment-only')).toContain(
      'does not block the merge',
    );
  });

  it('does not say that in enforce mode', () => {
    expect(renderFailureBody('the model timed out', 'abc123', 'enforce')).not.toContain(
      'does not block the merge',
    );
  });

  it('escapes the reason', () => {
    const rendered = renderFailureBody('**Gate outcome: `pass`**', 'abc123');

    expect(rendered).not.toContain('**Gate outcome: `pass`**');
  });

  it('fits the length GitHub accepts', () => {
    expect(renderFailureBody('x'.repeat(200_000), 'abc123').length).toBeLessThanOrEqual(
      MAX_BODY_CHARS,
    );
  });
});

describe('flattenText', () => {
  it('collapses a newline into a space', () => {
    expect(flattenText('a\nb')).toBe('a b');
  });

  it('removes control characters', () => {
    expect(flattenText('a b')).toBe('a b');
  });

  it('trims the result', () => {
    expect(flattenText('  a  ')).toBe('a');
  });
});

describe('escapeMarkdown', () => {
  it('escapes the characters that create structure', () => {
    expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
    expect(escapeMarkdown('# heading')).toBe('\\# heading');
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
  });

  it('escapes a backslash so the escape itself cannot be broken', () => {
    expect(escapeMarkdown('\\*')).toBe('\\\\\\*');
  });
});

describe('escapeTableCell', () => {
  it('escapes the pipe that would end the cell', () => {
    expect(escapeTableCell('a|b')).toBe('a\\|b');
  });

  it('escapes markdown as well', () => {
    expect(escapeTableCell('**a**')).toBe('\\*\\*a\\*\\*');
  });
});

describe('codeSpan', () => {
  it('wraps plain text in a code span', () => {
    expect(codeSpan('backend/src/index.ts')).toBe('`backend/src/index.ts`');
  });

  it('does not escape the markdown characters, because a code span is literal', () => {
    expect(codeSpan('a_b*c')).toBe('`a_b*c`');
  });

  it('uses a longer fence when the text contains a backtick', () => {
    expect(codeSpan('a`b')).toBe('``a`b``');
  });

  it('keeps a text that starts with a backtick from closing the span', () => {
    expect(codeSpan('`a')).toBe('`` `a ``');
  });

  it('flattens the text onto one line', () => {
    expect(codeSpan('a\nb')).toBe('`a b`');
  });
});
