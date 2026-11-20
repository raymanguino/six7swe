import type { DocumentRecord, KnowledgeRepository } from '../db/api/repository.js';
import type { FileStore } from './storage/index.js';

/**
 * The primary resume's file, which the backend serves as `/resume` and the
 * MCP adapter returns from `get_resume_pdf`. Only a PDF is served.
 */

const PDF_MIME = 'application/pdf';

export const isPdf = (document: DocumentRecord): boolean => document.mimeType === PDF_MIME;

/** What `findPrimaryResumePdf` found: the bytes, nothing, or a file over `maxBytes`. */
export type ResumePdfResult =
  | { status: 'ok'; bytes: Uint8Array }
  | { status: 'none' }
  | { status: 'too-large'; sizeBytes: number };

/**
 * The primary resume's file when it is a PDF. With `maxBytes`, the stored size
 * is checked before the file is fetched.
 */
export async function findPrimaryResumePdf(
  deps: { repo: Pick<KnowledgeRepository, 'getPrimaryResume'>; files: FileStore },
  ownerId: string,
  maxBytes?: number,
): Promise<ResumePdfResult> {
  const resume = await deps.repo.getPrimaryResume(ownerId);
  if (!resume || !isPdf(resume)) return { status: 'none' };
  if (maxBytes !== undefined && resume.sizeBytes > maxBytes) {
    return { status: 'too-large', sizeBytes: resume.sizeBytes };
  }
  return { status: 'ok', bytes: await deps.files.get(resume.storagePath) };
}

/** The primary resume's file, when it is a PDF; null otherwise. */
export async function getPrimaryResumePdf(
  deps: { repo: Pick<KnowledgeRepository, 'getPrimaryResume'>; files: FileStore },
  ownerId: string,
): Promise<Uint8Array | null> {
  const found = await findPrimaryResumePdf(deps, ownerId);
  return found.status === 'ok' ? found.bytes : null;
}
