import type { KnowledgeRepository } from '../db/api/repository.js';
import type { Embedder } from './embedding/index.js';
import type { FileStore } from './storage/index.js';

/**
 * The long-lived collaborators every part of the service is built from.
 * Each service takes the subset it needs (`Pick<KnowledgeDeps, ...>`) plus
 * anything request-scoped, such as a logger.
 */
export interface KnowledgeDeps {
  repo: KnowledgeRepository;
  files: FileStore;
  embedder: Embedder;
}
