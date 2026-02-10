import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as profileJobService from '../db/api/profileJob';

declare module 'fastify' {
  interface FastifyInstance {
    profileJobService: typeof profileJobService;
  }
}

async function profileJobServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('profileJobService', profileJobService);
}

export default fp(profileJobServicePlugin, { name: 'profileJobService' });
