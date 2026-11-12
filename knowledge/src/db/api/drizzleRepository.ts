import { and, asc, cosineDistance, desc, eq, inArray, sql } from 'drizzle-orm';
import type { KnowledgeDb } from '../index.js';
import { chunks, corpusState, documents } from '../schema.js';
import type { KnowledgeRepository, NewChunk, NewDocument, RetrievedChunk } from './repository.js';

/** Every document column except the extracted text, which can be large. */
const documentColumns = {
  id: documents.id,
  ownerId: documents.ownerId,
  filename: documents.filename,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  sha256: documents.sha256,
  storagePath: documents.storagePath,
  kind: documents.kind,
  isPrimaryResume: documents.isPrimaryResume,
  status: documents.status,
  error: documents.error,
  chunkCount: documents.chunkCount,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

type Tx = Parameters<Parameters<KnowledgeDb['transaction']>[0]>[0];

/** Increments the owner's corpus version, creating the row on first use. */
async function bumpVersion(tx: Tx, ownerId: string): Promise<number> {
  const [row] = await tx
    .insert(corpusState)
    .values({ ownerId, version: 1 })
    .onConflictDoUpdate({
      target: corpusState.ownerId,
      set: { version: sql`${corpusState.version} + 1`, updatedAt: sql`now()` },
    })
    .returning({ version: corpusState.version });
  if (!row) throw new Error('corpus_state upsert returned no row');
  return row.version;
}

export function createDrizzleRepository(db: KnowledgeDb): KnowledgeRepository {
  return {
    async findBySha256(ownerId, sha256) {
      const [row] = await db
        .select(documentColumns)
        .from(documents)
        .where(and(eq(documents.ownerId, ownerId), eq(documents.sha256, sha256)))
        .limit(1);
      return row ?? null;
    },

    async createDocument(doc: NewDocument) {
      return db.transaction(async (tx) => {
        const isResume = doc.kind === 'resume';
        if (isResume) {
          await tx
            .update(documents)
            .set({ isPrimaryResume: false, updatedAt: sql`now()` })
            .where(and(eq(documents.ownerId, doc.ownerId), eq(documents.isPrimaryResume, true)));
        }
        const [row] = await tx
          .insert(documents)
          .values({ ...doc, isPrimaryResume: isResume })
          .returning(documentColumns);
        if (!row) throw new Error('document insert returned no row');
        return row;
      });
    },

    async getDocument(ownerId, id) {
      const [row] = await db
        .select(documentColumns)
        .from(documents)
        .where(and(eq(documents.ownerId, ownerId), eq(documents.id, id)))
        .limit(1);
      return row ?? null;
    },

    async listDocuments(ownerId) {
      return db
        .select(documentColumns)
        .from(documents)
        .where(eq(documents.ownerId, ownerId))
        .orderBy(desc(documents.createdAt));
    },

    async resetToPending(id) {
      await db
        .update(documents)
        .set({ status: 'pending', error: null, updatedAt: sql`now()` })
        .where(eq(documents.id, id));
    },

    async markProcessing(id) {
      await db
        .update(documents)
        .set({ status: 'processing', error: null, updatedAt: sql`now()` })
        .where(eq(documents.id, id));
    },

    async completeIngestion(id, extractedText, newChunks: NewChunk[]) {
      return db.transaction(async (tx) => {
        const [doc] = await tx
          .select({ ownerId: documents.ownerId })
          .from(documents)
          .where(eq(documents.id, id))
          .for('update');
        if (!doc) throw new Error(`document ${id} no longer exists`);

        await tx.delete(chunks).where(eq(chunks.documentId, id));
        if (newChunks.length > 0) {
          await tx.insert(chunks).values(newChunks.map((c) => ({ ...c, documentId: id })));
        }
        await tx
          .update(documents)
          .set({
            status: 'ready',
            error: null,
            extractedText,
            chunkCount: newChunks.length,
            updatedAt: sql`now()`,
          })
          .where(eq(documents.id, id));

        return bumpVersion(tx, doc.ownerId);
      });
    },

    async failIngestion(id, error) {
      await db
        .update(documents)
        .set({ status: 'failed', error, updatedAt: sql`now()` })
        .where(eq(documents.id, id));
    },

    async deleteDocument(ownerId, id) {
      return db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(documents)
          .where(and(eq(documents.ownerId, ownerId), eq(documents.id, id)))
          .returning(documentColumns);
        if (!deleted) return null;

        const contributed = deleted.status === 'ready' && deleted.chunkCount > 0;
        const version = contributed
          ? await bumpVersion(tx, ownerId)
          : await currentVersion(tx, ownerId);
        return { deleted, version };
      });
    },

    async listUnfinished() {
      return db
        .select(documentColumns)
        .from(documents)
        .where(inArray(documents.status, ['pending', 'processing']))
        .orderBy(asc(documents.createdAt));
    },

    async search(ownerId, embedding, k): Promise<RetrievedChunk[]> {
      const distance = cosineDistance(chunks.embedding, embedding);
      const rows = await db
        .select({
          chunkId: chunks.id,
          documentId: chunks.documentId,
          filename: documents.filename,
          heading: chunks.heading,
          content: chunks.content,
          ordinal: chunks.ordinal,
          distance: sql<number>`${distance}`,
        })
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(and(eq(documents.ownerId, ownerId), eq(documents.status, 'ready')))
        .orderBy(distance)
        .limit(k);

      return rows.map(({ distance: d, ...rest }) => ({ ...rest, similarity: 1 - Number(d) }));
    },

    async getVersion(ownerId) {
      return currentVersion(db, ownerId);
    },
  };
}

async function currentVersion(executor: KnowledgeDb | Tx, ownerId: string): Promise<number> {
  const [row] = await executor
    .select({ version: corpusState.version })
    .from(corpusState)
    .where(eq(corpusState.ownerId, ownerId))
    .limit(1);
  return row?.version ?? 0;
}
