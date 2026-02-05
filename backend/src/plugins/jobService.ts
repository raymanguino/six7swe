import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as jobService from '../database/api/job';

declare module 'fastify' {
  interface FastifyInstance { jobService: any; }
}

async function jobServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('jobService', jobService);
}

export default fp(jobServicePlugin, {
  name: 'jobService',
  dependencies: ['@fastify/postgres'],
});
