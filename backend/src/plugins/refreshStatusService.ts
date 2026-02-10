import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as refreshStatusService from '../db/api/refreshStatus';

declare module 'fastify' {
  interface FastifyInstance {
    refreshStatusService: typeof refreshStatusService;
  }
}

async function refreshStatusServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('refreshStatusService', refreshStatusService);
}

export default fp(refreshStatusServicePlugin, { name: 'refreshStatusService' });
