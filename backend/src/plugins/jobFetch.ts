import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { runJobFetch, type JobFetchService } from '../services/jobFetchers';

declare module 'fastify' {
  interface FastifyInstance {
    jobFetchService: JobFetchService;
  }
}

/**
 * Exposes the job fetcher with the Fastify logger bound in, so scraper
 * failures are reported as structured logs rather than console output.
 */
async function jobFetchServicePlugin(fastify: FastifyInstance) {
  const service: JobFetchService = {
    runJobFetch: (keywords, geoId, onJobsFetched, onStatus) =>
      runJobFetch(keywords, geoId, onJobsFetched, onStatus, fastify.log),
  };

  fastify.decorate('jobFetchService', service);
}

export default fp(jobFetchServicePlugin, { name: 'jobFetchService' });
