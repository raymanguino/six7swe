import type { FastifyBaseLogger } from 'fastify';
import type { DocumentRecord, KnowledgeRepository } from '../../db/api/repository.js';
import { SerialQueue } from '../ingestion/queue.js';
import { scanDocument, type ScanOptions } from './scan.js';
import type { RiskScanner } from './scanner.js';

/**
 * The one-time risk scan of documents that were ready before the scan existed
 * (#212). Each is scanned once (`scanned_at` marks it done) and keeps serving
 * whatever is found: the live chat does not lose content, and the owner
 * reviews the findings on the Knowledge page (approve, or replace the file).
 *
 * It runs on its own serial queue, apart from ingestion, so it never holds up
 * an upload. It is durable through the database: a document cut off by a
 * restart is still unscanned and is queued again on the next boot.
 */
export interface RiskBackfillDeps {
  repo: Pick<KnowledgeRepository, 'listUnscannedReady' | 'getExtractedText' | 'recordBackfillScan'>;
  scanner: RiskScanner | null;
  log: FastifyBaseLogger;
  /** Overrides the scan deadline, for tests. */
  deadlineMs?: ScanOptions['deadlineMs'];
}

export interface RiskBackfill {
  /** Queues every unscanned ready document; returns how many were queued. */
  start(): Promise<number>;
  idle(): Promise<void>;
  stop(): Promise<number>;
}

export async function backfillDocument(deps: RiskBackfillDeps, doc: DocumentRecord): Promise<void> {
  const found = await deps.repo.getExtractedText(doc.ownerId, doc.id);
  // Deleted meanwhile, or ready without text (cannot happen through ingestion).
  if (!found || found.text === null) return;
  const findings = await scanDocument(found.text, {
    scanner: deps.scanner,
    log: deps.log,
    documentId: doc.id,
    deadlineMs: deps.deadlineMs,
  });
  const written = await deps.repo.recordBackfillScan(doc.id, findings);
  // Only the count is logged: findings quote the document.
  if (written) {
    deps.log.info({ documentId: doc.id, findings: findings.length }, 'Backfill risk scan done');
  }
}

export function createRiskBackfill(deps: RiskBackfillDeps): RiskBackfill {
  const queue = new SerialQueue<DocumentRecord>(
    (doc) => backfillDocument(deps, doc),
    (doc, error) =>
      deps.log.warn({ documentId: doc.id, err: error }, 'Backfill risk scan could not be stored'),
  );
  return {
    async start() {
      const unscanned = await deps.repo.listUnscannedReady();
      let queued = 0;
      for (const doc of unscanned) if (queue.enqueue(doc)) queued++;
      return queued;
    },
    idle: () => queue.idle(),
    stop: () => queue.stop(),
  };
}
