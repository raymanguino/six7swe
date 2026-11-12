import { z } from 'zod';
import type { DocumentRecord, RetrievedChunk } from './db/api/repository.js';
import { MAX_K } from './services/retrieval.js';

/**
 * The service's wire contract. When the backends start calling this service,
 * these move to `packages/knowledge-types` so both sides share one definition.
 */

export const RetrieveRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  k: z.number().int().min(1).max(MAX_K).default(6),
});
export type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;

export const UploadQuerySchema = z.object({
  kind: z.enum(['resume', 'supporting']).default('supporting'),
});

export const DocumentParamsSchema = z.object({ id: z.uuid() });

export interface DocumentDto {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: DocumentRecord['kind'];
  isPrimaryResume: boolean;
  status: DocumentRecord['status'];
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievedChunkDto {
  chunkId: string;
  documentId: string;
  filename: string;
  heading: string | null;
  content: string;
  similarity: number;
}

export interface RetrieveResponse {
  version: number;
  chunks: RetrievedChunkDto[];
}

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
