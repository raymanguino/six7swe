/**
 * Job selection for scoring.
 *
 * Pure domain logic. A job needs (re)scoring when it has never been scored
 * for a profile, or when the posting content changed since it was last
 * scored. Previously every already-linked job was skipped forever, so a
 * posting that changed was never re-evaluated.
 */

export interface ScoredJob {
  id: number;
  hash: string;
}

export interface ExistingMatch {
  jobId: number;
  jobHash: string;
}

/**
 * Returns the jobs that still need a match score: never-scored jobs, plus
 * jobs whose content hash changed since the last score.
 */
export function selectJobsToScore<T extends ScoredJob>(
  savedJobs: readonly T[],
  existingMatches: readonly ExistingMatch[],
): T[] {
  const hashByJobId = new Map<number, string>();
  for (const match of existingMatches) {
    hashByJobId.set(match.jobId, match.jobHash);
  }

  return savedJobs.filter((job) => {
    const previousHash = hashByJobId.get(job.id);
    return previousHash === undefined || previousHash !== job.hash;
  });
}
