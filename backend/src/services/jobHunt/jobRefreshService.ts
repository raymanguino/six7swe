import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { RetrievedChunkDto } from '@six7swe/knowledge-types';
import type { FastifyBaseLogger } from 'fastify';
import type { JobService, JobInput } from '../../db/api/job';
import type { ProfileJobService, InsertProfileJobInput } from '../../db/api/profileJob';
import type { ProfileService } from '../../db/api/profile';
import type { RefreshStatusService } from '../../db/api/refreshStatus';
import type { Job, Profile } from '../../db/schema/jobHunt';
import type { JobFetchService } from '../jobFetchers';
// Imported directly rather than through the `../ai` barrel: the barrel also
// exports the chat and fitcheck agents, which pull the portfolio database
// client in and would make this service untestable without a database.
import { matchJob } from '../ai/jobMatch';
import { mapWithConcurrency } from '../../util';
import {
  buildJobSearchQuery,
  isValidGeoId,
  isScoreStale,
  nextRefreshState,
  selectJobsToScore,
  ActiveRefreshExistsError,
  INITIAL_REFRESH_STATE,
  type RefreshEvent,
  type RefreshState,
} from '../../domain/jobHunt';
import {
  buildSearchProfileContext,
  buildJobDescription,
  buildJobRetrievalQuery,
  evidenceFromChunks,
  type JobForMatching,
} from './profileContext';
import {
  knowledgeForAuthId,
  type JobKnowledgeAccess,
  type JobKnowledgeSource,
} from './knowledgeSource';

/** How many jobs are scored at the same time. */
const DEFAULT_MATCH_CONCURRENCY = 3;

export interface JobRefreshService {
  /**
   * Starts a refresh and returns immediately with the id of the refresh row
   * the caller can poll.
   */
  start(input: { profileId: number }): Promise<{ refreshStatusId: number }>;
  /**
   * Rescores the profile's stale matches (scored against another knowledge
   * version) without fetching new postings. Runs in the background and is
   * tracked by a refresh row, like `start`. Returns a null id, and claims no
   * row, when no match is stale.
   */
  rescore(input: { profileId: number }): Promise<{ refreshStatusId: number | null }>;
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

/** Thrown when a rescore is asked for but the knowledge service is not configured. */
export class KnowledgeNotConfiguredError extends Error {
  constructor() {
    super('The knowledge service is not configured, so there is nothing to rescore against');
    this.name = 'KnowledgeNotConfiguredError';
  }
}

/** Thrown when a rescore is asked for but the configured knowledge service does not answer. */
export class KnowledgeUnavailableError extends Error {
  readonly cause: unknown;

  constructor(options?: { cause?: unknown }) {
    super('The knowledge service did not answer, so the rescore could not start');
    this.cause = options?.cause;
    this.name = 'KnowledgeUnavailableError';
  }
}

export interface JobRefreshServiceOptions {
  jobFetchService: JobFetchService;
  jobService: JobService;
  profileJobService: ProfileJobService;
  profileService: ProfileService;
  refreshStatusService: RefreshStatusService;
  /**
   * The owner's background and who the owner is. Only profiles whose user is
   * the knowledge owner are scored against it; every other profile, and
   * every profile when the service is not configured, is scored on its own
   * fields alone.
   */
  knowledge: JobKnowledgeAccess;
  logger: FastifyBaseLogger;
  matchConcurrency?: number;
  /** Who this service's runs are claimed by (`refresh_status.claimed_by`). */
  claimant?: string;
}

/** What every job in a run is scored against. */
interface RunBackground {
  /** The knowledge source this profile may use; null when it may use none. */
  source: JobKnowledgeSource | null;
  /** The corpus version when the run started; null without the knowledge service. */
  version: number | null;
  /** The overall background chunks; empty when they could not be read (`degraded`). */
  summary: readonly RetrievedChunkDto[];
  /**
   * The overall background could not be read. Rows scored without it get no
   * knowledge version, so they stay stale and are rescored once the service
   * answers again.
   */
  degraded: boolean;
}

/** A job to score, with the hash its match row records. */
type JobToScore = JobForMatching & Pick<Job, 'id' | 'hash'>;

interface ScoredBatch {
  scored: number;
  failed: number;
}

type EvaluationResult = { ok: true; row: InsertProfileJobInput } | { ok: false };

/**
 * Runs the job refresh pipeline.
 *
 * The pipeline used to live inside the HTTP handler, where an error thrown
 * while scoring escaped an un-awaited callback and left the refresh stuck in
 * `IN_PROGRESS` forever. Here every failure path ends the refresh as FAILED,
 * and the fetch callback is awaited so `COMPLETED` is only written once the
 * last batch has actually been scored and stored.
 *
 * Each job is scored against background retrieved from the knowledge service
 * with the job description as the query. The match row records the corpus
 * version the background came from, so a later upload marks it stale.
 */
export function createJobRefreshService(options: JobRefreshServiceOptions): JobRefreshService {
  const {
    jobFetchService,
    jobService,
    profileJobService,
    profileService,
    refreshStatusService,
    knowledge,
    logger,
    matchConcurrency = DEFAULT_MATCH_CONCURRENCY,
    claimant = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`.slice(0, 128),
  } = options;

  async function loadProfile(profileId: number): Promise<Profile> {
    const profile = await profileService.getProfileById(profileId);
    if (!profile) {
      throw new ProfileNotFoundError(profileId);
    }
    return profile;
  }

  /**
   * The knowledge source a profile may be scored against: only the knowledge
   * owner's own profiles get one. Decided from the profile's user row, since
   * background and CLI runs have no request to read it from.
   */
  async function knowledgeFor(profile: Profile): Promise<JobKnowledgeSource | null> {
    if (!knowledge.source) return null;
    const authId = await profileService.getProfileOwnerAuthId(profile.id);
    return knowledgeForAuthId(knowledge, authId);
  }

  async function start(input: { profileId: number }): Promise<{ refreshStatusId: number }> {
    const { profileId } = input;
    const profile = await loadProfile(profileId);

    // A refresh needs a numeric LinkedIn geo id. Checking here turns a
    // background failure into an immediate, actionable error.
    if (!isValidGeoId(profile.location)) {
      throw new InvalidProfileLocationError(profileId, profile.location);
    }

    const refreshId = await claimRefresh(profileId);

    // Runs in the background so the request returns straight away. runPipeline
    // records failures on the refresh row; the catch is a last resort so no
    // rejection is ever left unhandled.
    runPipeline(refreshId, profile).catch((error: unknown) => {
      logger.error({ err: error, refreshId, profileId }, 'Job refresh crashed');
    });

    return { refreshStatusId: refreshId };
  }

  async function rescore(input: {
    profileId: number;
  }): Promise<{ refreshStatusId: number | null }> {
    const { profileId } = input;
    const profile = await loadProfile(profileId);
    // A profile that may not use the knowledge base gets the same answer as
    // when the service is not configured: there is nothing to rescore against.
    const source = await knowledgeFor(profile);
    if (!source) {
      throw new KnowledgeNotConfiguredError();
    }

    // Nothing stale means nothing to do, so no refresh row is claimed. The
    // run checks again, since the corpus may change before it starts.
    let version: number;
    try {
      version = await source.getVersion();
    } catch (error) {
      throw new KnowledgeUnavailableError({ cause: error });
    }
    const keys = await profileJobService.getMatchKeysForProfile(profileId);
    if (!keys.some((key) => isScoreStale(key.knowledgeVersion, version))) {
      return { refreshStatusId: null };
    }

    const refreshId = await claimRefresh(profileId);

    // Like a refresh, failures land on the row; the catch is a last resort.
    runRescore(refreshId, profile, source).catch((error: unknown) => {
      logger.error({ err: error, refreshId, profileId }, 'Job rescore crashed');
    });

    return { refreshStatusId: refreshId };
  }

  /**
   * Inserts the refresh row that makes this run the profile's only active
   * one. Refreshes and rescores share it, so they never score at once.
   */
  async function claimRefresh(profileId: number): Promise<number> {
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

    try {
      const refresh = await refreshStatusService.newProfileRefreshStatus(profileId, claimant);
      return refresh.id;
    } catch (error) {
      if (error instanceof ActiveRefreshExistsError) {
        // Another request inserted between the check above and this insert.
        throw new RefreshInProgressError(profileId);
      }
      throw error;
    }
  }

  function makeTransition(refreshId: number) {
    let state: RefreshState = { ...INITIAL_REFRESH_STATE };
    return async (event: RefreshEvent, description?: string): Promise<void> => {
      state = nextRefreshState(state, event);
      await refreshStatusService.updateRefreshStatus(refreshId, claimant, {
        status: state.status,
        step: state.step,
        ...(description === undefined ? {} : { description }),
      });
    };
  }

  /**
   * Ends a run as FAILED. If even that write fails, the row stays active
   * until the stale-refresh reaper ends it, so the error is logged rather
   * than thrown out of a background run.
   */
  async function markFailed(
    transition: (event: RefreshEvent, description?: string) => Promise<void>,
    context: { refreshId: number; profileId: number },
    error: unknown,
  ): Promise<void> {
    try {
      await transition({ type: 'FAILED' }, errorMessage(error));
    } catch (writeError) {
      logger.error({ err: writeError, ...context }, 'Could not mark the refresh as failed');
    }
  }

  /**
   * Reads what a run scores against. When the service is configured the
   * corpus version is required: without it the run could not tell which
   * scores are stale, so the run fails. The overall background is optional,
   * but a failure to read it marks the run as degraded. It is cached by the
   * version read here, so it is retrieved once per corpus change.
   */
  async function loadBackground(source: JobKnowledgeSource | null): Promise<RunBackground> {
    if (!source) {
      return { source: null, version: null, summary: [], degraded: false };
    }
    const version = await source.getVersion();
    try {
      const summary = await source.getBackgroundSummary(version);
      return { source, version, summary, degraded: false };
    } catch (error) {
      logger.warn({ err: error }, 'Could not read the overall background; scoring without it');
      return { source, version, summary: [], degraded: true };
    }
  }

  async function runPipeline(refreshId: number, profile: Profile): Promise<void> {
    const transition = makeTransition(refreshId);

    let scored = 0;
    let failed = 0;

    try {
      const query = buildJobSearchQuery({
        keywords: profile.keywords,
        geoId: profile.location,
      });

      await transition({ type: 'STARTED' }, 'Started job fetch.');

      const source = await knowledgeFor(profile);
      if (!source) {
        logger.info(
          { refreshId, profileId: profile.id },
          'No knowledge base for this profile; scoring on its fields alone',
        );
      }
      const background = await loadBackground(source);

      await jobFetchService.runJobFetch(
        query.keywords,
        query.geoId,
        async (fetchedJobs: Array<JobInput>) => {
          await transition({ type: 'JOBS_FETCHED' });
          const result = await scoreFetchedJobs(profile, background, fetchedJobs);
          scored += result.scored;
          failed += result.failed;
        },
        async (status: string) => {
          await refreshStatusService.updateRefreshStatus(refreshId, claimant, {
            description: status,
          });
        },
      );

      await transition(
        { type: 'COMPLETED' },
        `Refresh completed. Scored ${scored} job(s), ${failed} failed to evaluate.`,
      );
    } catch (error) {
      logger.error({ err: error, refreshId, profileId: profile.id }, 'Job refresh failed');
      await markFailed(transition, { refreshId, profileId: profile.id }, error);
    }
  }

  async function runRescore(
    refreshId: number,
    profile: Profile,
    source: JobKnowledgeSource,
  ): Promise<void> {
    const transition = makeTransition(refreshId);
    try {
      await transition({ type: 'STARTED' }, 'Checking for stale matches.');
      const background = await loadBackground(source);

      const keys = await profileJobService.getMatchKeysForProfile(profile.id);
      const staleIds = keys
        .filter((key) => isScoreStale(key.knowledgeVersion, background.version))
        .map((key) => key.jobId);

      await transition(
        { type: 'FILTERING_STARTED' },
        `Rescoring ${staleIds.length} stale match(es).`,
      );

      // The current job rows: the posting text to score, and the hash the
      // row records for that text.
      const staleJobs = await jobService.getJobsByIds(staleIds);
      const result = await scoreJobs(profile, background, staleJobs);

      if (result.scored === 0 && result.failed > 0) {
        throw new Error(
          `Rescore failed: none of the ${result.failed} stale match(es) could be evaluated.`,
        );
      }

      await transition(
        { type: 'COMPLETED' },
        `Rescore completed. Rescored ${result.scored} match(es), ${result.failed} failed to evaluate.`,
      );
    } catch (error) {
      logger.error({ err: error, refreshId, profileId: profile.id }, 'Job rescore failed');
      await markFailed(transition, { refreshId, profileId: profile.id }, error);
    }
  }

  async function scoreFetchedJobs(
    profile: Profile,
    background: RunBackground,
    fetchedJobs: Array<JobInput>,
  ): Promise<ScoredBatch> {
    // Independent: the keys of this profile's matches do not depend on the insert.
    const [savedJobs, matchKeys] = await Promise.all([
      jobService.bulkInsertJobs(fetchedJobs),
      profileJobService.getMatchKeysForProfile(profile.id),
    ]);

    // Jobs already scored for this profile are skipped unless their content
    // changed or their score is stale against the current knowledge version.
    const toScore = selectJobsToScore(savedJobs, matchKeys, background.version);

    return scoreJobs(profile, background, toScore);
  }

  /**
   * Retrieves background for each job, scores it and stores the matches.
   * Each row records the corpus version its chunks came from, so a corpus
   * change during the run leaves that row stale rather than mislabelled.
   */
  async function scoreJobs(
    profile: Profile,
    background: RunBackground,
    toScore: readonly JobToScore[],
  ): Promise<ScoredBatch> {
    const evaluations = await mapWithConcurrency(
      toScore,
      matchConcurrency,
      async (job): Promise<EvaluationResult> => {
        try {
          // A job whose background cannot be retrieved fails on its own,
          // rather than being scored as if the candidate had none.
          const retrieved = background.source
            ? await background.source.retrieve(buildJobRetrievalQuery(job))
            : null;
          const chunks = retrieved?.chunks ?? [];

          const result = await matchJob({
            jobDescription: buildJobDescription(job),
            profileContext: buildSearchProfileContext(profile, {
              summary: background.summary,
              chunks,
            }),
          });

          logger.info(
            {
              profileId: profile.id,
              jobId: job.id,
              position: job.position,
              company: job.company,
              score: result.score,
              band: result.band,
              knowledgeVersion: retrieved?.version ?? null,
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
              // A degraded run's rows stay stale so a later run redoes them.
              knowledge_version: background.degraded ? null : (retrieved?.version ?? null),
              evidence: evidenceFromChunks(chunks),
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

  return { start, rescore };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
