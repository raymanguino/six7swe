import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { SERVICE_KEY_HEADER, type ErrorResponse } from './contract.js';
import serviceAuth, { type Authenticators } from './plugins/serviceAuth.js';
import { registerRoutes } from './routes/index.js';
import type { ProfileRepository } from './db/api/profileRepository.js';
import type { KnowledgeDeps } from './services/deps.js';
import type { ProfileDrafter } from './services/profile/drafter.js';
import { createProfileDrafting, type ProfileDrafting } from './services/profile/profiles.js';
import {
  createIngestionQueue,
  type IngestionQueue,
  type PipelineDeps,
} from './services/ingestion/pipeline.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The serial ingestion queue; the entry point re-queues work on boot and drains it on shutdown. */
    ingestionQueue: IngestionQueue;
    /** The profile drafting queue; the entry point stops it on shutdown. */
    profileDrafting: ProfileDrafting;
  }
}

export interface BuildAppOptions {
  deps: KnowledgeDeps;
  /** The structured profile (#86): its storage, and the model that drafts it (null: off). */
  profile: { repo: ProfileRepository; drafter: ProfileDrafter | null };
  /** Opens service routes only. */
  serviceKey: string;
  /** Opens owner routes only; held by the backend's owner proxy. */
  ownerKey: string;
  /** The single owner (`OWNER_AUTH_ID`) every authenticated request acts for. */
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

  const { deps } = options;
  const drafting = createProfileDrafting({
    repo: deps.repo,
    profiles: options.profile.repo,
    drafter: options.profile.drafter,
    log: app.log,
  });
  app.decorate('profileDrafting', drafting);

  const queue = createIngestionQueue(
    {
      ...deps,
      chunkOptions: options.chunkOptions,
      // A resume that has just become primary gets a fresh draft profile. A
      // resume that finished but is not primary (an older one re-ingested)
      // would only redraft from the unchanged primary, overwriting the
      // owner's edits for nothing.
      onResumeIngested: async (doc) => {
        if (!options.profile.drafter) return;
        const current = await deps.repo.getDocument(doc.ownerId, doc.id);
        if (current?.isPrimaryResume) drafting.request(doc.ownerId);
      },
    },
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

  registerRoutes(app, { ...deps, queue, profiles: options.profile.repo, drafting });
  return app;
}
