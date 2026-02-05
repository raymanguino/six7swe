import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as profileService from '../database/api/profile';

declare module 'fastify' {
  interface FastifyInstance { profileService: any; }
}

async function profileServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('profileService', profileService);
}

export default fp(profileServicePlugin, {
  name: 'profileService',
  dependencies: ['@fastify/postgres'],
});
