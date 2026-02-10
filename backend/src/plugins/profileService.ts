import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as profileService from '../db/api/profile';

declare module 'fastify' {
  interface FastifyInstance {
    profileService: typeof profileService;
  }
}

async function profileServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('profileService', profileService);
}

export default fp(profileServicePlugin, { name: 'profileService' });
