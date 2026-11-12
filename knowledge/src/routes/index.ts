import type { FastifyInstance } from 'fastify';
import { PUBLIC_ROUTE } from '../plugins/serviceAuth.js';
import type { KnowledgeContext } from './context.js';
import { documentHandlers } from './handlers/documentHandlers.js';
import { retrievalHandlers } from './handlers/retrievalHandlers.js';

/**
 * Every route needs the service key unless it is registered with
 * `PUBLIC_ROUTE` (see plugins/serviceAuth.ts).
 */
export function registerRoutes(app: FastifyInstance, ctx: KnowledgeContext): void {
  const documents = documentHandlers(ctx);
  const retrieval = retrievalHandlers(ctx);

  app.get('/health', PUBLIC_ROUTE, async () => ({ status: 'ok' }));

  // Service-to-service.
  app.post('/retrieve', retrieval.retrieve);
  app.get('/version', retrieval.version);

  // Owner. Behind the service key until the owner JWT gate lands.
  app.post('/documents', documents.upload);
  app.get('/documents', documents.list);
  app.get('/documents/:id', documents.get);
  app.delete('/documents/:id', documents.remove);
}
