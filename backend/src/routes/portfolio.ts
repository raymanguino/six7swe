import { FastifyInstance } from 'fastify';
import { PUBLIC_ROUTE } from './access';
import * as resumeHandlers from './handlers/resumeHandlers';
import * as chatHandlers from './handlers/chatHandlers';
import * as fitcheckHandlers from './handlers/fitcheckHandlers';
import * as contactHandlers from './handlers/contactHandlers';
import { registerChatRoute } from './chatRateLimit';
import { registerPublicMcpRoutes } from './publicMcp';

/**
 * Public portfolio product.
 *
 * These routes back the personal portfolio site: resume
 * download, the AI assistant, the fit checker and the contact form, plus the
 * public MCP server (#205) for anyone's AI client. They are intentionally
 * unauthenticated.
 */
export async function registerPortfolioRoutes(app: FastifyInstance): Promise<void> {
  app.get('/resume', PUBLIC_ROUTE, resumeHandlers.resumeHandler);
  // Rate limited per client: every message is a model call.
  await registerChatRoute(app, chatHandlers.chatHandler);
  app.post('/fitcheck', PUBLIC_ROUTE, fitcheckHandlers.fitcheckHandler);
  app.post('/contact', PUBLIC_ROUTE, contactHandlers.contactHandler);
  // Rate limited per client, and searches capped per day: each one is an embedding.
  await registerPublicMcpRoutes(app);
}
