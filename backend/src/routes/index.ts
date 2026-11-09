import { FastifyInstance } from 'fastify';
import { registerPortfolioRoutes } from './portfolio';
import { registerJobHuntRoutes } from './jobHunt';

export * from './access';

/**
 * Registers every HTTP route.
 *
 * The API is split by product:
 *   - ./portfolio -> public portfolio site and its AI endpoints
 *   - ./jobHunt   -> job-search product, scoped under /job-hunt/*
 */
export default async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerPortfolioRoutes(app);
  await registerJobHuntRoutes(app);
}

