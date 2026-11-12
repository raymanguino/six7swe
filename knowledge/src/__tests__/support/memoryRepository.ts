import { randomUUID } from 'node:crypto';
import type {
  DocumentRecord,
  KnowledgeRepository,
  NewChunk,
  RetrievedChunk,
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
} {
  const documents = new Map<string, DocumentRecord>();
  const extractedText = new Map<string, string>();
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

  return {
    documents,
    get chunks() {
      return chunks;
    },
    extractedText,

    async findBySha256(ownerId, sha256) {
      return (
        [...documents.values()].find((d) => d.ownerId === ownerId && d.sha256 === sha256) ?? null
      );
    },

    async createDocument(doc) {
      if (
        [...documents.values()].some((d) => d.ownerId === doc.ownerId && d.sha256 === doc.sha256)
      ) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      if (doc.kind === 'resume') {
        for (const d of documents.values()) {
          if (d.ownerId === doc.ownerId && d.isPrimaryResume)
            update(d.id, { isPrimaryResume: false });
        }
      }
      const now = new Date();
      const record: DocumentRecord = {
        ...doc,
        id: randomUUID(),
        isPrimaryResume: doc.kind === 'resume',
        status: 'pending',
        error: null,
        chunkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      documents.set(record.id, record);
      return record;
    },

    async getDocument(ownerId, id) {
      const doc = documents.get(id);
      return doc && doc.ownerId === ownerId ? doc : null;
    },

    async listDocuments(ownerId) {
      return [...documents.values()]
        .filter((d) => d.ownerId === ownerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async resetToPending(id) {
      update(id, { status: 'pending', error: null });
    },

    async markProcessing(id) {
      update(id, { status: 'processing', error: null });
    },

    async completeIngestion(id, text, newChunks) {
      const doc = documents.get(id);
      if (!doc) throw new Error(`document ${id} no longer exists`);
      chunks = chunks.filter((c) => c.documentId !== id);
      chunks.push(...newChunks.map((c) => ({ ...c, id: randomUUID(), documentId: id })));
      extractedText.set(id, text);
      update(id, { status: 'ready', error: null, chunkCount: newChunks.length });
      return bump(doc.ownerId);
    },

    async failIngestion(id, error) {
      update(id, { status: 'failed', error });
    },

    async deleteDocument(ownerId, id) {
      const doc = documents.get(id);
      if (!doc || doc.ownerId !== ownerId) return null;
      documents.delete(id);
      chunks = chunks.filter((c) => c.documentId !== id);
      const contributed = doc.status === 'ready' && doc.chunkCount > 0;
      return { deleted: doc, version: contributed ? bump(ownerId) : (versions.get(ownerId) ?? 0) };
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
