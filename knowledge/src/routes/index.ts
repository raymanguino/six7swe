import type { FastifyInstance } from 'fastify';
import { MCP_ROUTE, OWNER_ROUTE, PUBLIC_ROUTE, SERVICE_ROUTE } from '../plugins/serviceAuth.js';
import type { KnowledgeContext } from './context.js';
import { documentHandlers } from './handlers/documentHandlers.js';
import { evalHandlers } from './handlers/evalHandlers.js';
import { mcpHandlers } from './handlers/mcpHandlers.js';
import { profileHandlers } from './handlers/profileHandlers.js';
import { retrievalHandlers } from './handlers/retrievalHandlers.js';

/** Request body limit for a saved draft profile. */
export const PROFILE_BODY_LIMIT = 512 * 1024;

/**
 * Every route declares who may call it (see plugins/serviceAuth.ts). A route
 * without a declaration is treated as `service`.
 */
export function registerRoutes(app: FastifyInstance, ctx: KnowledgeContext): void {
  const documents = documentHandlers(ctx);
  const retrieval = retrievalHandlers(ctx);
  const profile = profileHandlers(ctx);
  const evaluation = evalHandlers(ctx);
  const mcp = mcpHandlers(ctx);

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
  app.post('/search', OWNER_ROUTE, retrieval.search);

  // The evolving chat eval set (#85): its questions, the latest run and the
  // owner's controls.
  app.get('/eval', OWNER_ROUTE, evaluation.state);
  app.post('/eval/runs', OWNER_ROUTE, evaluation.run);
  app.post('/eval/questions/:id', OWNER_ROUTE, evaluation.act);

  // The structured profile (#86). The portfolio reads the published one and
  // the primary resume's PDF with the service key; the owner reviews,
  // edits and publishes drafts through the backend's owner proxy.
  app.get('/profile/published', SERVICE_ROUTE, profile.published);
  app.get('/resume.pdf', SERVICE_ROUTE, profile.resumePdf);
  app.get('/profile', OWNER_ROUTE, profile.state);
  // A full profile can outgrow the app's 64 KB JSON limit.
  app.put('/profile/draft', { ...OWNER_ROUTE, bodyLimit: PROFILE_BODY_LIMIT }, profile.saveDraft);
  app.post('/profile/draft', OWNER_ROUTE, profile.redraft);
  app.delete('/profile/draft', OWNER_ROUTE, profile.discardDraft);
  app.post('/profile/publish', OWNER_ROUTE, profile.publish);

  // MCP adapter for personal Claude clients (#89): the owner key as a bearer token.
  app.post('/mcp', MCP_ROUTE, mcp.handle);
  app.get('/mcp', MCP_ROUTE, mcp.notAllowed);
  app.delete('/mcp', MCP_ROUTE, mcp.notAllowed);
}
