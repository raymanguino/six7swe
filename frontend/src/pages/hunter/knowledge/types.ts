/**
 * The knowledge service's wire types, as the backend's `/knowledge/*` proxy
 * relays them. They mirror `knowledge/src/contract.ts`; once that contract
 * moves to a shared package (#84), import from there instead.
 */

export type DocumentKind = 'resume' | 'supporting';

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: DocumentKind;
  isPrimaryResume: boolean;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UploadResponse {
  document: KnowledgeDocument;
  deduplicated: boolean;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  heading: string | null;
  content: string;
  similarity: number;
}

export interface SearchResponse {
  version: number;
  chunks: RetrievedChunk[];
}

export interface DocumentTextResponse {
  documentId: string;
  text: string | null;
}

/** The file types the service ingests. */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.md', '.txt'] as const;

export const isAcceptedFile = (file: File): boolean =>
  ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

/** Matches the service's retrieve limits. */
export const MAX_SEARCH_K = 20;
export const DEFAULT_SEARCH_K = 6;
