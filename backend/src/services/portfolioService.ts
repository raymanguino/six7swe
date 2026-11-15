import type { PortfolioData } from '../types/portfolio';
import { positiveInt } from '../config/positiveInt';
import { getDefaultProfileClient } from './knowledge/profileClient';
import { mapPublishedProfile } from './knowledge/profileMapping';
import { createSwrCache } from './staleWhileRevalidate';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_TTL_MS = positiveInt(process.env.PORTFOLIO_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
/** After a failed refresh, how long the last good data is served before trying again. */
const RETRY_AFTER_FAILURE_MS = 30_000;

/**
 * Where refresh failures are logged. They happen outside any request, so the
 * server hands over its logger at startup (`setPortfolioLogger`); until then a
 * plain pino logger keeps them structured.
 */
let log: Pick<FastifyBaseLogger, 'warn'> = pino({ name: 'portfolio' });

export function setPortfolioLogger(logger: Pick<FastifyBaseLogger, 'warn'>): void {
  log = logger;
}

/**
 * The profile the owner published in the knowledge service (#86), the portfolio's
 * only source. `profile` is null until the owner publishes one.
 */
async function fetchPortfolioData(): Promise<PortfolioData> {
  const client = getDefaultProfileClient();
  if (!client) {
    throw new Error('The portfolio requires KNOWLEDGE_URL and KNOWLEDGE_SERVICE_KEY');
  }
  return mapPublishedProfile(await client.getPublished());
}

/**
 * Stale-while-revalidate: once loaded, the portfolio is always answered from
 * memory, and refreshed in the background after the TTL. If the knowledge
 * service is down, the last good profile keeps being served.
 */
const cache = createSwrCache(fetchPortfolioData, {
  ttlMs: CACHE_TTL_MS,
  retryAfterFailureMs: RETRY_AFTER_FAILURE_MS,
  onBackgroundError: (error) => {
    log.warn({ err: error }, 'Portfolio refresh failed; serving the last good profile');
  },
});

export async function getPortfolioData(): Promise<PortfolioData> {
  return cache.get();
}

/**
 * Busts the cache: the next request waits for fresh data (falling back to the
 * last good profile if the source is down). Called after the owner publishes
 * a profile.
 */
export function clearPortfolioCache(): void {
  cache.invalidate();
}
