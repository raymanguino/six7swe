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
 *
 * An outage costs one timeout, not one per chat turn: after any failed call
 * the retriever fails fast for `failureCooldownMs`. During that window a
 * question already in the cache is still answered from it, under the last
 * known version.
 *
 * A success clears the cooldown only if its request started no earlier than
 * the failure: a failure recorded while the request was in flight is newer
 * news than the success, so its cooldown survives.
 */

export class KnowledgeRetrievalError extends Error {
  /** The HTTP status, when the service answered with one. */
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = 'KnowledgeRetrievalError';
    this.status = options?.status;
  }
}

export interface RetrievalClient {
  getVersion(): Promise<number>;
  retrieve(query: string, k: number): Promise<RetrieveResponse>;
}

type FetchFn = typeof fetch;

/**
 * Duck-typed: the abort reason is a DOMException, which is not an `Error`
 * instance in every realm (Jest's sandbox, for one).
 */
function errorField(err: unknown, field: 'name' | 'message'): string | undefined {
  if (typeof err !== 'object' || err === null || !(field in err)) return undefined;
  const value: unknown = (err as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function isTimeout(err: unknown): boolean {
  const name = errorField(err, 'name');
  return name === 'TimeoutError' || name === 'AbortError';
}

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
      throw new KnowledgeRetrievalError(
        isTimeout(err)
          ? `Knowledge service ${path} timed out after ${config.timeoutMs} ms`
          : `Knowledge service ${path} unreachable: ${errorField(err, 'message') ?? String(err)}`,
      );
    }
    if (!res.ok) {
      // Release the connection; the error body is not needed.
      await res.body?.cancel().catch(() => undefined);
      throw new KnowledgeRetrievalError(`Knowledge service ${path} answered ${res.status}`, {
        status: res.status,
      });
    }
    try {
      return (await res.json()) as unknown;
    } catch (err) {
      throw new KnowledgeRetrievalError(
        isTimeout(err)
          ? `Knowledge service ${path} timed out after ${config.timeoutMs} ms`
          : `Knowledge service ${path} sent invalid JSON`,
      );
    }
  }

  function parse<T>(path: string, schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new KnowledgeRetrievalError(
        `Knowledge service ${path} response did not match the contract`,
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
  failureCooldownMs: number;
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
  let versionInFlight: Promise<number> | null = null;
  // Orders requests against failures; millisecond timestamps can collide.
  let seq = 0;
  let lastFailure: { at: number; seq: number; error: unknown } | null = null;

  function coolingDown(): boolean {
    return lastFailure !== null && now() - lastFailure.at < options.failureCooldownMs;
  }

  function failFast(): never {
    const cause = lastFailure?.error;
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    throw new KnowledgeRetrievalError(`Knowledge service unavailable (cooling down)${detail}`, {
      status: cause instanceof KnowledgeRetrievalError ? cause.status : undefined,
    });
  }

  function recordFailure(error: unknown): void {
    lastFailure = { at: now(), seq: ++seq, error };
  }

  /** A success ends the cooldown unless a failure was recorded after the request began. */
  function clearFailureIfOlderThan(started: number): void {
    if (lastFailure !== null && lastFailure.seq < started) lastFailure = null;
  }

  /**
   * `/version` is authoritative: if it reports a lower version, the corpus was
   * reset or restored, so the known version follows it down and every cached
   * entry is dropped (old keys could otherwise be reached again). A version
   * learned from a `/retrieve` response is `monotonic`: a slow response can
   * carry an older version, so it only ever moves the known version up.
   */
  function learnVersion(value: number, { monotonic }: { monotonic: boolean }): void {
    if (knownVersion && value < knownVersion.value) {
      if (monotonic) {
        knownVersion = { value: knownVersion.value, fetchedAt: now() };
        return;
      }
      entries.clear();
    }
    knownVersion = { value, fetchedAt: now() };
  }

  async function fetchVersion(): Promise<number> {
    // Concurrent turns share one /version call.
    if (!versionInFlight) {
      const started = ++seq;
      versionInFlight = client
        .getVersion()
        .then((value) => {
          learnVersion(value, { monotonic: false });
          clearFailureIfOlderThan(started);
          return value;
        })
        .finally(() => {
          versionInFlight = null;
        });
    }
    return versionInFlight;
  }

  /** The version to key the cache with, or a throw when none can be had. */
  async function currentVersion(): Promise<number> {
    if (knownVersion && now() - knownVersion.fetchedAt < options.versionTtlMs) {
      return knownVersion.value;
    }
    if (coolingDown()) {
      if (knownVersion) return knownVersion.value;
      failFast();
    }
    try {
      return await fetchVersion();
    } catch (error) {
      recordFailure(error);
      // A stale version still serves cached questions; misses fail fast.
      if (knownVersion) return knownVersion.value;
      throw error;
    }
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
      if (coolingDown()) failFast();

      let result: RetrieveResponse;
      const started = ++seq;
      try {
        result = await client.retrieve(query, options.k);
      } catch (error) {
        recordFailure(error);
        throw error;
      }
      clearFailureIfOlderThan(started);
      learnVersion(result.version, { monotonic: true });
      // File the result under the version it was actually computed against.
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
          failureCooldownMs: config.failureCooldownMs,
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
