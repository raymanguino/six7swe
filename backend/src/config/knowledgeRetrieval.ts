import { DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K } from '@six7swe/knowledge-types';
import { getPortfolioDataSource } from './portfolioMcp';

/**
 * How the portfolio chat reaches the knowledge service when
 * `PORTFOLIO_DATA_SOURCE=knowledge`.
 *
 * `KNOWLEDGE_URL` is the service's base URL, the same variable the owner proxy uses (on Railway, the private
 * address `http://six7sweknowledge.railway.internal:3100`).
 * `KNOWLEDGE_SERVICE_KEY` is the service key, the same value the knowledge
 * service has; it opens `/retrieve` and `/version` only.
 */
export interface KnowledgeRetrievalConfig {
  baseUrl: string;
  serviceKey: string;
  /** Chunks retrieved per question. */
  k: number;
  /** Per-request timeout. A slow service must not hold up the chat. */
  timeoutMs: number;
  /** How long a fetched corpus version is trusted before asking again. */
  versionTtlMs: number;
  /**
   * After a failed call, how long every uncached retrieval fails fast instead
   * of waiting on the service again, so an outage costs one timeout, not one
   * per chat turn.
   */
  failureCooldownMs: number;
  /** Cached retrievals kept, least recently used evicted first. */
  cacheEntries: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_VERSION_TTL_MS = 30_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 15_000;
const DEFAULT_CACHE_ENTRIES = 200;

function positiveInt(
  raw: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Null when the service is not configured. */
export function getKnowledgeRetrievalConfig(
  env: Record<string, string | undefined> = process.env,
): KnowledgeRetrievalConfig | null {
  const baseUrl = env.KNOWLEDGE_URL?.trim();
  const serviceKey = env.KNOWLEDGE_SERVICE_KEY?.trim();
  if (!baseUrl || !serviceKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    serviceKey,
    k: positiveInt(env.KNOWLEDGE_RETRIEVE_K, DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K),
    timeoutMs: positiveInt(env.KNOWLEDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    versionTtlMs: DEFAULT_VERSION_TTL_MS,
    failureCooldownMs: DEFAULT_FAILURE_COOLDOWN_MS,
    cacheEntries: DEFAULT_CACHE_ENTRIES,
  };
}

/**
 * Called at startup. `PORTFOLIO_DATA_SOURCE=knowledge` without the URL or key
 * is a deploy mistake, so the server refuses to start rather than quietly
 * answering every chat from the profile alone. Outages are handled per
 * request instead.
 */
export function assertKnowledgeRetrievalConfigured(): void {
  if (getPortfolioDataSource() !== 'knowledge') return;
  if (!getKnowledgeRetrievalConfig()) {
    throw new Error(
      'PORTFOLIO_DATA_SOURCE=knowledge requires KNOWLEDGE_URL and KNOWLEDGE_SERVICE_KEY',
    );
  }
}
