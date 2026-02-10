import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as userService from '../db/api/user';

declare module 'fastify' {
  interface FastifyInstance {
    userService: typeof userService;
  }
}

async function userServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('userService', userService);
}

export default fp(userServicePlugin, { name: 'userService' });