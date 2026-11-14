/**
 * Job selection for scoring.
 *
 * Pure domain logic. A job needs (re)scoring for a profile when:
 * - it has never been scored for that profile,
 * - the posting content changed since it was last scored (its hash differs), or
 * - its score is stale: it was scored against a different version of the
 *   knowledge base than the current one (see `isScoreStale`).
 */

export interface ScoredJob {
  id: number;
  hash: string;
}

export interface ExistingMatch {
  jobId: number;
  jobHash: string;
  /** The knowledge corpus version the match was scored against; null when none was used. */
  knowledgeVersion: number | null;
}

/**
 * The staleness rule. A score is stale when the knowledge base's current
 * corpus version is known and the score was made against any other version,
 * including none at all (a score made before the knowledge base, or while it
 * was not configured).
 *
 * When the current version is unknown (the knowledge service is not
 * configured or did not answer), nothing is called stale: there is nothing to
 * compare against, and rescoring would not change the background.
 *
 * Versions are compared for equality, not order: a corpus that was reset or
 * restored to a lower version also changes what a match is scored against.
 */
export function isScoreStale(matchVersion: number | null, currentVersion: number | null): boolean {
  if (currentVersion === null) return false;
  return matchVersion !== currentVersion;
}

/**
 * Returns the jobs that still need a match score: never-scored jobs, jobs
 * whose content hash changed since the last score, and jobs whose score is
 * stale against `currentKnowledgeVersion`.
 */
export function selectJobsToScore<T extends ScoredJob>(
  savedJobs: readonly T[],
  existingMatches: readonly ExistingMatch[],
  currentKnowledgeVersion: number | null = null,
): T[] {
  const matchByJobId = new Map<number, ExistingMatch>();
  for (const match of existingMatches) {
    matchByJobId.set(match.jobId, match);
  }

  return savedJobs.filter((job) => {
    const previous = matchByJobId.get(job.id);
    if (previous === undefined) return true;
    if (previous.jobHash !== job.hash) return true;
    return isScoreStale(previous.knowledgeVersion, currentKnowledgeVersion);
  });
}
