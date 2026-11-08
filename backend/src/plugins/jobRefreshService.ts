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
 * Must be registered after the decorators it depends on; the plugin barrel
 * keeps it last.
 */
async function jobRefreshServicePlugin(fastify: FastifyInstance) {
  const service = createJobRefreshService({
    jobFetchService: fastify.jobFetchService,
    jobService: fastify.jobService,
    profileJobService: fastify.profileJobService,
    profileService: fastify.profileService,
    refreshStatusService: fastify.refreshStatusService,
    logger: fastify.log,
  });

  fastify.decorate('jobRefreshService', service);
}

export default fp(jobRefreshServicePlugin, { name: 'jobRefreshService' });
