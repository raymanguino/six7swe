import { requestContext } from '@fastify/request-context';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KnowledgeConfig } from '../../config/knowledge';
import { isKnowledgeOwner } from '../../services/knowledge/ownerGate';
import {
  forwardToKnowledge,
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

export interface KnowledgeHandlerDeps {
  config: KnowledgeConfig;
  fetch?: FetchLike;
}

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: 'Invalid request', issues: error.issues });
}

export function knowledgeHandlers(deps: KnowledgeHandlerDeps) {
  async function forward(req: FastifyRequest, reply: FastifyReply, proxied: ProxyRequest) {
    const { target } = deps.config;
    if (!target) {
      return reply.code(503).send({ error: 'The knowledge service is not configured.' });
    }
    const result = await forwardToKnowledge(target, proxied, {
      fetch: deps.fetch,
      onFailure: (message, details) => req.log.error(details, message),
    });
    reply.code(result.status);
    return result.body === undefined ? reply.send() : reply.send(result.body);
  }

  function documentId(req: FastifyRequest): string | z.ZodError {
    const parsed = DocumentParamsSchema.safeParse(req.params);
    return parsed.success ? encodeURIComponent(parsed.data.id) : parsed.error;
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
      return forward(req, reply, {
        method: 'POST',
        path: `/documents${search}`,
        body: req.body,
        contentType,
      });
    },

    async getDocument(req: FastifyRequest, reply: FastifyReply) {
      const id = documentId(req);
      if (id instanceof z.ZodError) return badRequest(reply, id);
      return forward(req, reply, { method: 'GET', path: `/documents/${id}` });
    },

    async getDocumentText(req: FastifyRequest, reply: FastifyReply) {
      const id = documentId(req);
      if (id instanceof z.ZodError) return badRequest(reply, id);
      return forward(req, reply, { method: 'GET', path: `/documents/${id}/text` });
    },

    async setPrimaryResume(req: FastifyRequest, reply: FastifyReply) {
      const id = documentId(req);
      if (id instanceof z.ZodError) return badRequest(reply, id);
      return forward(req, reply, { method: 'PUT', path: `/documents/${id}/primary` });
    },

    async deleteDocument(req: FastifyRequest, reply: FastifyReply) {
      const id = documentId(req);
      if (id instanceof z.ZodError) return badRequest(reply, id);
      return forward(req, reply, { method: 'DELETE', path: `/documents/${id}` });
    },

    /** The "ask as a visitor" playground: the same retrieval the chat will use. */
    async search(req: FastifyRequest, reply: FastifyReply) {
      return forward(req, reply, {
        method: 'POST',
        path: '/search',
        body: JSON.stringify(req.body ?? {}),
        contentType: 'application/json',
      });
    },
  };
}
