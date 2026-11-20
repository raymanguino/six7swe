import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { SERVICE_KEY_HEADER, type ErrorResponse } from './contract.js';
import serviceAuth, { type Authenticators } from './plugins/serviceAuth.js';
import { registerRoutes } from './routes/index.js';
import type { EvalRepository } from './db/api/evalRepository.js';
import type { ProfileRepository } from './db/api/profileRepository.js';
import type { EvalAnswerer } from './services/evalSet/answerer.js';
import { createEvalSet, type EvalSet, type EvalSettings } from './services/evalSet/evalSet.js';
import { createEvalRunner, type EvalRunner } from './services/evalSet/runner.js';
import type { KnowledgeDeps } from './services/deps.js';
import type { ProfileDrafter } from './services/profile/drafter.js';
import { createProfileDrafting, type ProfileDrafting } from './services/profile/profiles.js';
import { createRiskBackfill, type RiskBackfill } from './services/risk/backfill.js';
import type { RiskScanner } from './services/risk/scanner.js';
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
    /** The eval set's question recorder (#85); the entry point stops it on shutdown. */
    evalSet: EvalSet;
    /** The eval run queue (#85); the entry point stops it on shutdown. */
    evalRunner: EvalRunner;
    /** The one-time risk scan of documents ready before the scan existed (#212). */
    riskBackfill: RiskBackfill;
  }
}

export interface BuildAppOptions {
  deps: KnowledgeDeps;
  /** The structured profile (#86): its storage, and the model that drafts it (null: off). */
  profile: { repo: ProfileRepository; drafter: ProfileDrafter | null };
  /**
   * The evolving chat eval set (#85): its storage, the model that answers
   * each question in a run (null: retrieval only) and threshold overrides.
   */
  evaluation: {
    repo: EvalRepository;
    answerer: EvalAnswerer | null;
    settings?: Partial<EvalSettings>;
  };
  /** Opens service routes only. */
  serviceKey: string;
  /** Opens owner routes only; held by the backend's owner proxy. */
  ownerKey: string;
  /** Opens the MCP adapter only; unset closes `/mcp` (401). */
  mcpKey?: string;
  /** The single owner (`OWNER_AUTH_ID`) every authenticated request acts for. */
  ownerId: string;
  maxUploadBytes: number;
  /** Largest resume PDF the MCP adapter returns (default 5 MB); tests lower it. */
  mcpMaxPdfBytes?: number;
  logger?: FastifyServerOptions['logger'];
  chunkOptions?: PipelineDeps['chunkOptions'];
  /**
   * The risk scan's model pass (#212). Null or unset: the deterministic
   * checks only; every ingest is still scanned before it can be ready.
   */
  riskScanner?: RiskScanner | null;
  /** Overrides the risk scan's deadline, for tests. */
  riskScanDeadlineMs?: number;
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

  const evalSet = createEvalSet({
    repo: options.evaluation.repo,
    embedder: deps.embedder,
    log: app.log,
    settings: options.evaluation.settings,
  });
  const evalRunner = createEvalRunner({
    evalRepo: options.evaluation.repo,
    repo: deps.repo,
    evalSet,
    answerer: options.evaluation.answerer,
    log: app.log,
  });
  app.decorate('evalSet', evalSet);
  app.decorate('evalRunner', evalRunner);

  const queue = createIngestionQueue(
    {
      ...deps,
      chunkOptions: options.chunkOptions,
      riskScanner: options.riskScanner ?? null,
      riskScanDeadlineMs: options.riskScanDeadlineMs,
      onResumeIngested: (doc) => drafting.resumeIngested(doc),
      onCorpusChanged: (ownerId) => evalRunner.corpusChanged(ownerId),
    },
    app.log,
  );
  app.decorate('ingestionQueue', queue);
  app.decorate(
    'riskBackfill',
    createRiskBackfill({
      repo: deps.repo,
      scanner: options.riskScanner ?? null,
      log: app.log,
      deadlineMs: options.riskScanDeadlineMs,
    }),
  );

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
    mcpKey: options.mcpKey,
    ownerId: options.ownerId,
    authenticators: options.authenticators,
  });
  // The only place the upload limits are set; `req.file()` inherits them.
  await app.register(fastifyMultipart, {
    limits: { fileSize: options.maxUploadBytes, files: 1, fields: 5 },
  });

  registerRoutes(app, {
    ...deps,
    queue,
    profiles: options.profile.repo,
    drafting,
    evalRepo: options.evaluation.repo,
    evalSet,
    evalRunner,
    mcpMaxPdfBytes: options.mcpMaxPdfBytes,
  });
  return app;
}
