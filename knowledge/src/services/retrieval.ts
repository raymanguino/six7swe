import type { KnowledgeRepository, RetrievedChunk } from '../db/api/repository.js';
import type { Embedder } from './embedding/index.js';

export const MAX_K = 20;

export interface RetrievalResult {
  /** The corpus version the results were read at; a cache key for callers. */
  version: number;
  chunks: RetrievedChunk[];
}

export interface RetrievalDeps {
  repo: KnowledgeRepository;
  embedder: Embedder;
}

/** Embeds the query and returns the `k` closest ready chunks for the owner. */
export async function retrieve(
  deps: RetrievalDeps,
  ownerId: string,
  query: string,
  k: number,
): Promise<RetrievalResult> {
  const limit = Math.min(Math.max(Math.trunc(k), 1), MAX_K);
  // Read the version first: if an ingest lands mid-request, the caller sees
  // the older version and refetches next time instead of caching new data
  // under an old key.
  const version = await deps.repo.getVersion(ownerId);
  const [embedding] = await deps.embedder.embed([query]);
  if (!embedding) throw new Error('Embedder returned no vector for the query');
  const chunks = await deps.repo.search(ownerId, embedding, limit);
  return { version, chunks };
}
