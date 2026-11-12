import { z } from 'zod';
import type { Embedder } from './index.js';

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

/** Inputs per request. Well under the provider's limit, and keeps a retry cheap. */
const BATCH_SIZE = 64;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;

const ResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  fetchImpl?: typeof fetch;
  /** Delay before retry `attempt` (1-based). Overridable so tests do not sleep. */
  backoffMs?: (attempt: number) => number;
}

export function createOpenRouterEmbedder(options: OpenRouterEmbedderOptions): Embedder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backoffMs = options.backoffMs ?? ((attempt) => 500 * 2 ** (attempt - 1));

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
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmbeddingError(`Embedding request failed (${res.status}): ${detail}`, retryable);
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
        const retryable =
          error instanceof EmbeddingError
            ? error.retryable
            : error instanceof Error && error.name === 'TimeoutError';
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
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
