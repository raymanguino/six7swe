import { MAX_RETRIEVE_K } from '@six7swe/knowledge-types';

/**
 * How the portfolio chat reaches the knowledge service when
 * `PORTFOLIO_DATA_SOURCE=knowledge`.
 *
 * `KNOWLEDGE_SERVICE_URL` is the service's base URL (on Railway, the private
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
  /** Cached retrievals kept, least recently used evicted first. */
  cacheEntries: number;
}

export const DEFAULT_CHAT_RETRIEVE_K = 6;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_VERSION_TTL_MS = 30_000;
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

/** Null when the service is not configured; chat then answers from the profile only. */
export function getKnowledgeRetrievalConfig(
  env: Record<string, string | undefined> = process.env,
): KnowledgeRetrievalConfig | null {
  const baseUrl = env.KNOWLEDGE_SERVICE_URL?.trim();
  const serviceKey = env.KNOWLEDGE_SERVICE_KEY?.trim();
  if (!baseUrl || !serviceKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    serviceKey,
    k: positiveInt(env.KNOWLEDGE_RETRIEVE_K, DEFAULT_CHAT_RETRIEVE_K, MAX_RETRIEVE_K),
    timeoutMs: positiveInt(env.KNOWLEDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    versionTtlMs: DEFAULT_VERSION_TTL_MS,
    cacheEntries: DEFAULT_CACHE_ENTRIES,
  };
}
