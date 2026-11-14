import type { FastifyInstance } from 'fastify';
import { OWNER_ROUTE, PUBLIC_ROUTE, SERVICE_ROUTE } from '../plugins/serviceAuth.js';
import type { KnowledgeContext } from './context.js';
import { documentHandlers } from './handlers/documentHandlers.js';
import { retrievalHandlers } from './handlers/retrievalHandlers.js';

/**
 * Every route declares who may call it (see plugins/serviceAuth.ts). A route
 * without a declaration is treated as `service`.
 */
export function registerRoutes(app: FastifyInstance, ctx: KnowledgeContext): void {
  const documents = documentHandlers(ctx);
  const retrieval = retrievalHandlers(ctx);

  app.get('/health', PUBLIC_ROUTE, async () => ({ status: 'ok' }));

  // Service-to-service.
  app.post('/retrieve', SERVICE_ROUTE, retrieval.retrieve);
  app.get('/version', SERVICE_ROUTE, retrieval.version);

  // Owner: the backend's owner proxy, with the owner key, once it has checked
  // that the signed-in user is the owner.
  app.post('/documents', OWNER_ROUTE, documents.upload);
  app.get('/documents', OWNER_ROUTE, documents.list);
  app.get('/documents/:id', OWNER_ROUTE, documents.get);
  app.get('/documents/:id/text', OWNER_ROUTE, documents.text);
  app.put('/documents/:id/primary', OWNER_ROUTE, documents.setPrimary);
  app.delete('/documents/:id', OWNER_ROUTE, documents.remove);
  // The same retrieval as `/retrieve`, for the owner's "ask as a visitor" playground.
  app.post('/search', OWNER_ROUTE, retrieval.retrieve);
}
