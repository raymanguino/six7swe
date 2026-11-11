import { FastifyInstance } from 'fastify';
import { PUBLIC_ROUTE } from './access';
import * as portfolioHandlers from './handlers/portfolioHandlers';
import * as resumeHandlers from './handlers/resumeHandlers';
import * as chatHandlers from './handlers/chatHandlers';
import * as fitcheckHandlers from './handlers/fitcheckHandlers';
import * as contactHandlers from './handlers/contactHandlers';

/**
 * Public portfolio product.
 *
 * These routes back the personal portfolio site: profile metadata, resume
 * download, the AI assistant, the fit checker and the contact form. They are
 * intentionally unauthenticated.
 */
export async function registerPortfolioRoutes(app: FastifyInstance): Promise<void> {
  app.get('/portfolio', PUBLIC_ROUTE, portfolioHandlers.getPortfolioHandler);
  app.get('/resume', PUBLIC_ROUTE, resumeHandlers.resumeHandler);
  app.post('/chat', PUBLIC_ROUTE, chatHandlers.chatHandler);
  app.post('/fitcheck', PUBLIC_ROUTE, fitcheckHandlers.fitcheckHandler);
  app.post('/contact', PUBLIC_ROUTE, contactHandlers.contactHandler);
}
