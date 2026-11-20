import 'dotenv/config';

import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthenticatedUser } from './constants';
import { CORS_METHODS, getCorsOrigin } from './config/cors';
import { getSafeEnv } from './config/env';
import { assertKnowledgeRetrievalConfigured } from './config/knowledgeRetrieval';
import * as plugins from './plugins';
import authPlugin from './plugins/auth';
import routes from './routes';
import { PUBLIC_ROUTE } from './routes/access';
import { reapStaleRefreshes } from './services/jobHunt/standalone';
import { setRetrievalLogger } from './services/knowledgeRetrieval';
import Fastify from 'fastify';
import path from 'path';

const fastify = Fastify({
  logger: {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["x-brain-key"]',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
  },
});

declare module '@fastify/request-context' {
  interface RequestContextData {
    user: import('./types').ContextUser;
  }
}

// Register CORS. It must be registered before the routes so its hooks cover them, so the options
// are a function: avvio evaluates it when the plugin loads (during listen, inside start()'s
// try/catch), so a missing or invalid CORS_ORIGINS is logged and exits 1 like the other startup
// assertions. Every origin in development and test; CORS_ORIGINS otherwise.
fastify.register(fastifyCors, () => ({
  origin: getCorsOrigin(),
  methods: CORS_METHODS,
  credentials: true,
}));

// Register static file serving for resume PDF
// Use ../public (relative to dist/ or src/) so it works in both dev and production
fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  prefix: '/public/',
});

// Register Fastify Request Context plugin
fastify.register(fastifyRequestContext, {
  defaultStoreValues: {
    user: UnauthenticatedUser,
  },
});

// Register the auth plugin first: it populates the request context user that
// the route guard below reads.
fastify.register(authPlugin);

// Register service plugins.
//
// Each entry of the plugins namespace is a module, so the plugin itself is
// its default export. Avvio unwraps that automatically, but doing it here
// keeps the registration typed.
for (const plugin of Object.values(plugins)) {
  fastify.register(plugin.default);
}

// Register service authentication preHandler
// Routes are private by default and opt out via the `public` route config
// (see src/routes/access.ts). Reading the flag from the registered route means
// adding an endpoint can never accidentally expose it.
fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const { public: isPublic } = req.routeOptions.config;
  if (isPublic === true) return;

  const user = requestContext.get('user');
  if (!user || user === UnauthenticatedUser) {
    reply.code(401);
    return reply.send({ error: 'Unauthorized' });
  }
});

// Register routes
fastify.register(routes);

// Register health check route
// Exposes only allowlisted, non-sensitive values. Never spread process.env here.
fastify.get('/', PUBLIC_ROUTE, async (_req: FastifyRequest, _reply: FastifyReply) => {
  return { hello: 'world', status: 'ok', env: getSafeEnv() };
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';

    // Validate CORS first so a bad config fails before anything touches the database. The plugin
    // options above evaluate the same function again when it loads.
    getCorsOrigin();
    assertKnowledgeRetrievalConfigured();
    setRetrievalLogger(fastify.log.child({ module: 'knowledge' }));

    // Refreshes abandoned by a previous process would otherwise stay
    // IN_PROGRESS forever, since there is no queue to recover them.
    const reaped = await reapStaleRefreshes();
    if (reaped > 0) {
      fastify.log.warn({ reaped }, 'Marked stale job refreshes as failed');
    }

    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

void start();
