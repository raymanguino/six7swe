import { randomUUID } from 'node:crypto';
import { RiskFindingSchema, type RiskFinding } from '../../contract.js';
import {
  ConflictError,
  type DocumentRecord,
  type KnowledgeRepository,
  type NewChunk,
  type RetrievedChunk,
} from '../../db/api/repository.js';

interface StoredChunk extends NewChunk {
  id: string;
  documentId: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * An in-memory KnowledgeRepository with the same observable behaviour as the
 * Drizzle one, for testing the services without a database.
 */
export function createMemoryRepository(): KnowledgeRepository & {
  documents: Map<string, DocumentRecord>;
  chunks: StoredChunk[];
  extractedText: Map<string, string>;
  findings: Map<string, RiskFinding[]>;
} {
  const documents = new Map<string, DocumentRecord>();
  const extractedText = new Map<string, string>();
  const findings = new Map<string, RiskFinding[]>();
  let chunks: StoredChunk[] = [];
  const versions = new Map<string, number>();

  const bump = (ownerId: string) => {
    const next = (versions.get(ownerId) ?? 0) + 1;
    versions.set(ownerId, next);
    return next;
  };
  const update = (id: string, patch: Partial<DocumentRecord>) => {
    const doc = documents.get(id);
    if (doc) documents.set(id, { ...doc, ...patch, updatedAt: new Date() });
  };
  /** Same rule as the Drizzle repository: a ready document with chunks leaving ready bumps. */
  const leaveReady = (id: string, patch: Pick<DocumentRecord, 'status' | 'error'>) => {
    const doc = documents.get(id);
    if (!doc) return;
    update(id, patch);
    if (doc.status === 'ready' && doc.chunkCount > 0) bump(doc.ownerId);
  };
  // Insertion order breaks createdAt ties (several uploads in one millisecond).
  const sequence = new Map<string, number>();
  const newestFirst = (a: DocumentRecord, b: DocumentRecord) =>
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (sequence.get(b.id) ?? 0) - (sequence.get(a.id) ?? 0);
  /** Same rule as the Drizzle repository: the newest ready resume is primary. */
  const refreshPrimaryResume = (ownerId: string) => {
    const [newest] = [...documents.values()]
      .filter((d) => d.ownerId === ownerId && d.kind === 'resume' && d.status === 'ready')
      .sort(newestFirst);
    for (const d of documents.values()) {
      if (d.ownerId !== ownerId) continue;
      const primary = d.id === newest?.id;
      if (d.isPrimaryResume !== primary) update(d.id, { isPrimaryResume: primary });
    }
  };

  return {
    documents,
    get chunks() {
      return chunks;
    },
    extractedText,
    findings,

    async findBySha256(ownerId, sha256) {
      return (
        [...documents.values()].find((d) => d.ownerId === ownerId && d.sha256 === sha256) ?? null
      );
    },

    async createDocument(doc) {
      const existing = [...documents.values()].find(
        (d) => d.ownerId === doc.ownerId && d.sha256 === doc.sha256,
      );
      if (existing) return { document: existing, created: false };

      const now = new Date();
      const record: DocumentRecord = {
        ...doc,
        id: randomUUID(),
        isPrimaryResume: false,
        status: 'pending',
        error: null,
        chunkCount: 0,
        findingCount: 0,
        scannedAt: null,
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      documents.set(record.id, record);
      sequence.set(record.id, sequence.size);
      return { document: record, created: true };
    },

    async getDocument(ownerId, id) {
      const doc = documents.get(id);
      return doc && doc.ownerId === ownerId ? doc : null;
    },

    async listDocuments(ownerId) {
      return [...documents.values()].filter((d) => d.ownerId === ownerId).sort(newestFirst);
    },

    async getExtractedText(ownerId, id) {
      const doc = documents.get(id);
      if (!doc || doc.ownerId !== ownerId) return null;
      return { text: extractedText.get(id) ?? null };
    },

    async getPrimaryResume(ownerId) {
      return (
        [...documents.values()].find((d) => d.ownerId === ownerId && d.isPrimaryResume) ?? null
      );
    },

    async setPrimaryResume(ownerId, id) {
      const doc = documents.get(id);
      if (!doc || doc.ownerId !== ownerId) return null;
      if (doc.kind !== 'resume' || doc.status !== 'ready') {
        throw new ConflictError('Only a ready resume can be the primary resume');
      }
      for (const d of documents.values()) {
        if (d.ownerId === ownerId && d.isPrimaryResume && d.id !== id) {
          update(d.id, { isPrimaryResume: false });
        }
      }
      if (!doc.isPrimaryResume) update(id, { isPrimaryResume: true });
      return documents.get(id) ?? null;
    },

    async resetToPending(id) {
      leaveReady(id, { status: 'pending', error: null });
    },

    async markProcessing(id) {
      leaveReady(id, { status: 'processing', error: null });
    },

    async completeIngestion(id, text, newChunks, scanFindings) {
      const doc = documents.get(id);
      if (!doc) throw new Error(`document ${id} no longer exists`);
      const stored = RiskFindingSchema.array().parse(scanFindings);
      chunks = chunks.filter((c) => c.documentId !== id);
      chunks.push(...newChunks.map((c) => ({ ...c, id: randomUUID(), documentId: id })));
      extractedText.set(id, text);
      findings.set(id, stored);
      const flagged = stored.length > 0;
      update(id, {
        status: flagged ? 'needs_review' : 'ready',
        error: null,
        chunkCount: newChunks.length,
        findingCount: stored.length,
        scannedAt: new Date(),
        approvedAt: null,
      });
      if (doc.kind === 'resume') refreshPrimaryResume(doc.ownerId);
      return flagged ? (versions.get(doc.ownerId) ?? 0) : bump(doc.ownerId);
    },

    async getRiskFindings(ownerId, id) {
      const doc = documents.get(id);
      if (!doc || doc.ownerId !== ownerId) return null;
      return { document: doc, findings: findings.get(id) ?? [] };
    },

    async approveDocument(ownerId, id) {
      const doc = documents.get(id);
      if (!doc || doc.ownerId !== ownerId) return null;
      const activated = doc.status === 'needs_review';
      if (activated) {
        update(id, { status: 'ready', approvedAt: new Date() });
        if (doc.kind === 'resume') refreshPrimaryResume(ownerId);
        bump(ownerId);
      } else if (doc.status === 'ready' && doc.findingCount > 0 && doc.approvedAt === null) {
        update(id, { approvedAt: new Date() });
      } else {
        throw new ConflictError('Only a document with findings to review can be approved');
      }
      const updated = documents.get(id);
      return updated ? { document: updated, activated } : null;
    },

    async listUnscannedReady() {
      return [...documents.values()].filter((d) => d.status === 'ready' && d.scannedAt === null);
    },

    async recordBackfillScan(id, scanFindings) {
      const doc = documents.get(id);
      if (!doc || doc.status !== 'ready' || doc.scannedAt !== null) return false;
      const stored = RiskFindingSchema.array().parse(scanFindings);
      findings.set(id, stored);
      update(id, { findingCount: stored.length, scannedAt: new Date() });
      return true;
    },

    async failIngestion(id, error) {
      leaveReady(id, { status: 'failed', error });
    },

    async deleteDocument(ownerId, id) {
      const doc = documents.get(id);
      if (!doc || doc.ownerId !== ownerId) return null;
      documents.delete(id);
      chunks = chunks.filter((c) => c.documentId !== id);
      if (doc.status === 'ready' && doc.chunkCount > 0) bump(ownerId);
      if (doc.isPrimaryResume) refreshPrimaryResume(ownerId);
      return doc;
    },

    async isStoragePathInUse(storagePath) {
      return [...documents.values()].some((d) => d.storagePath === storagePath);
    },

    async listUnfinished() {
      return [...documents.values()].filter(
        (d) => d.status === 'pending' || d.status === 'processing',
      );
    },

    async search(ownerId, embedding, k): Promise<RetrievedChunk[]> {
      return chunks
        .map((c) => ({ c, doc: documents.get(c.documentId) }))
        .filter(({ doc }) => doc && doc.ownerId === ownerId && doc.status === 'ready')
        .map(({ c, doc }) => ({
          chunkId: c.id,
          documentId: c.documentId,
          filename: doc?.filename ?? '',
          heading: c.heading,
          content: c.content,
          ordinal: c.ordinal,
          similarity: cosine(c.embedding, embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, k);
    },

    async getVersion(ownerId) {
      return versions.get(ownerId) ?? 0;
    },
  };
}
