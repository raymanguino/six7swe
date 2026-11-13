import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { SERVICE_KEY_HEADER, type ErrorResponse } from './contract.js';
import serviceAuth, { type Authenticators } from './plugins/serviceAuth.js';
import { registerRoutes } from './routes/index.js';
import type { KnowledgeDeps } from './services/deps.js';
import {
  createIngestionQueue,
  type IngestionQueue,
  type PipelineDeps,
} from './services/ingestion/pipeline.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The serial ingestion queue; the entry point re-queues work on boot and drains it on shutdown. */
    ingestionQueue: IngestionQueue;
  }
}

export interface BuildAppOptions {
  deps: KnowledgeDeps;
  /** Opens service routes only. */
  serviceKey: string;
  /** Opens owner routes only, until the owner JWT gate (step 2, #83) replaces it. */
  ownerKey: string;
  /** The owner every authenticated request acts for, until the owner JWT gate lands. */
  ownerId: string;
  maxUploadBytes: number;
  logger?: FastifyServerOptions['logger'];
  chunkOptions?: PipelineDeps['chunkOptions'];
  /** Per-access-mode overrides; see plugins/serviceAuth.ts. */
  authenticators?: Partial<Authenticators>;
}

/** The HTTP status an error carries (`statusCode`, as Fastify and its plugins set it), else 500. */
function statusOf(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return 500;
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

  const queue = createIngestionQueue(
    { ...options.deps, chunkOptions: options.chunkOptions },
    app.log,
  );
  app.decorate('ingestionQueue', queue);

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ZodError) {
      const body: ErrorResponse = { error: 'Invalid request', issues: error.issues };
      return reply.code(400).send(body);
    }
    const status = statusOf(error);
    if (status >= 500) {
      req.log.error({ err: error }, 'Request failed');
      const body: ErrorResponse = { error: 'Internal Server Error' };
      return reply.code(status).send(body);
    }
    const body: ErrorResponse = {
      error: error instanceof Error ? error.message : 'Request failed',
    };
    return reply.code(status).send(body);
  });

  await app.register(serviceAuth, {
    serviceKey: options.serviceKey,
    ownerKey: options.ownerKey,
    ownerId: options.ownerId,
    authenticators: options.authenticators,
  });
  // The only place the upload limits are set; `req.file()` inherits them.
  await app.register(fastifyMultipart, {
    limits: { fileSize: options.maxUploadBytes, files: 1, fields: 5 },
  });

  registerRoutes(app, { ...options.deps, queue });
  return app;
}
