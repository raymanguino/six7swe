import { FINDING_ID_PATTERN, findingId, findingIds } from '../../../domain/qa/findingId';
import { sanitizeFindings, type ReviewFinding } from '../../../domain/qa/verdict';
import { shownInFull } from '../../../domain/qa/diff';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    file: 'backend/src/index.ts',
    line: null,
    message: 'Something worth mentioning.',
    ...overrides,
  };
}

describe('findingId', () => {
  const run = { pr: 7, sha: 'abc' };
  const base = finding({ file: 'backend/src/index.ts', line: 11 });

  it('is the same for the same sanitized finding', () => {
    expect(findingId(run, base)).toBe(findingId(run, { ...base }));
    expect(findingId(run, base)).toMatch(FINDING_ID_PATTERN);
  });

  it('changes with any of the fields it covers', () => {
    const ids = new Set([
      findingId(run, base),
      findingId({ ...run, pr: 8 }, base),
      findingId({ ...run, sha: 'abd' }, base),
      findingId(run, { ...base, file: 'backend/src/other.ts' }),
      findingId(run, { ...base, line: 12 }),
      findingId(run, { ...base, severity: 'major' }),
      findingId(run, { ...base, message: 'Different.' }),
    ]);

    expect(ids.size).toBe(7);
  });

  it('is computed after sanitizing, so a corrected line gives the same id as no line', () => {
    const [corrected] = sanitizeFindings(
      [finding({ file: 'backend/src/index.ts', line: 999 })],
      shownInFull([
        {
          filename: 'backend/src/index.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          patch: '@@ -10,1 +10,1 @@\n-a\n+b',
        },
      ]),
    );

    expect(findingId(run, corrected)).toBe(
      findingId(run, finding({ file: 'backend/src/index.ts', line: null })),
    );
  });
});

describe('findingIds', () => {
  const run = { pr: 7, sha: 'abc' };

  it('keeps repeats apart with a numbered suffix, in order of appearance', () => {
    const same = finding({ line: null, message: 'Same.' });
    const ids = findingIds(run, [same, finding({ message: 'Other.' }), { ...same }, { ...same }]);

    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(ids[2]).toBe(`${ids[0]}-2`);
    expect(ids[3]).toBe(`${ids[0]}-3`);
    for (const id of ids) expect(id).toMatch(FINDING_ID_PATTERN);
  });

  it('is deterministic for the same list', () => {
    const list = [finding(), finding(), finding({ message: 'x' })];

    expect(findingIds(run, list)).toEqual(findingIds(run, list));
  });
});
