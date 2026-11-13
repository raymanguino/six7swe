import type { DocumentKind, DocumentStatus } from '../../contract.js';

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

export interface CreateDocumentResult {
  document: DocumentRecord;
  /** False when the owner already had a document with these bytes; `document` is that one. */
  created: boolean;
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

/** A write lost to a uniqueness rule other than the one the caller handles. Maps to 409. */
export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConflictError';
  }
}

/**
 * Every repository keeps one rule about the corpus version: it is bumped in
 * the same transaction as any change to the set of chunks retrieval can see.
 * Retrieval only serves chunks of `ready` documents, so a ready document with
 * chunks moving to any other status bumps it, as does finishing an ingest or
 * deleting a ready document.
 *
 * And one rule about the primary resume: it is the owner's newest (by
 * upload time) `ready` resume. It is recomputed when a resume finishes
 * ingesting and when the primary is deleted, so a resume whose ingest fails
 * never displaces a good one, and a re-upload of existing bytes never changes
 * it. A primary whose re-ingest fails stays primary until another resume
 * completes or it is deleted.
 */
export interface KnowledgeRepository {
  findBySha256(ownerId: string, sha256: string): Promise<DocumentRecord | null>;

  /**
   * Inserts a pending document, or returns the existing one when the owner
   * already has these bytes. Creation and deletion are serialized per owner.
   * A new document is never primary; see the primary-resume rule above.
   */
  createDocument(doc: NewDocument): Promise<CreateDocumentResult>;

  getDocument(ownerId: string, id: string): Promise<DocumentRecord | null>;

  listDocuments(ownerId: string): Promise<DocumentRecord[]>;

  /** Puts a failed or stranded document back to `pending` for another attempt. */
  resetToPending(id: string): Promise<void>;

  markProcessing(id: string): Promise<void>;

  /**
   * Replaces the document's chunks, marks it ready and bumps the owner's
   * corpus version, atomically. For a resume, also re-applies the
   * primary-resume rule. Returns the new version.
   */
  completeIngestion(id: string, extractedText: string, chunks: NewChunk[]): Promise<number>;

  /** Marks the document failed. Its previous chunks are kept but no longer served. */
  failIngestion(id: string, error: string): Promise<void>;

  /**
   * Deletes the document and its chunks, and returns the deleted row (null
   * when nothing matched). Bumps the corpus version when the document had
   * been contributing chunks; deleting the primary resume promotes the next
   * newest ready resume.
   */
  deleteDocument(ownerId: string, id: string): Promise<DocumentRecord | null>;

  /** True when any document row still points at this file-store key. */
  isStoragePathInUse(storagePath: string): Promise<boolean>;

  /** Documents a previous process left pending or processing. */
  listUnfinished(): Promise<DocumentRecord[]>;

  /** The `k` ready chunks closest to the embedding, closest first. */
  search(ownerId: string, embedding: number[], k: number): Promise<RetrievedChunk[]>;

  getVersion(ownerId: string): Promise<number>;
}
