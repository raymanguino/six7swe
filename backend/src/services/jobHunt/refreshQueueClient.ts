import type { FastifyBaseLogger } from 'fastify';
import * as jobService from '../../db/api/job';
import * as profileJobService from '../../db/api/profileJob';
import * as profileService from '../../db/api/profile';
import * as refreshStatusService from '../../db/api/refreshStatus';
import type { RefreshStatus } from '../../db/schema/jobHunt';
import { createJobRefreshService, type JobRefreshService } from './jobRefreshService';
import { getDefaultJobKnowledgeAccess } from './knowledgeSource';

/** Queues refreshes and reads their status; it never runs one. */
export interface RefreshQueueClient extends JobRefreshService {
  /** The refresh row, or null when it does not exist. */
  getStatus(refreshId: number): Promise<RefreshStatus | null>;
}

/**
 * The queue side of the refresh pipeline wired to the database, for scripts
 * that have no server to decorate. Unlike `standalone.ts` it loads no
 * scraper, so it never launches Chrome.
 */
export function createRefreshQueueClient(logger: FastifyBaseLogger): RefreshQueueClient {
  const service = createJobRefreshService({
    jobService,
    profileJobService,
    profileService,
    refreshStatusService,
    knowledge: getDefaultJobKnowledgeAccess(),
    logger,
  });
  return { ...service, getStatus: (refreshId) => refreshStatusService.getRefreshStatus(refreshId) };
}
