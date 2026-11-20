import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { DocumentKind, RiskFinding } from '../contract.js';
import type { DocumentRecord } from '../db/api/repository.js';
import type { KnowledgeDeps } from './deps.js';
import type { IngestionQueue } from './ingestion/pipeline.js';
import { detectMimeType, extensionOf } from './ingestion/parse.js';
import { hasScanFailure } from './risk/scan.js';

export interface DocumentServiceDeps extends Pick<KnowledgeDeps, 'repo' | 'files'> {
  queue: IngestionQueue;
  log: FastifyBaseLogger;
  /** Called after a delete, which may have changed the corpus (#85). Must not throw. */
  onCorpusChanged?: (ownerId: string) => void;
}

export interface UploadInput {
  ownerId: string;
  filename: string;
  bytes: Uint8Array;
  kind: DocumentKind;
}

export interface UploadResult {
  document: DocumentRecord;
  /** True when identical bytes were already uploaded; no new document was created. */
  deduplicated: boolean;
}

/** The `documents.filename` column is varchar(255), which Postgres counts in characters. */
const MAX_FILENAME_CHARS = 255;
/** Longer "extensions" are just a dot in the name and are not worth preserving. */
const MAX_EXTENSION_CHARS = 16;

/**
 * Keeps a display name sane: no path parts, no control characters, at most
 * 255 characters. Truncation counts code points, so it never splits a
 * surrogate pair, and keeps the extension, which decides the file type.
 */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001F\u007F]/g, '').trim() || 'upload';

  const chars = Array.from(name);
  if (chars.length <= MAX_FILENAME_CHARS) return name;

  const dot = chars.lastIndexOf('.');
  const extension = dot > 0 && chars.length - dot <= MAX_EXTENSION_CHARS ? chars.slice(dot) : [];
  const stem = chars.slice(0, chars.length - extension.length);
  return [...stem.slice(0, MAX_FILENAME_CHARS - extension.length), ...extension].join('');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function uploadDocument(
  deps: DocumentServiceDeps,
  input: UploadInput,
): Promise<UploadResult> {
  const filename = cleanFilename(input.filename);
  const mimeType = detectMimeType(filename, input.bytes);
  const sha256 = sha256Hex(input.bytes);

  const existing = await deps.repo.findBySha256(input.ownerId, sha256);
  if (existing) return resumeExisting(deps, existing, input.bytes);

  // Keyed by content hash, so the key is stable and never collides with
  // another document of the same owner.
  const storagePath = `${input.ownerId}/${sha256}${extensionOf(filename)}`;
  await deps.files.put(storagePath, input.bytes, mimeType);

  const { document, created } = await deps.repo.createDocument({
    ownerId: input.ownerId,
    filename,
    mimeType,
    sizeBytes: input.bytes.byteLength,
    sha256,
    storagePath,
    kind: input.kind,
  });
  // An identical upload raced past the lookup above and won.
  if (!created) return resumeExisting(deps, document, input.bytes);

  deps.queue.enqueue(document);
  return { document, deduplicated: false };
}

/**
 * Handles a re-upload of bytes the owner already has.
 *
 * A ready document, or one the queue is already working on, is left alone.
 * Anything else is retried: a `failed` ingest, and a `pending`/`processing`
 * document nothing is working on (left behind by a crash, by a failure that
 * could not be recorded, or by a boot with RESUME_INGESTION_ON_BOOT=false).
 * The bytes are stored again first, in case the stored copy was what failed.
 *
 * A `needs_review` document is settled too (the same bytes would be flagged
 * again), unless its scan failed (#212): a `scan_failed` finding tells the
 * owner to upload the file again to rescan, so that re-upload retries it.
 *
 * A `failed` or scan-failed document is reset to `pending` here; a stranded
 * pending/processing one is just enqueued, and the worker's markProcessing
 * moves it on. The queue is checked again after the (slow) store, so a
 * concurrent re-upload that queued it meanwhile is not doubled.
 */
async function resumeExisting(
  deps: DocumentServiceDeps,
  existing: DocumentRecord,
  bytes: Uint8Array,
): Promise<UploadResult> {
  const unchanged = { document: existing, deduplicated: true };
  if (existing.status === 'ready' || deps.queue.has(existing.id)) return unchanged;
  if (existing.status === 'needs_review' && !(await scanFailed(deps, existing))) {
    return unchanged;
  }

  await deps.files.put(existing.storagePath, bytes, existing.mimeType);
  if (deps.queue.has(existing.id)) return unchanged;

  let retried = existing;
  if (existing.status === 'failed' || existing.status === 'needs_review') {
    // Re-checked under the row lock: an approval, delete or re-ingest since
    // the read above wins, and the upload is then a plain duplicate.
    const reset = await deps.repo.resetToPending(existing.id, [existing.status]);
    if (!reset) {
      const current = await deps.repo.getDocument(existing.ownerId, existing.id);
      return { document: current ?? existing, deduplicated: true };
    }
    retried = { ...existing, status: 'pending', error: null };
  }
  deps.queue.enqueue(retried);
  return { document: retried, deduplicated: true };
}

/**
 * Whether the document's last scan could not finish, so a rescan may answer
 * differently. Stored findings that cannot be read count as no: the upload is
 * then a plain duplicate, not a 500.
 */
async function scanFailed(deps: DocumentServiceDeps, doc: DocumentRecord): Promise<boolean> {
  try {
    const found = await deps.repo.getRiskFindings(doc.ownerId, doc.id);
    return found !== null && hasScanFailure(found.findings);
  } catch (error) {
    deps.log.warn({ documentId: doc.id, err: error }, 'Could not read the stored risk findings');
    return false;
  }
}

/** The owner's documents, newest first. */
export async function listDocuments(
  deps: Pick<KnowledgeDeps, 'repo'>,
  ownerId: string,
): Promise<DocumentRecord[]> {
  return deps.repo.listDocuments(ownerId);
}

/** One of the owner's documents, or null when it does not exist or belongs to someone else. */
export async function getDocument(
  deps: Pick<KnowledgeDeps, 'repo'>,
  ownerId: string,
  id: string,
): Promise<DocumentRecord | null> {
  return deps.repo.getDocument(ownerId, id);
}

/**
 * The text extracted from one of the owner's documents, for previews. Null
 * when the document does not exist or belongs to someone else.
 */
export async function getDocumentText(
  deps: Pick<KnowledgeDeps, 'repo'>,
  ownerId: string,
  id: string,
): Promise<{ text: string | null } | null> {
  return deps.repo.getExtractedText(ownerId, id);
}

/**
 * Makes one of the owner's ready resumes the primary one. Null when it does
 * not exist; throws a 409 ConflictError when it is not a ready resume.
 */
export async function setPrimaryResume(
  deps: Pick<KnowledgeDeps, 'repo'>,
  ownerId: string,
  id: string,
): Promise<DocumentRecord | null> {
  return deps.repo.setPrimaryResume(ownerId, id);
}

/**
 * The findings of a document's last risk scan (#212). Null when it does not
 * exist or belongs to someone else.
 */
export async function getDocumentFindings(
  deps: Pick<KnowledgeDeps, 'repo'>,
  ownerId: string,
  id: string,
): Promise<{ document: DocumentRecord; findings: RiskFinding[] } | null> {
  return deps.repo.getRiskFindings(ownerId, id);
}

export interface ApproveDeps extends Pick<KnowledgeDeps, 'repo'> {
  log: FastifyBaseLogger;
  /** Called when the approval made the document searchable. Must not throw. */
  onCorpusChanged?: (ownerId: string) => void;
  /** Called when an approved resume became searchable (profile drafting hooks in here). */
  onResumeReady?: (doc: DocumentRecord) => void | Promise<void>;
}

/**
 * The owner approves a document's findings as they are (#212). A flagged
 * document becomes ready and searchable; a ready one flagged by the backfill
 * keeps serving and records the approval. Null when it does not exist;
 * throws a 409 ConflictError when there is nothing to approve.
 */
export async function approveDocument(
  deps: ApproveDeps,
  ownerId: string,
  id: string,
): Promise<DocumentRecord | null> {
  const result = await deps.repo.approveDocument(ownerId, id);
  if (!result) return null;
  const { document, activated } = result;
  // Decided under the repository's lock, so a second approval never re-runs these.
  if (activated) {
    deps.onCorpusChanged?.(ownerId);
    if (document.kind === 'resume' && deps.onResumeReady) {
      try {
        await deps.onResumeReady(document);
      } catch (error) {
        deps.log.warn({ documentId: id, err: error }, 'Post-approval resume hook failed');
      }
    }
  }
  return document;
}

/** Deletes the document, its chunks and its file. Returns false when it did not exist. */
export async function deleteDocument(
  deps: DocumentServiceDeps,
  ownerId: string,
  id: string,
): Promise<boolean> {
  const deleted = await deps.repo.deleteDocument(ownerId, id);
  if (!deleted) return false;
  // Not ingested yet: drop it from the queue so the worker never touches it.
  deps.queue.cancel(id);
  deps.onCorpusChanged?.(ownerId);

  // Keys are content-addressed, so the same bytes uploaded again after the
  // row was deleted get the same key. Keep the file if a row uses it again.
  // (A re-upload landing between this check and the delete loses its file;
  // its ingest then fails with a message to upload again, which re-stores it.)
  const { storagePath } = deleted;
  try {
    if (await deps.repo.isStoragePathInUse(storagePath)) return true;
    // The row is gone, so retrieval no longer sees the document. A file left
    // behind by a storage error is harmless and only costs space.
    await deps.files.delete(storagePath);
  } catch (error) {
    deps.log.warn({ documentId: id, err: error }, 'Could not delete stored file');
  }
  return true;
}
