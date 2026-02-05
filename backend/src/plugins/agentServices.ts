import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as agentServices from '../services/agents';

declare module 'fastify' {
  interface FastifyInstance { agentServices: any }
}

async function agentServicesPlugin(fastify: FastifyInstance) {
  fastify.decorate('agentServices', agentServices);
}

export default fp(agentServicesPlugin, {
  name: 'agentServices',
  dependencies: ['@fastify/postgres'],
});
