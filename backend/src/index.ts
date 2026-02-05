import 'dotenv/config';

import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import fastifyPostgres from '@fastify/postgres';
import { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthenticatedUser } from './constants';
import { ContextUser } from './types';
import * as plugins from './plugins';
import routes from './routes';
import { decodeBase64 } from './util';

const Fastify = require('fastify');
const fastify = Fastify({ logger: true });

declare module '@fastify/request-context' {
  interface RequestContextData {
    user: ContextUser
  }
}

const {
  DATABASE_URL,
} = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required.');
}

fastify.register(fastifyPostgres, {
  connectionString: DATABASE_URL,
});

// Register Fastify Request Context plugin
fastify.register(fastifyRequestContext, {
  defaultStoreValues: {
    user: UnauthenticatedUser
  }
});

// Register service plugins
for (const plugin of Object.values(plugins)) {
  fastify.register(plugin);
}

// Register service hook for setting user context
fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  requestContext.set(
    // TODO: Replace with real authentication logic
    'user', { 
      id: 1,
      email: 'john@example.com',
    } as unknown as ContextUser);
});

// Register service authentication preHandler
// TODO: Replace with real authentication middleware
fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = requestContext.get('user');
  if (user == UnauthenticatedUser) {
    reply.code(401);
    return reply.send({ error: 'Unauthorized' });
  }
});

// Register routes
fastify.register(routes);

// Register health check route
fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
  return { hello: 'world', status: 'ok', ...process.env };
});

const start = async () => {
  try {
    const port = parseInt(process.env.APP_PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
