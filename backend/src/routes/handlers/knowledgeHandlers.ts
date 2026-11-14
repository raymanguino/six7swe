import { requestContext } from '@fastify/request-context';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KnowledgeConfig } from '../../config/knowledge';
import { isKnowledgeOwner } from '../../services/knowledge/ownerGate';
import {
  forwardToKnowledge,
  UPLOAD_TIMEOUT_MS,
  type FetchLike,
  type ProxyRequest,
} from '../../services/knowledge/ownerProxy';

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
    reply.code(result.status);
    return result.body === undefined ? reply.send() : reply.send(result.body);
  }

  /** Validates `:id` as a UUID (400 otherwise) and builds the request from it. */
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
  };
}
