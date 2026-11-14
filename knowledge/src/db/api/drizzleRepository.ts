import { and, asc, cosineDistance, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { KnowledgeDb, KnowledgeExecutor, KnowledgeTx } from '../index.js';
import { chunks, corpusState, documents } from '../schema.js';
import {
  ConflictError,
  type DocumentRecord,
  type KnowledgeRepository,
  type NewChunk,
  type NewDocument,
  type RetrievedChunk,
} from './repository.js';

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

/** Postgres error 23505, whether thrown by postgres.js directly or wrapped by Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; typeof e === 'object' && e !== null; ) {
    if ('code' in e && e.code === '23505') return true;
    e = 'cause' in e ? e.cause : undefined;
  }
  return false;
}

/** Re-throws a unique violation as a 409 ConflictError; anything else unchanged. */
export function toConflictError(error: unknown): unknown {
  return isUniqueViolation(error)
    ? new ConflictError('The document conflicts with an existing one', { cause: error })
    : error;
}

async function withConflicts<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toConflictError(error);
  }
}

/**
 * Serializes document creation, deletion and primary-resume changes per
 * owner, for the rest of the transaction. Take it before any row lock, so
 * every path acquires locks in the same order.
 */
async function lockOwner(tx: KnowledgeTx, ownerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerId}))`);
}

/** Increments the owner's corpus version, creating the row on first use. */
async function bumpVersion(tx: KnowledgeTx, ownerId: string): Promise<number> {
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

/**
 * Applies the primary-resume rule: the owner's newest ready resume is
 * primary, and nothing else is. Demotes before promoting, so the
 * one-primary-per-owner index is never violated. Call under `lockOwner`.
 */
async function refreshPrimaryResume(tx: KnowledgeTx, ownerId: string): Promise<void> {
  const [newest] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.ownerId, ownerId),
        eq(documents.kind, 'resume'),
        eq(documents.status, 'ready'),
      ),
    )
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(1);

  await tx
    .update(documents)
    .set({ isPrimaryResume: false })
    .where(
      and(
        eq(documents.ownerId, ownerId),
        eq(documents.isPrimaryResume, true),
        newest ? ne(documents.id, newest.id) : undefined,
      ),
    );
  if (newest) {
    await tx
      .update(documents)
      .set({ isPrimaryResume: true })
      .where(and(eq(documents.id, newest.id), eq(documents.isPrimaryResume, false)));
  }
}

async function currentVersion(executor: KnowledgeExecutor, ownerId: string): Promise<number> {
  const [row] = await executor
    .select({ version: corpusState.version })
    .from(corpusState)
    .where(eq(corpusState.ownerId, ownerId))
    .limit(1);
  return row?.version ?? 0;
}

async function findBySha256(
  executor: KnowledgeExecutor,
  ownerId: string,
  sha256: string,
): Promise<DocumentRecord | null> {
  const [row] = await executor
    .select(documentColumns)
    .from(documents)
    .where(and(eq(documents.ownerId, ownerId), eq(documents.sha256, sha256)))
    .limit(1);
  return row ?? null;
}

type StatusChange = Pick<typeof documents.$inferInsert, 'status' | 'error'>;

export function createDrizzleRepository(db: KnowledgeDb): KnowledgeRepository {
  /**
   * Moves a document to a non-ready status. If it was ready with chunks, those
   * chunks stop being served (search only reads ready documents), so the
   * version is bumped in the same transaction.
   */
  async function leaveReady(id: string, change: StatusChange): Promise<void> {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select({
          ownerId: documents.ownerId,
          status: documents.status,
          chunkCount: documents.chunkCount,
        })
        .from(documents)
        .where(eq(documents.id, id))
        .for('update');
      if (!before) return;

      await tx.update(documents).set(change).where(eq(documents.id, id));
      if (before.status === 'ready' && before.chunkCount > 0) {
        await bumpVersion(tx, before.ownerId);
      }
    });
  }

  return {
    async findBySha256(ownerId, sha256) {
      return findBySha256(db, ownerId, sha256);
    },

    async createDocument(doc: NewDocument) {
      // This is the only path that inserts documents. Under the owner lock,
      // the lookup and the insert cannot race another upload or a delete,
      // so a unique violation here would be a bug; it still maps to a 409
      // rather than a 500.
      return withConflicts(() =>
        db.transaction(async (tx) => {
          await lockOwner(tx, doc.ownerId);
          const existing = await findBySha256(tx, doc.ownerId, doc.sha256);
          if (existing) return { document: existing, created: false };

          // Never primary on insert: a resume is promoted when its ingest
          // completes, so a failed upload cannot displace a good resume.
          const [inserted] = await tx
            .insert(documents)
            .values({ ...doc, isPrimaryResume: false })
            .returning(documentColumns);
          if (!inserted) throw new Error('document insert returned no row');
          return { document: inserted, created: true };
        }),
      );
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

    async getExtractedText(ownerId, id) {
      const [row] = await db
        .select({ text: documents.extractedText })
        .from(documents)
        .where(and(eq(documents.ownerId, ownerId), eq(documents.id, id)))
        .limit(1);
      return row ?? null;
    },

    async setPrimaryResume(ownerId, id) {
      return db.transaction(async (tx) => {
        // Same lock as the paths that recompute the primary, so a concurrent
        // ingest or delete cannot interleave with the demote and promote.
        await lockOwner(tx, ownerId);
        const [doc] = await tx
          .select({ kind: documents.kind, status: documents.status })
          .from(documents)
          .where(and(eq(documents.ownerId, ownerId), eq(documents.id, id)))
          .for('update');
        if (!doc) return null;
        if (doc.kind !== 'resume' || doc.status !== 'ready') {
          throw new ConflictError('Only a ready resume can be the primary resume');
        }

        // Demote first, so the one-primary-per-owner index is never violated.
        await tx
          .update(documents)
          .set({ isPrimaryResume: false })
          .where(
            and(
              eq(documents.ownerId, ownerId),
              eq(documents.isPrimaryResume, true),
              ne(documents.id, id),
            ),
          );
        const [updated] = await tx
          .update(documents)
          .set({ isPrimaryResume: true })
          .where(eq(documents.id, id))
          .returning(documentColumns);
        return updated ?? null;
      });
    },

    async resetToPending(id) {
      await leaveReady(id, { status: 'pending', error: null });
    },

    async markProcessing(id) {
      await leaveReady(id, { status: 'processing', error: null });
    },

    async completeIngestion(id, extractedText, newChunks: NewChunk[]) {
      return withConflicts(() =>
        db.transaction(async (tx) => {
          // owner_id never changes, so it can be read before taking the
          // owner lock; the lock comes before the row lock (see lockOwner).
          const [owner] = await tx
            .select({ ownerId: documents.ownerId })
            .from(documents)
            .where(eq(documents.id, id));
          if (!owner) throw new Error(`document ${id} no longer exists`);
          await lockOwner(tx, owner.ownerId);

          const [doc] = await tx
            .select({ ownerId: documents.ownerId, kind: documents.kind })
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
            .set({ status: 'ready', error: null, extractedText, chunkCount: newChunks.length })
            .where(eq(documents.id, id));

          if (doc.kind === 'resume') await refreshPrimaryResume(tx, doc.ownerId);
          return bumpVersion(tx, doc.ownerId);
        }),
      );
    },

    async failIngestion(id, error) {
      await leaveReady(id, { status: 'failed', error });
    },

    async deleteDocument(ownerId, id) {
      return db.transaction(async (tx) => {
        await lockOwner(tx, ownerId);
        const [deleted] = await tx
          .delete(documents)
          .where(and(eq(documents.ownerId, ownerId), eq(documents.id, id)))
          .returning(documentColumns);
        if (!deleted) return null;

        if (deleted.status === 'ready' && deleted.chunkCount > 0) {
          await bumpVersion(tx, ownerId);
        }
        if (deleted.isPrimaryResume) await refreshPrimaryResume(tx, ownerId);
        return deleted;
      });
    },

    async isStoragePathInUse(storagePath) {
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.storagePath, storagePath))
        .limit(1);
      return row !== undefined;
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
      const rows = await db.transaction(async (tx) => {
        // The HNSW index returns its `hnsw.ef_search` (default 40) nearest
        // chunks across all owners and statuses, and the owner/status filter
        // runs afterwards. If those nearest chunks belong to someone else or
        // to a document that is not ready, fewer than `k` rows (even none)
        // come back. Iterative scans (pgvector 0.8+, which Supabase ships)
        // keep reading the index until `k` rows pass the filter.
        // `relaxed_order` vs `strict_order`: strict returns rows in exact
        // distance order but stops sooner (pgvector re-ranks within a bounded
        // buffer, so it can return fewer matches); relaxed keeps scanning for
        // better recall and may yield rows slightly out of order. With k <= 20
        // re-sorting in memory is free, so relaxed plus the sort below gives
        // both. SET LOCAL ends with the transaction, so it is safe behind a
        // transaction pooler.
        await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
        return tx
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
      });

      return rows
        .map(({ distance: d, ...rest }) => ({ ...rest, similarity: 1 - Number(d) }))
        .sort((a, b) => b.similarity - a.similarity);
    },

    async getVersion(ownerId) {
      return currentVersion(db, ownerId);
    },
  };
}
