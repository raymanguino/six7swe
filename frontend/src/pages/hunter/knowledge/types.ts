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

/*
 * Shallow guards for the responses. They check the shape the page relies on,
 * so a broken or unexpected response becomes a clear error instead of a
 * render crash; the full contract is the service's to enforce.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const STATUSES: readonly string[] = ['pending', 'processing', 'ready', 'failed'];
const KINDS: readonly string[] = ['resume', 'supporting'];

const isDocument = (value: unknown): value is KnowledgeDocument =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.filename === 'string' &&
  typeof value.sizeBytes === 'number' &&
  typeof value.chunkCount === 'number' &&
  typeof value.isPrimaryResume === 'boolean' &&
  typeof value.createdAt === 'string' &&
  typeof value.updatedAt === 'string' &&
  typeof value.kind === 'string' &&
  KINDS.includes(value.kind) &&
  typeof value.status === 'string' &&
  STATUSES.includes(value.status) &&
  (value.error === null || typeof value.error === 'string');

const isChunk = (value: unknown): value is RetrievedChunk =>
  isRecord(value) &&
  typeof value.chunkId === 'string' &&
  typeof value.filename === 'string' &&
  typeof value.content === 'string' &&
  typeof value.similarity === 'number' &&
  (value.heading === null || typeof value.heading === 'string');

function invalid(what: string): never {
  throw new Error(`Unexpected ${what} response from the server`);
}

export function parseDocumentList(data: unknown): KnowledgeDocument[] {
  if (!isRecord(data) || !Array.isArray(data.documents) || !data.documents.every(isDocument)) {
    return invalid('document list');
  }
  return data.documents;
}

/** `GET /knowledge/documents/:id` and `PUT .../primary`. */
export function parseDocument(data: unknown): KnowledgeDocument {
  if (!isRecord(data) || !isDocument(data.document)) return invalid('document');
  return data.document;
}

export function parseUpload(data: unknown): UploadResponse {
  if (!isRecord(data) || !isDocument(data.document) || typeof data.deduplicated !== 'boolean') {
    return invalid('upload');
  }
  return { document: data.document, deduplicated: data.deduplicated };
}

export function parseText(data: unknown): DocumentTextResponse {
  if (
    !isRecord(data) ||
    typeof data.documentId !== 'string' ||
    !(data.text === null || typeof data.text === 'string')
  ) {
    return invalid('text');
  }
  return { documentId: data.documentId, text: data.text };
}

export function parseSearch(data: unknown): SearchResponse {
  if (
    !isRecord(data) ||
    typeof data.version !== 'number' ||
    !Array.isArray(data.chunks) ||
    !data.chunks.every(isChunk)
  ) {
    return invalid('search');
  }
  return { version: data.version, chunks: data.chunks };
}
