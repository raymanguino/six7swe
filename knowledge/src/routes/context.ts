import type { KnowledgeDeps } from '../services/deps.js';
import type { IngestionQueue } from '../services/ingestion/pipeline.js';

/**
 * What the route handlers need. Built once in `buildApp` and passed down.
 * The owner is per request (`requireOwner(req)`), not part of the context.
 */
export interface KnowledgeContext extends KnowledgeDeps {
  queue: IngestionQueue;
}
