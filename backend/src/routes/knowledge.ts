import { requestContext } from '@fastify/request-context';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadKnowledgeConfig, type KnowledgeConfig } from '../config/knowledge';
import { UnauthenticatedUser } from '../constants';
import { isKnowledgeOwner } from '../services/knowledge/ownerGate';
import type { FetchLike } from '../services/knowledge/ownerProxy';
import { PRIVATE_ROUTE } from './access';
import { knowledgeHandlers } from './handlers/knowledgeHandlers';

/**
 * The knowledge owner proxy, under `/knowledge/*`.
 *
 * The knowledge service is private-network only, so the owner's Knowledge
 * page reaches its owner routes through here. The backend verifies the
 * Supabase JWT (the auth plugin), requires `sub === OWNER_AUTH_ID` (403 for
 * anyone else), then forwards the request with the owner key.
 */

/**
 * Upload body limit. The service enforces its own `MAX_UPLOAD_BYTES` (at most
 * 50 MB) and answers 413; this only stops the backend buffering more than the
 * largest upload the service could accept, plus room for the multipart framing.
 */
export const KNOWLEDGE_UPLOAD_BODY_LIMIT = 51 * 1024 * 1024;

export interface KnowledgeRoutesOptions {
  /** Defaults to the environment (`loadKnowledgeConfig`). */
  config?: KnowledgeConfig;
  /** Overrides the HTTP client, for tests. */
  fetch?: FetchLike;
}

/**
 * Registers the knowledge routes in their own encapsulated scope, so the
 * multipart parser and the owner gate apply to them and nothing else.
 */
export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: KnowledgeRoutesOptions = {},
): Promise<void> {
  // Read once at boot: a malformed value fails the start, not a request.
  const config = options.config ?? loadKnowledgeConfig();
  const handlers = knowledgeHandlers({ config, fetch: options.fetch });

  await app.register(async (scope) => {
    // Any signed-in user may ask whether they are the owner; the answer only
    // decides whether the frontend shows the Knowledge nav entry.
    scope.get('/knowledge/access', PRIVATE_ROUTE, handlers.access);

    await scope.register(async (owner) => {
      // The gate runs on `onRequest`, after the auth plugin has resolved the
      // user and before the body is read, so a non-owner's upload is refused
      // without being buffered. The global preHandler would answer 401 too,
      // but only after parsing, so the gate checks authentication itself.
      owner.addHook('onRequest', async (_req: FastifyRequest, reply: FastifyReply) => {
        const user = requestContext.get('user');
        if (!user || user === UnauthenticatedUser) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        if (!isKnowledgeOwner(user, config.ownerAuthId)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }
      });

      // Uploads are relayed byte for byte, so the multipart body is kept raw.
      owner.addContentTypeParser(
        'multipart/form-data',
        { parseAs: 'buffer', bodyLimit: KNOWLEDGE_UPLOAD_BODY_LIMIT },
        (_req, body, done) => done(null, body),
      );

      owner.get('/knowledge/documents', PRIVATE_ROUTE, handlers.listDocuments);
      owner.post('/knowledge/documents', PRIVATE_ROUTE, handlers.uploadDocument);
      owner.get('/knowledge/documents/:id', PRIVATE_ROUTE, handlers.getDocument);
      owner.get('/knowledge/documents/:id/text', PRIVATE_ROUTE, handlers.getDocumentText);
      owner.put('/knowledge/documents/:id/primary', PRIVATE_ROUTE, handlers.setPrimaryResume);
      owner.delete('/knowledge/documents/:id', PRIVATE_ROUTE, handlers.deleteDocument);
      owner.post('/knowledge/search', PRIVATE_ROUTE, handlers.search);
    });
  });
}
