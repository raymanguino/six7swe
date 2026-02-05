import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import * as userService from '../database/api/user';

declare module 'fastify' {
  interface FastifyInstance { userService: any;}
}

async function userServicePlugin(fastify: FastifyInstance) {
  fastify.decorate('userService', userService);
}

export default fp(userServicePlugin, {
  name: 'userService',
  dependencies: ['@fastify/postgres'],
});