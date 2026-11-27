import type { FastifyBaseLogger } from 'fastify';
import type { WorkerConfig } from '../../config/worker';
import { runJobFetch } from '../jobFetchers';
import * as jobService from '../../db/api/job';
import * as profileJobService from '../../db/api/profileJob';
import * as profileService from '../../db/api/profile';
import * as refreshStatusService from '../../db/api/refreshStatus';
import {
  createJobRefreshRunner,
  type JobRefreshRunner,
  type JobRefreshService,
} from './jobRefreshService';
import { getDefaultJobKnowledgeAccess } from './knowledgeSource';
import { createRefreshQueue } from './refreshQueue';
import { createRefreshScheduler } from './refreshScheduler';
import { createRefreshWorker, type RefreshWorker } from './refreshWorker';

/**
 * The refresh pipeline wired with the scraper and the database, for the
 * processes that have no server to decorate. It loads puppeteer, so the API
 * never imports it.
 */

export function createStandaloneJobRefreshService(
  logger: FastifyBaseLogger,
): JobRefreshService & JobRefreshRunner {
  return createJobRefreshRunner({
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

/** The worker's loop body (`refreshWorker.ts`), with its scheduler. */
export function createStandaloneRefreshWorker(
  config: WorkerConfig & { scheduleEveryMs: number },
  logger: FastifyBaseLogger,
): RefreshWorker {
  const service = createStandaloneJobRefreshService(logger);
  const scheduler = createRefreshScheduler(config, {
    service,
    getLatestRefreshStartedAt: refreshStatusService.getLatestRefreshStartedAt,
    getRefreshStatus: refreshStatusService.getRefreshStatus,
    logger,
  });
  return createRefreshWorker({
    queue: createRefreshQueue(refreshStatusService),
    runner: service,
    scheduler,
    failRun: (refresh, reason) =>
      refresh.claimedBy === null
        ? Promise.resolve(false)
        : refreshStatusService.endFailure(refresh.id, refresh.claimedBy, reason),
    scheduleEveryMs: config.scheduleEveryMs,
    logger,
  });
}
