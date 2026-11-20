import type { FastifyBaseLogger } from 'fastify';
import type { DocumentRecord, NewChunk } from '../../db/api/repository.js';
import type { KnowledgeDeps } from '../deps.js';
import { EmbeddingError } from '../embedding/errors.js';
import {
  chunkDocument,
  embeddingInput,
  type ChunkOptions,
  DEFAULT_CHUNK_OPTIONS,
} from './chunk.js';
import { extractText, isSupportedMime } from './parse.js';
import { SerialQueue } from './queue.js';
import { hasScanFailure, scanDocument, scanFailedFinding } from '../risk/scan.js';
import type { RiskScanner } from '../risk/scanner.js';

export interface PipelineDeps extends KnowledgeDeps {
  log: FastifyBaseLogger;
  chunkOptions?: ChunkOptions;
  /**
   * The risk scan's model pass (#212). Null or unset: the deterministic
   * checks only. Either way every ingest is scanned before it can be ready.
   */
  riskScanner?: RiskScanner | null;
  /** Overrides the risk scan's deadline, for tests. */
  riskScanDeadlineMs?: number;
  /**
   * Called after every ingest attempt, finished or failed: either may have
   * changed the corpus (the eval runner hooks in here, #85, and skips a run
   * when the version did not move). It must not throw.
   */
  onCorpusChanged?: (ownerId: string) => void;
}

export type IngestionQueue = SerialQueue<DocumentRecord>;

/**
 * A failure whose message is safe to show the owner: it describes the file,
 * not the service's internals. Anything else is stored as a generic message
 * and only logged in full.
 */
export class IngestionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestionError';
  }
}

const GENERIC_FAILURE = 'Ingestion failed unexpectedly. Upload the file again to retry.';

/** What goes in `documents.error`, which the owner sees. Details stay in the logs. */
export function publicIngestionError(error: unknown): string {
  if (error instanceof IngestionError) return error.message;
  if (error instanceof EmbeddingError) {
    return error.status === undefined
      ? 'Embedding provider error'
      : `Embedding provider error (status ${error.status})`;
  }
  return GENERIC_FAILURE;
}

/**
 * Turns one stored file into ready chunks:
 * fetch, extract text, risk-scan it (#212), chunk, embed, then commit
 * atomically. A clean document becomes `ready` and bumps the corpus version;
 * one with any finding becomes `needs_review` and is not served until the
 * owner approves it.
 *
 * Any failure marks the document `failed` with a short reason. Its chunks
 * from a previous successful run stay in the table but are no longer served:
 * retrieval only reads `ready` documents, so they left the corpus (and the
 * version was bumped) when the re-ingest marked the document `processing`.
 * Uploading the same file again retries it.
 *
 * Never throws: a failure that cannot even be recorded is logged, and the
 * document stays `pending` or `processing` until a re-upload or the next boot
 * picks it up again.
 */
export async function ingestDocument(deps: PipelineDeps, doc: DocumentRecord): Promise<void> {
  const { repo, files, embedder, log } = deps;
  const started = Date.now();

  try {
    await repo.markProcessing(doc.id);

    if (!isSupportedMime(doc.mimeType)) {
      throw new IngestionError(`Unsupported stored file type: ${doc.mimeType}`);
    }
    const mime = doc.mimeType;

    let bytes: Uint8Array;
    try {
      bytes = await files.get(doc.storagePath);
    } catch (error) {
      throw new IngestionError('Could not load the stored file. Upload it again to retry.', {
        cause: error,
      });
    }

    let text: string;
    try {
      text = await extractText(bytes, mime);
    } catch (error) {
      throw new IngestionError(
        mime === 'application/pdf' ? 'Could not parse the PDF.' : 'Could not read the file.',
        { cause: error },
      );
    }
    if (!text) {
      throw new IngestionError(
        mime === 'application/pdf'
          ? 'No extractable text. The PDF may be scanned images; upload a text-based PDF or a .txt/.md export.'
          : 'The file is empty.',
      );
    }

    // Never throws: a scan that cannot finish is itself a finding.
    const scan = await scanDocument(text, {
      scanner: deps.riskScanner ?? null,
      log,
      documentId: doc.id,
      deadlineMs: deps.riskScanDeadlineMs,
    });
    // An incomplete scan must hold the document. scanDocument adds a
    // scan_failed finding when it is incomplete; this does not rely on that.
    const findings =
      !scan.complete && !hasScanFailure(scan.findings)
        ? [scanFailedFinding('The risk scan did not finish.'), ...scan.findings]
        : scan.findings;

    const pieces = chunkDocument(text, mime, deps.chunkOptions ?? DEFAULT_CHUNK_OPTIONS);
    const vectors = await embedder.embed(pieces.map(embeddingInput));
    if (vectors.length !== pieces.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${pieces.length} chunks`);
    }

    const newChunks = pieces.map((piece, ordinal): NewChunk => {
      const embedding = vectors[ordinal];
      if (!embedding || embedding.length !== embedder.dimensions) {
        throw new Error(
          `Embedder returned ${embedding?.length ?? 0} dimensions for chunk ${ordinal}, expected ${embedder.dimensions}`,
        );
      }
      return {
        ordinal,
        heading: piece.heading,
        content: piece.content,
        tokenCount: piece.tokenCount,
        embedding,
      };
    });

    const version = await repo.completeIngestion(doc.id, text, newChunks, findings);
    // Whether the risk scan held it for review.
    const flagged = findings.length > 0;

    // Only the count is logged: findings quote the document.
    log.info(
      {
        documentId: doc.id,
        chunks: pieces.length,
        findings: findings.length,
        version,
        ms: Date.now() - started,
      },
      flagged ? 'Document ingested; held for review' : 'Document ingested',
    );
  } catch (error) {
    await recordFailure(deps, doc, error);
    deps.onCorpusChanged?.(doc.ownerId);
    return;
  }
  deps.onCorpusChanged?.(doc.ownerId);
}

async function recordFailure(
  { repo, log }: PipelineDeps,
  doc: DocumentRecord,
  error: unknown,
): Promise<void> {
  log.warn({ documentId: doc.id, err: error }, 'Document ingestion failed');
  try {
    await repo.failIngestion(doc.id, publicIngestionError(error));
  } catch (recordError) {
    log.error(
      { documentId: doc.id, err: recordError },
      'Could not record the ingestion failure; the document stays unfinished',
    );
  }
}

/** The ingestion queue: one document at a time through `ingestDocument`. */
export function createIngestionQueue(
  deps: Omit<PipelineDeps, 'log'>,
  log: FastifyBaseLogger,
): IngestionQueue {
  return new SerialQueue<DocumentRecord>(
    (doc) => ingestDocument({ ...deps, log }, doc),
    // ingestDocument handles its own failures; this only fires on a bug.
    (doc, error) => log.error({ documentId: doc.id, err: error }, 'Ingestion worker crashed'),
  );
}
