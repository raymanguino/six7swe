import { isScoreStale, selectJobsToScore } from '../../domain/jobHunt/filtering';

describe('isScoreStale', () => {
  it('is fresh when the score was made against the current version', () => {
    expect(isScoreStale(4, 4)).toBe(false);
  });

  it('is stale when the corpus moved on since the score', () => {
    // A document was uploaded after the refresh: the version went up.
    expect(isScoreStale(4, 5)).toBe(true);
  });

  it('is stale when the corpus went back to a lower version (reset or restore)', () => {
    expect(isScoreStale(5, 3)).toBe(true);
  });

  it('is stale when the score was made without the knowledge base', () => {
    expect(isScoreStale(null, 0)).toBe(true);
    expect(isScoreStale(null, 7)).toBe(true);
  });

  it('is never stale when the current version is unknown', () => {
    expect(isScoreStale(4, null)).toBe(false);
    expect(isScoreStale(null, null)).toBe(false);
  });
});

describe('selectJobsToScore', () => {
  it('selects jobs that have never been scored', () => {
    const savedJobs = [
      { id: 1, hash: 'a' },
      { id: 2, hash: 'b' },
    ];

    expect(selectJobsToScore(savedJobs, [])).toEqual(savedJobs);
  });

  it('skips jobs already scored with an unchanged hash', () => {
    const savedJobs = [
      { id: 1, hash: 'a' },
      { id: 2, hash: 'b' },
    ];
    const existing = [{ jobId: 1, jobHash: 'a', knowledgeVersion: null }];

    expect(selectJobsToScore(savedJobs, existing)).toEqual([{ id: 2, hash: 'b' }]);
  });

  it('reselects jobs whose content hash changed', () => {
    const savedJobs = [
      { id: 1, hash: 'changed' },
      { id: 2, hash: 'b' },
    ];
    const existing = [{ jobId: 1, jobHash: 'a', knowledgeVersion: 3 }];

    // Job 1 changed so it needs rescoring; job 2 was never scored at all.
    expect(selectJobsToScore(savedJobs, existing, 3)).toEqual([
      { id: 1, hash: 'changed' },
      { id: 2, hash: 'b' },
    ]);
  });

  it('preserves the full job shape, not just id and hash', () => {
    const savedJobs = [{ id: 1, hash: 'a', position: 'Engineer' }];

    expect(selectJobsToScore(savedJobs, [])).toEqual(savedJobs);
  });

  it('returns nothing when every job is unchanged and fresh', () => {
    const savedJobs = [{ id: 1, hash: 'a' }];
    const existing = [{ jobId: 1, jobHash: 'a', knowledgeVersion: 2 }];

    expect(selectJobsToScore(savedJobs, existing, 2)).toEqual([]);
  });

  it('reselects an unchanged job scored against an older knowledge version', () => {
    const savedJobs = [
      { id: 1, hash: 'a' },
      { id: 2, hash: 'b' },
      { id: 3, hash: 'c' },
    ];
    const existing = [
      { jobId: 1, jobHash: 'a', knowledgeVersion: 2 },
      { jobId: 2, jobHash: 'b', knowledgeVersion: 3 },
      { jobId: 3, jobHash: 'c', knowledgeVersion: null },
    ];

    // Job 1 predates the latest upload; job 3 predates the knowledge base.
    expect(selectJobsToScore(savedJobs, existing, 3)).toEqual([
      { id: 1, hash: 'a' },
      { id: 3, hash: 'c' },
    ]);
  });

  it('ignores knowledge versions when the current version is unknown', () => {
    const savedJobs = [{ id: 1, hash: 'a' }];
    const existing = [{ jobId: 1, jobHash: 'a', knowledgeVersion: 2 }];

    expect(selectJobsToScore(savedJobs, existing, null)).toEqual([]);
  });
});
