import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { DocumentRecord, KnowledgeRepository } from '../db/api/repository.js';
import type { DocumentKind } from '../db/schema.js';
import type { SerialQueue } from './ingestion/queue.js';
import { detectMimeType, extensionOf } from './ingestion/parse.js';
import type { FileStore } from './storage/index.js';

export interface DocumentServiceDeps {
  repo: KnowledgeRepository;
  files: FileStore;
  queue: SerialQueue<DocumentRecord>;
  log: FastifyBaseLogger;
}

export interface UploadInput {
  ownerId: string;
  filename: string;
  bytes: Uint8Array;
  kind: DocumentKind;
}

export interface UploadResult {
  document: DocumentRecord;
  /** True when identical bytes were already uploaded; nothing new was stored. */
  deduplicated: boolean;
}

/** Keeps a display name sane: no path parts, no control characters, bounded length. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return (cleaned || 'upload').slice(0, 255);
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
  if (existing) {
    // A failed ingest is retried by uploading the same file again.
    if (existing.status === 'failed') {
      await deps.repo.resetToPending(existing.id);
      const retried = { ...existing, status: 'pending' as const, error: null };
      deps.queue.enqueue(retried);
      return { document: retried, deduplicated: true };
    }
    return { document: existing, deduplicated: true };
  }

  // Keyed by content hash, so the key is stable and never collides with
  // another document of the same owner.
  const storagePath = `${input.ownerId}/${sha256}${extensionOf(filename)}`;
  await deps.files.put(storagePath, input.bytes, mimeType);

  let document: DocumentRecord;
  try {
    document = await deps.repo.createDocument({
      ownerId: input.ownerId,
      filename,
      mimeType,
      sizeBytes: input.bytes.byteLength,
      sha256,
      storagePath,
      kind: input.kind,
    });
  } catch (error) {
    // Two identical uploads raced past the check above; the other one won.
    if (!isUniqueViolation(error)) throw error;
    const winner = await deps.repo.findBySha256(input.ownerId, sha256);
    if (!winner) throw error;
    return { document: winner, deduplicated: true };
  }
  deps.queue.enqueue(document);
  return { document, deduplicated: false };
}

/** Postgres error 23505, whether thrown by postgres.js directly or wrapped by Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

/** Deletes the document, its chunks and its file. Returns false when it did not exist. */
export async function deleteDocument(
  deps: DocumentServiceDeps,
  ownerId: string,
  id: string,
): Promise<{ deleted: boolean; version: number | null }> {
  const result = await deps.repo.deleteDocument(ownerId, id);
  if (!result) return { deleted: false, version: null };

  // The row is gone, so retrieval no longer sees the document. A file left
  // behind by a storage error is harmless and only costs space.
  try {
    await deps.files.delete(result.deleted.storagePath);
  } catch (error) {
    deps.log.warn({ documentId: id, err: error }, 'Could not delete stored file');
  }
  return { deleted: true, version: result.version };
}
