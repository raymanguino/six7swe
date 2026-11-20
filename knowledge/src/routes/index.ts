import type { FastifyInstance } from 'fastify';
import { MCP_ROUTE, OWNER_ROUTE, PUBLIC_ROUTE, SERVICE_ROUTE } from '../plugins/serviceAuth.js';
import type { KnowledgeContext } from './context.js';
import { documentHandlers } from './handlers/documentHandlers.js';
import { evalHandlers } from './handlers/evalHandlers.js';
import { mcpHandlers } from './handlers/mcpHandlers.js';
import { resumeHandlers } from './handlers/resumeHandlers.js';
import { retrievalHandlers } from './handlers/retrievalHandlers.js';

/**
 * Every route declares who may call it (see plugins/serviceAuth.ts). A route
 * without a declaration is treated as `service`.
 */
export function registerRoutes(app: FastifyInstance, ctx: KnowledgeContext): void {
  const documents = documentHandlers(ctx);
  const retrieval = retrievalHandlers(ctx);
  const resume = resumeHandlers(ctx);
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
  // The risk scan's review gate (#212): the findings, and approving them as they are.
  app.get('/documents/:id/findings', OWNER_ROUTE, documents.findings);
  app.post('/documents/:id/approve', OWNER_ROUTE, documents.approve);
  app.put('/documents/:id/primary', OWNER_ROUTE, documents.setPrimary);
  app.delete('/documents/:id', OWNER_ROUTE, documents.remove);
  // The same retrieval as `/retrieve`, for the owner's "ask as a visitor" playground.
  app.post('/search', OWNER_ROUTE, retrieval.search);

  // The evolving chat eval set (#85): its questions, the latest run and the
  // owner's controls.
  app.get('/eval', OWNER_ROUTE, evaluation.state);
  app.post('/eval/runs', OWNER_ROUTE, evaluation.run);
  app.post('/eval/questions/:id', OWNER_ROUTE, evaluation.act);

  // The primary resume's PDF, which the backend serves as `/resume`.
  app.get('/resume.pdf', SERVICE_ROUTE, resume.resumePdf);

  // MCP adapter for personal Claude clients (#89): the owner key as a bearer token.
  app.post('/mcp', MCP_ROUTE, mcp.handle);
  app.get('/mcp', MCP_ROUTE, mcp.notAllowed);
  app.delete('/mcp', MCP_ROUTE, mcp.notAllowed);
}
