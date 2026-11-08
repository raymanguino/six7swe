import pino from 'pino';
import { runJobFetch } from '../jobFetchers';
import * as jobService from '../../db/api/job';
import * as profileJobService from '../../db/api/profileJob';
import * as profileService from '../../db/api/profile';
import * as refreshStatusService from '../../db/api/refreshStatus';
import { createJobRefreshService, type JobRefreshService } from './jobRefreshService';

/**
 * Builds a refresh service that runs outside a Fastify request lifecycle.
 *
 * Used by the CLI runner, which has no server to decorate.
 */
export function createStandaloneJobRefreshService(): JobRefreshService {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["x-brain-key"]',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
  });

  return createJobRefreshService({
    jobFetchService: {
      runJobFetch: (keywords, geoId, onJobsFetched, onStatus) =>
        runJobFetch(keywords, geoId, onJobsFetched, onStatus, logger),
    },
    jobService,
    profileJobService,
    profileService,
    refreshStatusService,
    logger,
  });
}

/**
 * Marks refreshes abandoned by a previous process as failed.
 *
 * Without this a restart during a refresh leaves the row IN_PROGRESS forever.
 */
export async function reapStaleRefreshes(
  staleMinutes = Number(process.env.JOB_REFRESH_STALE_MINUTES ?? 30),
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  return refreshStatusService.failStaleRefreshes(cutoff);
}
