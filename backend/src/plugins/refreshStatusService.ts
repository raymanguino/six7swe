import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as refreshStatusService from '../database/api/refreshStatus';

declare module 'fastify' {
  interface FastifyInstance { refreshStatusService: any; }
}

async function refreshStatusServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('refreshStatusService', refreshStatusService);
}

export default fp(refreshStatusServicePlugin, {
  name: 'refreshStatusService',
  dependencies: ['@fastify/postgres'],
});
