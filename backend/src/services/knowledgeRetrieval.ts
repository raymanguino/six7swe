import {
  RetrieveResponseSchema,
  SERVICE_KEY_HEADER,
  VersionResponseSchema,
  type RetrieveResponse,
  type RetrievedChunkDto,
} from '@six7swe/knowledge-types';
import type { z } from 'zod';
import {
  getKnowledgeRetrievalConfig,
  type KnowledgeRetrievalConfig,
} from '../config/knowledgeRetrieval';

/**
 * Chat-side retrieval from the knowledge service: an HTTP client for
 * `/version` and `/retrieve`, and a cache keyed by
 * `(corpus_version, normalized question)`.
 *
 * The corpus version is part of the key, so an upload or delete in the
 * knowledge service makes every cached answer miss without any invalidation
 * call. The version itself is re-read at most every `versionTtlMs`, so a
 * corpus change reaches chat within that window.
 */

export class KnowledgeRetrievalError extends Error {
  /** The underlying failure, if any (network error, zod issues). */
  readonly reason: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'KnowledgeRetrievalError';
    this.reason = options?.cause;
  }
}

export interface RetrievalClient {
  getVersion(): Promise<number>;
  retrieve(query: string, k: number): Promise<RetrieveResponse>;
}

type FetchFn = typeof fetch;

export function createHttpRetrievalClient(
  config: Pick<KnowledgeRetrievalConfig, 'baseUrl' | 'serviceKey' | 'timeoutMs'>,
  fetchFn: FetchFn = fetch,
): RetrievalClient {
  async function call(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          [SERVICE_KEY_HEADER]: config.serviceKey,
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      throw new KnowledgeRetrievalError(`Knowledge service ${path} unreachable`, { cause: err });
    }
    if (!res.ok) {
      throw new KnowledgeRetrievalError(`Knowledge service ${path} answered ${res.status}`);
    }
    try {
      return (await res.json()) as unknown;
    } catch (err) {
      throw new KnowledgeRetrievalError(`Knowledge service ${path} sent invalid JSON`, {
        cause: err,
      });
    }
  }

  function parse<T>(path: string, schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new KnowledgeRetrievalError(
        `Knowledge service ${path} response did not match the contract`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  return {
    async getVersion() {
      const body = await call('/version', { method: 'GET' });
      return parse('/version', VersionResponseSchema, body).version;
    },
    async retrieve(query, k) {
      const body = await call('/retrieve', { method: 'POST', body: JSON.stringify({ query, k }) });
      return parse('/retrieve', RetrieveResponseSchema, body);
    },
  };
}

/**
 * Case, Unicode form, whitespace and trailing punctuation do not change what a
 * question asks, so they do not split the cache.
 */
export function normalizeQuestion(question: string): string {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?!.]+$/, '');
}

export interface CachedRetrieverOptions {
  k: number;
  versionTtlMs: number;
  maxEntries: number;
  now?: () => number;
}

export interface CachedRetriever {
  retrieve(query: string): Promise<RetrievedChunkDto[]>;
}

export function createCachedRetriever(
  client: RetrievalClient,
  options: CachedRetrieverOptions,
): CachedRetriever {
  const now = options.now ?? Date.now;
  // A Map keeps insertion order; re-inserting on a hit makes it an LRU.
  const entries = new Map<string, RetrievedChunkDto[]>();
  let knownVersion: { value: number; fetchedAt: number } | null = null;

  async function currentVersion(): Promise<number> {
    if (knownVersion && now() - knownVersion.fetchedAt < options.versionTtlMs) {
      return knownVersion.value;
    }
    const value = await client.getVersion();
    knownVersion = { value, fetchedAt: now() };
    return value;
  }

  function store(key: string, chunks: RetrievedChunkDto[]): void {
    entries.delete(key);
    entries.set(key, chunks);
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    async retrieve(query) {
      const normalized = normalizeQuestion(query);
      const version = await currentVersion();
      const key = `${version}\u0000${normalized}`;
      const hit = entries.get(key);
      if (hit) {
        store(key, hit);
        return hit;
      }
      const result = await client.retrieve(query, options.k);
      // The corpus may have moved on since the version was read; file the
      // result under the version it was actually computed against.
      if (result.version !== version) {
        knownVersion = { value: result.version, fetchedAt: now() };
      }
      store(`${result.version}\u0000${normalized}`, result.chunks);
      return result.chunks;
    },
  };
}

let defaultRetriever: CachedRetriever | null | undefined;

/**
 * The process-wide retriever built from the environment, or null when
 * `KNOWLEDGE_SERVICE_URL` / `KNOWLEDGE_SERVICE_KEY` are not set.
 */
export function getDefaultRetriever(): CachedRetriever | null {
  if (defaultRetriever === undefined) {
    const config = getKnowledgeRetrievalConfig();
    defaultRetriever = config
      ? createCachedRetriever(createHttpRetrievalClient(config), {
          k: config.k,
          versionTtlMs: config.versionTtlMs,
          maxEntries: config.cacheEntries,
        })
      : null;
  }
  return defaultRetriever;
}

/** For tests: forget the retriever so the next call reads the environment again. */
export function resetDefaultRetriever(): void {
  defaultRetriever = undefined;
}
