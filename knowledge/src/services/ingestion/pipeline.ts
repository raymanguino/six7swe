import type { FastifyBaseLogger } from 'fastify';
import type { DocumentRecord, KnowledgeRepository } from '../../db/api/repository.js';
import type { Embedder } from '../embedding/index.js';
import type { FileStore } from '../storage/index.js';
import {
  chunkDocument,
  embeddingInput,
  type ChunkOptions,
  DEFAULT_CHUNK_OPTIONS,
} from './chunk.js';
import { extractText, SUPPORTED_MIME_TYPES, type SupportedMimeType } from './parse.js';

export interface PipelineDeps {
  repo: KnowledgeRepository;
  files: FileStore;
  embedder: Embedder;
  log: FastifyBaseLogger;
  chunkOptions?: ChunkOptions;
}

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionError';
  }
}

function asSupportedMime(mime: string): SupportedMimeType {
  const match = SUPPORTED_MIME_TYPES.find((m) => m === mime);
  if (!match) throw new IngestionError(`Unsupported stored mime type: ${mime}`);
  return match;
}

/**
 * Turns one stored file into ready chunks:
 * fetch, extract text, chunk, embed, then commit atomically and bump the corpus version.
 *
 * Any failure marks the document `failed` with the reason; the chunks from a
 * previous successful run are left as they were, so a failed re-ingest never
 * empties the knowledge base.
 */
export async function ingestDocument(deps: PipelineDeps, doc: DocumentRecord): Promise<void> {
  const { repo, files, embedder, log } = deps;
  const started = Date.now();
  await repo.markProcessing(doc.id);

  try {
    const mime = asSupportedMime(doc.mimeType);
    const bytes = await files.get(doc.storagePath);
    const text = await extractText(bytes, mime);
    if (!text) {
      throw new IngestionError(
        mime === 'application/pdf'
          ? 'No extractable text. The PDF may be scanned images; upload a text-based PDF or a .txt/.md export.'
          : 'The file is empty.',
      );
    }

    const pieces = chunkDocument(text, mime, deps.chunkOptions ?? DEFAULT_CHUNK_OPTIONS);
    const vectors = await embedder.embed(pieces.map(embeddingInput));
    if (vectors.length !== pieces.length) {
      throw new IngestionError(
        `Embedder returned ${vectors.length} vectors for ${pieces.length} chunks`,
      );
    }

    const version = await repo.completeIngestion(
      doc.id,
      text,
      pieces.map((piece, ordinal) => ({
        ordinal,
        heading: piece.heading,
        content: piece.content,
        tokenCount: piece.tokenCount,
        embedding: vectors[ordinal] as number[],
      })),
    );

    log.info(
      { documentId: doc.id, chunks: pieces.length, version, ms: Date.now() - started },
      'Document ingested',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repo.failIngestion(doc.id, message.slice(0, 1000));
    log.warn({ documentId: doc.id, err: error }, 'Document ingestion failed');
  }
}
