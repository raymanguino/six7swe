import type { DocumentDto, RetrievedChunkDto } from '../contract.js';
import type { DocumentRecord, RetrievedChunk } from '../db/api/repository.js';

/** Storage keys and owner ids are internal and never leave the service. */
export function toDocumentDto(doc: DocumentRecord): DocumentDto {
  return {
    id: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    kind: doc.kind,
    isPrimaryResume: doc.isPrimaryResume,
    status: doc.status,
    error: doc.error,
    chunkCount: doc.chunkCount,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toChunkDto(chunk: RetrievedChunk): RetrievedChunkDto {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    filename: chunk.filename,
    heading: chunk.heading,
    content: chunk.content,
    similarity: Math.round(chunk.similarity * 10_000) / 10_000,
  };
}
