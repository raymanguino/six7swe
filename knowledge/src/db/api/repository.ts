import type { DocumentKind, DocumentStatus, RiskFinding } from '../../contract.js';

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
  /** How many findings the last risk scan stored (#212); 0 when none or not scanned. */
  findingCount: number;
  /** When the current extracted text was risk-scanned; null until then. */
  scannedAt: Date | null;
  /** When the owner approved the current findings as they are; null otherwise. */
  approvedAt: Date | null;
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
 * completes or it is deleted. The owner can pick another ready resume
 * (`setPrimaryResume`); that choice holds until the rule is next applied.
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

  /**
   * The text extracted from one of the owner's documents. Null when the
   * document does not exist or belongs to someone else; `text` is null until
   * an ingest has extracted it.
   */
  getExtractedText(ownerId: string, id: string): Promise<{ text: string | null } | null>;

  /**
   * The owner's primary resume, whatever its status (a primary whose
   * re-ingest failed stays primary), or null when there is none.
   */
  getPrimaryResume(ownerId: string): Promise<DocumentRecord | null>;

  /**
   * Makes one of the owner's ready resumes primary and demotes the previous
   * one, atomically. Returns the updated document, or null when it does not
   * exist or belongs to someone else. Throws a ConflictError when the
   * document is not a ready resume. The choice holds until another resume
   * finishes ingesting or the primary is deleted; both re-apply the
   * newest-ready-resume rule.
   */
  setPrimaryResume(ownerId: string, id: string): Promise<DocumentRecord | null>;

  /** Puts a failed or stranded document back to `pending` for another attempt. */
  resetToPending(id: string): Promise<void>;

  markProcessing(id: string): Promise<void>;

  /**
   * Replaces the document's chunks and stores the risk scan's findings
   * (#212), atomically. With no findings the document becomes `ready` and the
   * owner's corpus version is bumped; with any, it becomes `needs_review`,
   * which retrieval does not serve, and the version is left alone. Either
   * way the approval of an earlier scan is cleared. For a resume, also
   * re-applies the primary-resume rule (so a flagged resume is never
   * primary). Returns the corpus version after the change.
   */
  completeIngestion(
    id: string,
    extractedText: string,
    chunks: NewChunk[],
    findings: RiskFinding[],
  ): Promise<number>;

  /**
   * The findings of the document's last risk scan, with the document. Null
   * when it does not exist or belongs to someone else; `findings` is empty
   * when the text has not been scanned or nothing was found.
   */
  getRiskFindings(
    ownerId: string,
    id: string,
  ): Promise<{ document: DocumentRecord; findings: RiskFinding[] } | null>;

  /**
   * The owner approves a document's findings as they are, recorded in
   * `approvedAt`. A `needs_review` document becomes `ready` (bumping the
   * corpus version, and re-applying the primary-resume rule for a resume); a
   * `ready` document with unapproved findings (flagged by the backfill) only
   * records the approval. Returns the updated document, or null when it does
   * not exist or belongs to someone else. Throws a ConflictError for
   * anything else (nothing to approve, or not ingested).
   */
  approveDocument(ownerId: string, id: string): Promise<DocumentRecord | null>;

  /** Ready documents, of every owner, whose text has never been risk-scanned (the backfill). */
  listUnscannedReady(): Promise<DocumentRecord[]>;

  /**
   * Stores a backfill scan's findings on a ready document, leaving its status
   * alone: it keeps serving until the owner reviews them. Writes only while
   * the document is still ready and unscanned, so a re-ingest that finished
   * meanwhile is not overwritten. Returns false when nothing was written.
   */
  recordBackfillScan(id: string, findings: RiskFinding[]): Promise<boolean>;

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
