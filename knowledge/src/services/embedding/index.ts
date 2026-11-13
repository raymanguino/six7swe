import { EMBEDDING_PROVIDERS, type EmbedderConfig } from '../../config/env.js';
import { createHashingEmbedder } from './hashing.js';
import { createOpenAICompatibleEmbedder } from './openaiCompatible.js';

export interface Embedder {
  /** Identifies the model, e.g. for logs. */
  readonly name: string;
  /** Length of every vector; the ingestion pipeline rejects any that differ. */
  readonly dimensions: number;
  /** Embeds each text; the result is in the same order as the input. */
  embed(texts: string[]): Promise<number[][]>;
}

export function createEmbedder(config: EmbedderConfig, dimensions: number): Embedder {
  switch (config.kind) {
    case 'hashing':
      return createHashingEmbedder(dimensions);
    case 'openai-compatible':
      return createOpenAICompatibleEmbedder({
        provider: config.provider,
        label: EMBEDDING_PROVIDERS[config.provider].label,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        dimensions,
      });
  }
}
