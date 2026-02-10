import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as jobFetchService from '../services/jobFetchers';

declare module 'fastify' {
  interface FastifyInstance { jobFetchService: any; }
}

async function jobFetchServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('jobFetchService', jobFetchService);
}

export default fp(jobFetchServicePlugin, { name: 'jobFetchService' });
