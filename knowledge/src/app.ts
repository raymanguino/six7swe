import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import serviceAuth, { SERVICE_KEY_HEADER } from './plugins/serviceAuth.js';
import type { KnowledgeContext } from './routes/context.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  context: KnowledgeContext;
  serviceKey: string;
  logger?: FastifyServerOptions['logger'];
}

/** Builds the HTTP app without listening, so tests can drive it with `inject`. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? {
      redact: {
        paths: ['req.headers.authorization', `req.headers["${SERVICE_KEY_HEADER}"]`],
        remove: true,
      },
    },
    // Uploads are bounded by the multipart limit; JSON bodies stay small.
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
    }
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'Request failed');
      return reply.code(status).send({ error: 'Internal Server Error' });
    }
    const message = error instanceof Error ? error.message : 'Request failed';
    return reply.code(status).send({ error: message });
  });

  await app.register(serviceAuth, { serviceKey: options.serviceKey });
  await app.register(fastifyMultipart, {
    limits: { fileSize: options.context.maxUploadBytes, files: 1, fields: 5 },
  });

  registerRoutes(app, options.context);
  return app;
}
