import type { DocumentRecord, KnowledgeRepository } from '../db/api/repository.js';
import type { Embedder } from '../services/embedding/index.js';
import type { SerialQueue } from '../services/ingestion/queue.js';
import type { FileStore } from '../services/storage/index.js';

/** What the route handlers need. Built once in `buildApp` and passed down. */
export interface KnowledgeContext {
  repo: KnowledgeRepository;
  files: FileStore;
  embedder: Embedder;
  queue: SerialQueue<DocumentRecord>;
  /**
   * The single owner of the knowledge base. Every request acts on this
   * owner's documents until the owner JWT gate lands.
   */
  ownerId: string;
  maxUploadBytes: number;
}
