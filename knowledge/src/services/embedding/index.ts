import type { Env } from '../../config/env.js';
import { createHashingEmbedder } from './hashing.js';
import { createOpenRouterEmbedder } from './openrouter.js';

export interface Embedder {
  /** Identifies the model, e.g. for logs. */
  readonly name: string;
  /** Length of every vector; the ingestion pipeline rejects any that differ. */
  readonly dimensions: number;
  /** Embeds each text; the result is in the same order as the input. */
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(env: Env, dimensions: number): Embedder {
  if (env.EMBEDDER === 'hashing') return createHashingEmbedder(dimensions);
  // loadEnv already requires the key for EMBEDDER=openrouter; this narrows the type.
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
  return createOpenRouterEmbedder({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.EMBEDDING_MODEL,
    dimensions,
  });
}
