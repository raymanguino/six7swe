import { selectJobsToScore } from '../../domain/jobHunt/filtering';

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
    const existing = [{ jobId: 1, jobHash: 'a' }];

    expect(selectJobsToScore(savedJobs, existing)).toEqual([{ id: 2, hash: 'b' }]);
  });

  it('reselects jobs whose content hash changed', () => {
    const savedJobs = [
      { id: 1, hash: 'changed' },
      { id: 2, hash: 'b' },
    ];
    const existing = [{ jobId: 1, jobHash: 'a' }];

    // Job 1 changed so it needs rescoring; job 2 was never scored at all.
    expect(selectJobsToScore(savedJobs, existing)).toEqual([
      { id: 1, hash: 'changed' },
      { id: 2, hash: 'b' },
    ]);
  });

  it('preserves the full job shape, not just id and hash', () => {
    const savedJobs = [{ id: 1, hash: 'a', position: 'Engineer' }];

    expect(selectJobsToScore(savedJobs, [])).toEqual(savedJobs);
  });

  it('returns nothing when every job is unchanged', () => {
    const savedJobs = [{ id: 1, hash: 'a' }];
    const existing = [{ jobId: 1, jobHash: 'a' }];

    expect(selectJobsToScore(savedJobs, existing)).toEqual([]);
  });
});
