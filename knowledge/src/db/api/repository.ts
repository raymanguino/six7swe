import type { DocumentKind, DocumentStatus } from '../schema.js';

/**
 * Persistence boundary for the knowledge service.
 *
 * The services depend on this interface rather than on Drizzle, so the
 * ingestion and retrieval logic can be tested against an in-memory
 * implementation without a database.
 */

/** A document as returned to callers. The extracted text is fetched separately. */
export interface DocumentRecord {
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  kind: DocumentKind;
  isPrimaryResume: boolean;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewDocument {
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  kind: DocumentKind;
}

export interface NewChunk {
  ordinal: number;
  heading: string | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  heading: string | null;
  content: string;
  ordinal: number;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  similarity: number;
}

export interface KnowledgeRepository {
  findBySha256(ownerId: string, sha256: string): Promise<DocumentRecord | null>;

  /**
   * Inserts a pending document. A `resume` becomes the owner's primary resume,
   * replacing the previous one.
   */
  createDocument(doc: NewDocument): Promise<DocumentRecord>;

  getDocument(ownerId: string, id: string): Promise<DocumentRecord | null>;

  listDocuments(ownerId: string): Promise<DocumentRecord[]>;

  /** Puts a failed document back in the queue. */
  resetToPending(id: string): Promise<void>;

  markProcessing(id: string): Promise<void>;

  /**
   * Replaces the document's chunks, marks it ready and bumps the owner's
   * corpus version, atomically. Returns the new version.
   */
  completeIngestion(id: string, extractedText: string, chunks: NewChunk[]): Promise<number>;

  failIngestion(id: string, error: string): Promise<void>;

  /**
   * Deletes the document and its chunks. Bumps the corpus version when the
   * document had been contributing chunks. Returns null when nothing matched.
   */
  deleteDocument(
    ownerId: string,
    id: string,
  ): Promise<{ deleted: DocumentRecord; version: number } | null>;

  /** Documents a previous process left pending or processing. */
  listUnfinished(): Promise<DocumentRecord[]>;

  /** The `k` ready chunks closest to the embedding, closest first. */
  search(ownerId: string, embedding: number[], k: number): Promise<RetrievedChunk[]>;

  getVersion(ownerId: string): Promise<number>;
}
