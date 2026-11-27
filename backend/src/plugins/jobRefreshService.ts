import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import {
  createJobRefreshService,
  type JobRefreshService,
} from '../services/jobHunt/jobRefreshService';

declare module 'fastify' {
  interface FastifyInstance {
    jobRefreshService: JobRefreshService;
  }
}

/**
 * Wires the refresh pipeline to the data-access decorators.
 *
 * No job fetcher, so the API never launches Chrome (see `refreshWorker.ts`).
 *
 * Must be registered after the decorators it depends on; the plugin barrel
 * keeps it last.
 */
async function jobRefreshServicePlugin(fastify: FastifyInstance) {
  const service = createJobRefreshService({
    jobService: fastify.jobService,
    profileJobService: fastify.profileJobService,
    profileService: fastify.profileService,
    refreshStatusService: fastify.refreshStatusService,
    knowledge: fastify.jobKnowledge,
    logger: fastify.log,
  });

  fastify.decorate('jobRefreshService', service);
}

export default fp(jobRefreshServicePlugin, { name: 'jobRefreshService' });
