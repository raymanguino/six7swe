import { DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K } from '@six7swe/knowledge-types';
import { normalizeKnowledgeUrl } from './knowledgeUrl';

/**
 * How chat, fitcheck, `/resume` and the job hunter reach the knowledge
 * service, the only source of the owner's background.
 *
 * `KNOWLEDGE_URL` is the service's base URL, the same variable the owner proxy
 * uses (on Railway, the private address `http://six7sweknowledge.railway.internal:3100`).
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
/**
 * The staleness bound of every version-keyed chat and fitcheck cache: a corpus change
 * (upload, delete) reaches each backend replica within this long, with no cache bust (#130).
 */
export const DEFAULT_VERSION_TTL_MS = 30_000;
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
  // An unset or malformed URL (not http or https) counts as not configured.
  const baseUrl = env.KNOWLEDGE_URL ? normalizeKnowledgeUrl(env.KNOWLEDGE_URL) : null;
  const serviceKey = env.KNOWLEDGE_SERVICE_KEY?.trim();
  if (!baseUrl || !serviceKey) return null;
  return {
    baseUrl,
    serviceKey,
    k: positiveInt(env.KNOWLEDGE_RETRIEVE_K, DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K),
    timeoutMs: positiveInt(env.KNOWLEDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    versionTtlMs: DEFAULT_VERSION_TTL_MS,
    failureCooldownMs: DEFAULT_FAILURE_COOLDOWN_MS,
    cacheEntries: DEFAULT_CACHE_ENTRIES,
  };
}

/**
 * Called at startup. In production the knowledge service is the only source of
 * background for chat, fitcheck and `/resume`, so a missing or malformed
 * `KNOWLEDGE_URL` or `KNOWLEDGE_SERVICE_KEY` is a deploy mistake and the server
 * refuses to start rather than quietly answering without background. Elsewhere
 * they are optional: chat then says the background is unavailable. Outages are
 * handled per request.
 */
export function assertKnowledgeRetrievalConfigured(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;
  // Name what is wrong, never the value: the URL may carry credentials.
  const url = env.KNOWLEDGE_URL;
  if (!url || normalizeKnowledgeUrl(url) === null) {
    throw new Error(
      'KNOWLEDGE_URL must be set to a valid http(s) URL without credentials, query or fragment',
    );
  }
  if (!env.KNOWLEDGE_SERVICE_KEY?.trim()) {
    throw new Error('KNOWLEDGE_SERVICE_KEY is required in production');
  }
}
