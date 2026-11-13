import { z } from 'zod';
import { EmbeddingError } from './errors.js';
import type { Embedder } from './index.js';

export { EmbeddingError } from './errors.js';

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

/** Inputs per request. Well under the provider's limit, and keeps a retry cheap. */
const BATCH_SIZE = 64;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
/** A Retry-After longer than this is capped; the queue should not stall for minutes. */
const MAX_RETRY_AFTER_MS = 30_000;

const ResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  fetchImpl?: typeof fetch;
  /** Delay before retry `attempt` (1-based). Overridable so tests do not sleep. */
  backoffMs?: (attempt: number) => number;
}

/** Exponential backoff with jitter, so concurrent retries do not arrive together. */
export function defaultBackoffMs(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** Parses a Retry-After header: delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Whether another attempt could succeed: rate limits, server errors,
 * timeouts and network failures (fetch rejects with a TypeError when the
 * connection fails), but never a malformed request or response.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingError) return error.retryable;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  return error instanceof TypeError;
}

export function createOpenRouterEmbedder(options: OpenRouterEmbedderOptions): Embedder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;

  async function embedBatch(inputs: string[]): Promise<number[][]> {
    const res = await fetchImpl(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: options.model, input: inputs }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // The provider's body goes into the message for the logs only; the
      // document's stored error is derived from the status alone.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new EmbeddingError(
        `Embedding request failed (${res.status}): ${detail}`,
        res.status === 429 || res.status >= 500,
        { status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) },
      );
    }

    const parsed = ResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new EmbeddingError('Embedding response had an unexpected shape', false);
    }

    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
    if (ordered.length !== inputs.length) {
      throw new EmbeddingError(
        `Expected ${inputs.length} embeddings, received ${ordered.length}`,
        false,
      );
    }
    // Sorted and the right count is not enough: [0, 0, 2] would pair the
    // second input with the first input's vector.
    if (!ordered.every((item, i) => item.index === i)) {
      throw new EmbeddingError(
        `Embedding indexes are not 0..${inputs.length - 1}: ${ordered.map((item) => item.index).join(',')}`,
        false,
      );
    }
    for (const item of ordered) {
      if (item.embedding.length !== options.dimensions) {
        throw new EmbeddingError(
          `Model ${options.model} returned ${item.embedding.length} dimensions, expected ${options.dimensions}`,
          false,
        );
      }
    }
    return ordered.map((item) => item.embedding);
  }

  async function withRetry(inputs: string[]): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await embedBatch(inputs);
      } catch (error) {
        if (!isRetryable(error) || attempt >= MAX_ATTEMPTS) throw error;
        // Wait at least as long as the provider asked (capped), and never
        // less than our own backoff.
        const requested = error instanceof EmbeddingError ? (error.details.retryAfterMs ?? 0) : 0;
        const delay = Math.max(backoffMs(attempt), Math.min(requested, MAX_RETRY_AFTER_MS));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    name: `openrouter:${options.model}`,
    dimensions: options.dimensions,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        out.push(...(await withRetry(texts.slice(i, i + BATCH_SIZE))));
      }
      return out;
    },
  };
}
