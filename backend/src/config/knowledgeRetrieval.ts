import { z } from 'zod';
import { DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K } from '@six7swe/knowledge-types';
import { normalizeKnowledgeUrl } from './knowledgeUrl';
import { positiveInt } from './positiveInt';

/**
 * How the backend reaches the knowledge service for the portfolio and chat.
 *
 * `KNOWLEDGE_URL` is the service's base URL, the same variable the owner proxy
 * uses (on Railway, the private address `http://six7sweknowledge.railway.internal:3100`).
 * `KNOWLEDGE_SERVICE_KEY` is the service key, the same value the knowledge
 * service has; it opens `/retrieve`, `/version`, `/profile/published` and
 * `/resume.pdf` only.
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

const URL_PROBLEM = 'must be set to a valid http(s) URL without credentials, query or fragment';

/**
 * The two variables the backend cannot work without, validated in one place for the config
 * reader and the startup check. Messages name the variable, never its value: the URL may
 * carry credentials.
 */
const connectionSchema = z.object({
  KNOWLEDGE_URL: z.string({ error: URL_PROBLEM }).transform((raw, ctx) => {
    const url = normalizeKnowledgeUrl(raw);
    if (url === null) {
      ctx.addIssue({ code: 'custom', message: URL_PROBLEM });
      return z.NEVER;
    }
    return url;
  }),
  KNOWLEDGE_SERVICE_KEY: z
    .string({ error: 'must be set' })
    .transform((raw) => raw.trim())
    .pipe(z.string().min(1, 'must be set')),
});

type Env = Record<string, string | undefined>;

/** Null when the service is not configured. */
export function getKnowledgeRetrievalConfig(
  env: Env = process.env,
): KnowledgeRetrievalConfig | null {
  const connection = connectionSchema.safeParse(env);
  if (!connection.success) return null;
  return {
    baseUrl: connection.data.KNOWLEDGE_URL,
    serviceKey: connection.data.KNOWLEDGE_SERVICE_KEY,
    k: positiveInt(env.KNOWLEDGE_RETRIEVE_K, DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K),
    timeoutMs: positiveInt(env.KNOWLEDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    versionTtlMs: DEFAULT_VERSION_TTL_MS,
    failureCooldownMs: DEFAULT_FAILURE_COOLDOWN_MS,
    cacheEntries: DEFAULT_CACHE_ENTRIES,
  };
}

/**
 * Called at startup. The portfolio reads only from the knowledge service, so a
 * missing URL or key is a deploy mistake: the server refuses to start rather
 * than serve a site with no data. Outages are handled per request instead.
 */
export function assertKnowledgeRetrievalConfigured(env: Env = process.env): void {
  const connection = connectionSchema.safeParse(env);
  if (connection.success) return;
  const problems = connection.error.issues.map(
    (issue) => `${issue.path.join('.')} ${issue.message}`,
  );
  throw new Error(`The portfolio requires the knowledge service: ${problems.join('; ')}`);
}
