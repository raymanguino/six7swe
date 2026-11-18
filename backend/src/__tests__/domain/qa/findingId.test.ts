import { hashData } from '../../../util/hash';
import {
  FINDING_ID_PATTERN,
  findingId,
  findingIds,
  type IdentifiableFinding,
} from '../../../domain/qa/findingId';
import { sanitizeFindings, type ReviewFinding } from '../../../domain/qa/verdict';
import { shownInFull } from '../../../domain/qa/diff';

type Run = { pr: number; sha: string };

const idOf = (run: Run, finding: IdentifiableFinding): string => findingId(run, finding, hashData);
const idsOf = (run: Run, findings: readonly IdentifiableFinding[]): string[] =>
  findingIds(run, findings, hashData);

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
    expect(idOf(run, base)).toBe(idOf(run, { ...base }));
    expect(idOf(run, base)).toMatch(FINDING_ID_PATTERN);
  });

  it('changes with any of the fields it covers', () => {
    const ids = new Set([
      idOf(run, base),
      idOf({ ...run, pr: 8 }, base),
      idOf({ ...run, sha: 'abd' }, base),
      idOf(run, { ...base, file: 'backend/src/other.ts' }),
      idOf(run, { ...base, line: 12 }),
      idOf(run, { ...base, severity: 'major' }),
      idOf(run, { ...base, message: 'Different.' }),
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

    expect(idOf(run, corrected)).toBe(
      idOf(run, finding({ file: 'backend/src/index.ts', line: null })),
    );
  });
});

describe('the injected hash', () => {
  it('is what the id is made of: the domain truncates it and hashes the canonical text', () => {
    const seen: string[] = [];
    const fake = (data: string): string => {
      seen.push(data);
      return 'abcdef0123456789ffffffff';
    };

    const id = findingId({ pr: 7, sha: 'abc' }, finding({ line: 3 }), fake);

    expect(id).toBe('abcdef0123456789');
    expect(JSON.parse(seen[0])).toEqual([
      7,
      'abc',
      'backend/src/index.ts',
      3,
      'minor',
      'Something worth mentioning.',
    ]);
  });
});

describe('findingIds', () => {
  const run = { pr: 7, sha: 'abc' };

  it('keeps repeats apart with a numbered suffix, in order of appearance', () => {
    const same = finding({ line: null, message: 'Same.' });
    const ids = idsOf(run, [same, finding({ message: 'Other.' }), { ...same }, { ...same }]);

    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(ids[2]).toBe(`${ids[0]}-2`);
    expect(ids[3]).toBe(`${ids[0]}-3`);
    for (const id of ids) expect(id).toMatch(FINDING_ID_PATTERN);
  });

  it('is deterministic for the same list', () => {
    const list = [finding(), finding(), finding({ message: 'x' })];

    expect(idsOf(run, list)).toEqual(idsOf(run, list));
  });
});
