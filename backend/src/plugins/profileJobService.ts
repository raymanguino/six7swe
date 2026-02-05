import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as profileJobService from '../database/api/profileJob';

declare module 'fastify' {
  interface FastifyInstance { profileJobService: any; }
}

async function profileJobServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('profileJobService', profileJobService);
}

export default fp(profileJobServicePlugin, {
  name: 'profileJobService',
  dependencies: ['@fastify/postgres'],
});
