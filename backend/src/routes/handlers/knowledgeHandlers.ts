import { requestContext } from '@fastify/request-context';
import { FastifyReply, FastifyRequest } from 'fastify';
import { PublishRequestSchema, SaveDraftRequestSchema } from '@six7swe/knowledge-types';
import { z } from 'zod';
import type { KnowledgeConfig } from '../../config/knowledge';
import { isKnowledgeOwner } from '../../services/knowledge/ownerGate';
import {
  forwardToKnowledge,
  UPLOAD_TIMEOUT_MS,
  type ProxyRequest,
  type ProxyResponse,
} from '../../services/knowledge/ownerProxy';
import type { FetchLike } from '../../services/knowledge/transport';

/**
 * Handlers for the knowledge owner proxy. Each one builds the service path
 * itself from validated input, so a client cannot steer the request to
 * another service route. The owner gate (routes/knowledge.ts) has already
 * run when these are called.
 */

const DocumentParamsSchema = z.object({ id: z.uuid() });
/** Mirrors the service's document kinds; the service validates again. */
const UploadQuerySchema = z.object({ kind: z.enum(['resume', 'supporting']).optional() });
/** Mirrors the service's retrieve request (query up to 2000 characters, k from 1 to 20). */
const SearchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    k: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export interface KnowledgeHandlerDeps {
  config: KnowledgeConfig;
  fetch?: FetchLike;
  /** Called after a profile is published, to bust the portfolio cache. */
  onProfilePublished?: () => void;
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
}

export function knowledgeHandlers(deps: KnowledgeHandlerDeps) {
  async function forward(
    req: FastifyRequest,
    reply: FastifyReply,
    proxied: ProxyRequest,
    timeoutMs?: number,
    /** Runs on the service's answer, before it is relayed. */
    onResult?: (result: ProxyResponse) => void,
  ) {
    const { target } = deps.config;
    if (!target) {
      return reply.code(503).send({ error: 'The knowledge service is not configured.' });
    }
    const result = await forwardToKnowledge(target, proxied, {
      fetch: deps.fetch,
      timeoutMs,
      onFailure: (message, details) => req.log.error(details, message),
    });
    onResult?.(result);
    reply.code(result.status);
    return result.body === undefined ? reply.send() : reply.send(result.body);
  }

  /** Validates `:id` as a UUID (400 otherwise) and builds the request from it. */
  /** Forwards a validated JSON body. */
  function withJsonBody<T>(
    schema: z.ZodType<T>,
    build: (body: T) => Omit<ProxyRequest, 'body' | 'contentType'>,
    onResult?: (result: ProxyResponse) => void,
  ): Handler {
    return async (req, reply) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      return forward(
        req,
        reply,
        {
          ...build(parsed.data),
          body: JSON.stringify(parsed.data),
          contentType: 'application/json',
        },
        undefined,
        onResult,
      );
    };
  }

  function withDocumentId(build: (id: string) => ProxyRequest): Handler {
    return async (req, reply) => {
      const parsed = DocumentParamsSchema.safeParse(req.params);
      if (!parsed.success) return badRequest(reply, parsed.error);
      return forward(req, reply, build(encodeURIComponent(parsed.data.id)));
    };
  }

  return {
    /** Whether the signed-in user is the owner; drives the nav entry. Any signed-in user may ask. */
    async access(_req: FastifyRequest, reply: FastifyReply) {
      const isOwner = isKnowledgeOwner(requestContext.get('user'), deps.config.ownerAuthId);
      return reply.send({ isOwner });
    },

    async listDocuments(req: FastifyRequest, reply: FastifyReply) {
      return forward(req, reply, { method: 'GET', path: '/documents' });
    },

    /** Relays the multipart body unchanged; the service enforces the type and size limits. */
    async uploadDocument(req: FastifyRequest, reply: FastifyReply) {
      const query = UploadQuerySchema.safeParse(req.query);
      if (!query.success) return badRequest(reply, query.error);
      const contentType = req.headers['content-type'];
      if (!Buffer.isBuffer(req.body) || !contentType?.startsWith('multipart/form-data')) {
        return reply.code(415).send({ error: 'Expected a multipart/form-data upload' });
      }
      const search = query.data.kind ? `?kind=${query.data.kind}` : '';
      return forward(
        req,
        reply,
        { method: 'POST', path: `/documents${search}`, body: req.body, contentType },
        UPLOAD_TIMEOUT_MS,
      );
    },

    getDocument: withDocumentId((id) => ({ method: 'GET', path: `/documents/${id}` })),

    getDocumentText: withDocumentId((id) => ({ method: 'GET', path: `/documents/${id}/text` })),

    setPrimaryResume: withDocumentId((id) => ({
      method: 'PUT',
      path: `/documents/${id}/primary`,
    })),

    deleteDocument: withDocumentId((id) => ({ method: 'DELETE', path: `/documents/${id}` })),

    /** The "ask as a visitor" playground: the same retrieval the chat will use. */
    async search(req: FastifyRequest, reply: FastifyReply) {
      const body = SearchBodySchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      return forward(req, reply, {
        method: 'POST',
        path: '/search',
        body: JSON.stringify(body.data),
        contentType: 'application/json',
      });
    },

    /** The draft, the published profile and the drafting status, for the review screen. */
    async getProfile(req: FastifyRequest, reply: FastifyReply) {
      return forward(req, reply, { method: 'GET', path: '/profile' });
    },

    /** Saves the owner's edits to the draft; validated here and again by the service. */
    saveProfileDraft: withJsonBody(SaveDraftRequestSchema, () => ({
      method: 'PUT',
      path: '/profile/draft',
    })),

    /** Drafts again from the primary resume (202; the service drafts in the background). */
    async redraftProfile(req: FastifyRequest, reply: FastifyReply) {
      return forward(req, reply, { method: 'POST', path: '/profile/draft' });
    },

    async discardProfileDraft(req: FastifyRequest, reply: FastifyReply) {
      return forward(req, reply, { method: 'DELETE', path: '/profile/draft' });
    },

    /** Publishes the reviewed draft, then busts the portfolio cache so the landing page shows it. */
    publishProfile: withJsonBody(
      PublishRequestSchema,
      () => ({ method: 'POST', path: '/profile/publish' }),
      (result) => {
        if (result.status === 200) deps.onProfilePublished?.();
      },
    ),
  };
}
