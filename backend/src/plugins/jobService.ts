import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as jobService from '../db/api/job';

declare module 'fastify' {
  interface FastifyInstance {
    jobService: typeof jobService;
  }
}

async function jobServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('jobService', jobService);
}

export default fp(jobServicePlugin, { name: 'jobService' });
