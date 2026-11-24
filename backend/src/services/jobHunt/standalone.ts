import pino from 'pino';
import type { WorkerConfig } from '../../config/worker';
import { runJobFetch } from '../jobFetchers';
import * as jobService from '../../db/api/job';
import * as profileJobService from '../../db/api/profileJob';
import * as profileService from '../../db/api/profile';
import * as refreshStatusService from '../../db/api/refreshStatus';
import { createJobRefreshService, type JobRefreshService } from './jobRefreshService';
import { getDefaultJobKnowledgeAccess } from './knowledgeSource';
import {
  createRefreshScheduler,
  type RefreshScheduler,
  type RefreshSchedulerDeps,
} from './refreshScheduler';

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
    knowledge: getDefaultJobKnowledgeAccess(),
    logger,
  });
}

/** The worker's scheduler, reading `refresh_status` through this module. */
export function createStandaloneRefreshScheduler(
  config: WorkerConfig,
  logger: RefreshSchedulerDeps['logger'],
): RefreshScheduler {
  return createRefreshScheduler(config, {
    service: createStandaloneJobRefreshService(),
    getLatestRefreshStartedAt: refreshStatusService.getLatestRefreshStartedAt,
    getRefreshStatus: refreshStatusService.getRefreshStatus,
    logger,
  });
}

const DEFAULT_STALE_MINUTES = 30;

/**
 * `JOB_REFRESH_STALE_MINUTES`, or 30 when it is unset or not a finite
 * positive number (a typo must not make the cutoff NaN, which would reap
 * nothing, or zero, which would reap running refreshes).
 */
export function staleRefreshMinutes(raw: string | undefined): number {
  const minutes = Number(raw);
  return raw !== undefined && Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_STALE_MINUTES;
}

/**
 * Marks refreshes abandoned by a previous process as failed.
 *
 * Without this a restart during a refresh leaves the row IN_PROGRESS forever.
 */
export async function reapStaleRefreshes(
  staleMinutes = staleRefreshMinutes(process.env.JOB_REFRESH_STALE_MINUTES),
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  return refreshStatusService.failStaleRefreshes(cutoff);
}
