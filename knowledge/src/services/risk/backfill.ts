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

/**
 * Scans one document and records the result, unless the model pass could not
 * finish (provider down, timeout): then nothing is recorded, the document
 * stays unscanned and the next boot tries again, rather than a transient
 * outage using up its one scan.
 */
export async function backfillDocument(
  deps: RiskBackfillDeps & { scanner: RiskScanner },
  doc: DocumentRecord,
): Promise<void> {
  const found = await deps.repo.getExtractedText(doc.ownerId, doc.id);
  if (!found) {
    deps.log.info({ documentId: doc.id }, 'Backfill risk scan skipped: document deleted meanwhile');
    return;
  }
  if (found.text === null) {
    // Ingestion always stores the text with `ready`, so this is a damaged row.
    deps.log.warn({ documentId: doc.id }, 'Backfill risk scan skipped: ready document has no text');
    return;
  }
  const { findings, complete } = await scanDocument(found.text, {
    scanner: deps.scanner,
    log: deps.log,
    documentId: doc.id,
    deadlineMs: deps.deadlineMs,
  });
  if (!complete) {
    deps.log.warn(
      { documentId: doc.id },
      'Backfill risk scan did not finish; it is retried on the next boot',
    );
    return;
  }
  const written = await deps.repo.recordBackfillScan(doc.id, findings);
  // Only the count is logged: findings quote the document.
  if (written) {
    deps.log.info({ documentId: doc.id, findings: findings.length }, 'Backfill risk scan done');
  }
}

export function createRiskBackfill(deps: RiskBackfillDeps): RiskBackfill {
  const { scanner } = deps;
  const queue = new SerialQueue<DocumentRecord>(
    (doc) => (scanner ? backfillDocument({ ...deps, scanner }, doc) : Promise.resolve()),
    (doc, error) =>
      deps.log.warn({ documentId: doc.id, err: error }, 'Backfill risk scan could not be stored'),
  );
  return {
    async start() {
      // Without the model pass the backfill would mark documents scanned that
      // only had the pattern checks; it waits for a configured model instead.
      if (!scanner) {
        deps.log.info('Risk scan backfill skipped: no RISK_SCANNER model configured');
        return 0;
      }
      const unscanned = await deps.repo.listUnscannedReady();
      let queued = 0;
      for (const doc of unscanned) if (queue.enqueue(doc)) queued++;
      return queued;
    },
    idle: () => queue.idle(),
    stop: () => queue.stop(),
  };
}
