import type { Env } from '../../config/env.js';
import { createHashingEmbedder } from './hashing.js';
import { createOpenRouterEmbedder } from './openrouter.js';

export interface Embedder {
  /** Identifies the model, e.g. for logs. */
  readonly name: string;
  readonly dimensions: number;
  /** Embeds each text; the result is in the same order as the input. */
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(env: Env, dimensions: number): Embedder {
  if (env.EMBEDDER === 'hashing') return createHashingEmbedder(dimensions);
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
  return createOpenRouterEmbedder({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.EMBEDDING_MODEL,
    dimensions,
  });
}
