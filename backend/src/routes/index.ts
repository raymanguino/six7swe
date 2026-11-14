import { FastifyInstance } from 'fastify';
import { registerPortfolioRoutes } from './portfolio';
import { registerJobHuntRoutes } from './jobHunt';
import { registerKnowledgeRoutes } from './knowledge';
import { clearPortfolioCache } from '../services/portfolioService';

export * from './access';

/**
 * Registers every HTTP route.
 *
 * The API is split by product:
 *   - ./portfolio -> public portfolio site and its AI endpoints
 *   - ./jobHunt   -> job-search product, scoped under /job-hunt/*
 *   - ./knowledge -> owner-only proxy to the knowledge service, under /knowledge/*
 */
export default async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerPortfolioRoutes(app);
  await registerJobHuntRoutes(app);
  // A published profile shows on the landing page at the next request, not after the TTL.
  await registerKnowledgeRoutes(app, { onProfilePublished: clearPortfolioCache });
}
