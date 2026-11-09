import type { FastifyBaseLogger } from 'fastify';
import type { JobService, JobInput } from '../../db/api/job';
import type { ProfileJobService, InsertProfileJobInput } from '../../db/api/profileJob';
import type { ProfileService } from '../../db/api/profile';
import type { RefreshStatusService } from '../../db/api/refreshStatus';
import type { Profile } from '../../db/schema/jobHunt';
import type { JobFetchService } from '../jobFetchers';
// Imported directly rather than through the `../ai` barrel: the barrel also
// exports the chat and fitcheck agents, which pull the portfolio database
// client in and would make this service untestable without a database.
import { matchJob } from '../ai/jobMatch';
import { mapWithConcurrency } from '../../util';
import {
  buildJobSearchQuery,
  isValidGeoId,
  nextRefreshState,
  selectJobsToScore,
  ActiveRefreshExistsError,
  INITIAL_REFRESH_STATE,
  type RefreshEvent,
  type RefreshState,
} from '../../domain/jobHunt';
import { buildSearchProfileContext, buildJobDescription } from './profileContext';

/** How many jobs are scored at the same time. */
const DEFAULT_MATCH_CONCURRENCY = 3;

export interface JobRefreshService {
  /**
   * Starts a refresh and returns immediately with the id of the refresh row
   * the caller can poll.
   */
  start(input: { profileId: number }): Promise<{ refreshStatusId: number }>;
}

/** Thrown when a profile already has a refresh running. */
export class RefreshInProgressError extends Error {
  constructor(profileId: number) {
    super(`A refresh is already running for profile ${profileId}`);
    this.name = 'RefreshInProgressError';
  }
}

/** Thrown when the profile does not exist. */
export class ProfileNotFoundError extends Error {
  constructor(profileId: number) {
    super(`Profile ${profileId} not found`);
    this.name = 'ProfileNotFoundError';
  }
}

/**
 * Thrown when the profile has no usable LinkedIn geo id.
 *
 * A refresh needs a numeric region id. Without one the search would silently
 * return nothing, so the refresh is rejected up front instead of failing
 * partway through.
 */
export class InvalidProfileLocationError extends Error {
  constructor(profileId: number, location: string | null) {
    super(
      `Profile ${profileId} has an invalid LinkedIn geo id: ${JSON.stringify(location ?? null)}`,
    );
    this.name = 'InvalidProfileLocationError';
  }
}

export interface JobRefreshServiceOptions {
  jobFetchService: JobFetchService;
  jobService: JobService;
  profileJobService: ProfileJobService;
  profileService: ProfileService;
  refreshStatusService: RefreshStatusService;
  logger: FastifyBaseLogger;
  matchConcurrency?: number;
}

interface ScoredBatch {
  scored: number;
  failed: number;
}

type EvaluationResult =
  | { ok: true; row: InsertProfileJobInput }
  | { ok: false };

/**
 * Runs the job refresh pipeline.
 *
 * The pipeline used to live inside the HTTP handler, where an error thrown
 * while scoring escaped an un-awaited callback and left the refresh stuck in
 * `IN_PROGRESS` forever. Here every failure path ends the refresh as FAILED,
 * and the fetch callback is awaited so `COMPLETED` is only written once the
 * last batch has actually been scored and stored.
 */
export function createJobRefreshService(options: JobRefreshServiceOptions): JobRefreshService {
  const {
    jobFetchService,
    jobService,
    profileJobService,
    profileService,
    refreshStatusService,
    logger,
    matchConcurrency = DEFAULT_MATCH_CONCURRENCY,
  } = options;

  async function start(input: { profileId: number }): Promise<{ refreshStatusId: number }> {
    const { profileId } = input;

    const profile = await profileService.getProfileById(profileId);
    if (!profile) {
      throw new ProfileNotFoundError(profileId);
    }

    // A refresh needs a numeric LinkedIn geo id. Checking here turns a
    // background failure into an immediate, actionable error.
    if (!isValidGeoId(profile.location)) {
      throw new InvalidProfileLocationError(profileId, profile.location);
    }

    // Guard against two refreshes for the same profile running at once:
    // they would score the same jobs twice and race on the status row.
    //
    // The read below is only a fast path. The insert is the real gate: a
    // partial unique index makes the database reject a second active refresh
    // for the same profile, so two concurrent requests cannot both start one.
    const active = await refreshStatusService.getActiveRefreshForProfile(profileId);
    if (active) {
      throw new RefreshInProgressError(profileId);
    }

    let refresh;
    try {
      refresh = await refreshStatusService.newProfileRefreshStatus(profileId);
    } catch (error) {
      if (error instanceof ActiveRefreshExistsError) {
        // Another request inserted between the check above and this insert.
        throw new RefreshInProgressError(profileId);
      }
      throw error;
    }

    // Runs in the background so the request returns straight away. runPipeline
    // never rejects: it records failures on the refresh row instead.
    void runPipeline(refresh.id, profile);

    return { refreshStatusId: refresh.id };
  }

  async function runPipeline(refreshId: number, profile: Profile): Promise<void> {
    let state: RefreshState = { ...INITIAL_REFRESH_STATE };

    const transition = async (event: RefreshEvent, description?: string): Promise<void> => {
      state = nextRefreshState(state, event);
      await refreshStatusService.updateRefreshStatus(refreshId, {
        status: state.status,
        step: state.step,
        ...(description === undefined ? {} : { description }),
      });
    };

    let scored = 0;
    let failed = 0;

    try {
      const query = buildJobSearchQuery({
        keywords: profile.keywords,
        geoId: profile.location,
      });

      const profileContext = buildSearchProfileContext(profile);

      await transition({ type: 'STARTED' }, 'Started job fetch.');

      await jobFetchService.runJobFetch(
        query.keywords,
        query.geoId,
        async (fetchedJobs: Array<JobInput>) => {
          await transition({ type: 'JOBS_FETCHED' });
          const result = await scoreFetchedJobs(profile, profileContext, fetchedJobs);
          scored += result.scored;
          failed += result.failed;
        },
        async (status: string) => {
          await refreshStatusService.updateRefreshStatus(refreshId, { description: status });
        },
      );

      await transition(
        { type: 'COMPLETED' },
        `Refresh completed. Scored ${scored} job(s), ${failed} failed to evaluate.`,
      );
    } catch (error) {
      logger.error({ err: error, refreshId, profileId: profile.id }, 'Job refresh failed');
      await transition({ type: 'FAILED' }, errorMessage(error));
    }
  }

  async function scoreFetchedJobs(
    profile: Profile,
    profileContext: string,
    fetchedJobs: Array<JobInput>,
  ): Promise<ScoredBatch> {
    const savedJobs = await jobService.bulkInsertJobs(fetchedJobs);

    const existingMatches = await profileJobService.getProfileJobs(profile.id);

    // Jobs already scored for this profile are skipped unless their content
    // changed, so an edited posting is re-evaluated.
    const toScore = selectJobsToScore(
      savedJobs,
      existingMatches.map((match) => ({ jobId: match.jobId, jobHash: match.jobHash })),
    );

    const evaluations = await mapWithConcurrency(
      toScore,
      matchConcurrency,
      async (job): Promise<EvaluationResult> => {
      try {
        const result = await matchJob({
          jobDescription: buildJobDescription(job),
          profileContext,
        });

        logger.info(
          {
            profileId: profile.id,
            jobId: job.id,
            position: job.position,
            company: job.company,
            score: result.score,
            band: result.band,
          },
          'Job match evaluated',
        );

        return {
          ok: true as const,
          row: {
            profile_id: profile.id,
            job_id: job.id,
            job_hash: job.hash,
            score: result.score,
            band: result.band,
            explanation: result.analysis,
            first_skill_match: result.matchedSkills[0] ?? null,
            second_skill_match: result.matchedSkills[1] ?? null,
            third_skill_match: result.matchedSkills[2] ?? null,
            summary: result.summary,
          },
        };
      } catch (error) {
        // One job failing to score must not abandon the rest of the batch.
        logger.error(
          { err: error, profileId: profile.id, jobId: job.id },
          'Job match evaluation failed',
        );
        return { ok: false };
      }
    },
    );

    const rows = evaluations
      .filter((entry): entry is { ok: true; row: InsertProfileJobInput } => entry.ok)
      .map((entry) => entry.row);

    await profileJobService.bulkInsertProfileJobs(rows);

    return { scored: rows.length, failed: evaluations.length - rows.length };
  }

  return { start };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
