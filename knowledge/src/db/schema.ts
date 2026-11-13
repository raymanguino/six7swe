import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import { DOCUMENT_KINDS, DOCUMENT_STATUSES } from '../contract.js';

/**
 * The knowledge service owns the `knowledge` Postgres schema and nothing else.
 *
 * It lives in the same Supabase project as the backend's `public` schema, so
 * the two must never manage each other's objects. `drizzle.config.ts` sets
 * `schemaFilter: ['knowledge']`, and the migration ledger lives in its own
 * `knowledge_migrations` schema (see `src/db/ledger.ts`), so the backend's
 * `db:reset` (which drops `public` and the shared `drizzle` ledger schema)
 * cannot touch either.
 */
export const knowledge = pgSchema('knowledge');

/** Must match the embedding model's output. text-embedding-3-small is 1536. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Values come from the wire contract, so the API and the database cannot drift apart. */
export const documentKind = knowledge.enum('document_kind', DOCUMENT_KINDS);

export const documentStatus = knowledge.enum('document_status', DOCUMENT_STATUSES);

export const documents = knowledge.table(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Supabase auth subject that owns this document. */
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Hex SHA-256 of the raw bytes; uploading identical bytes again is a no-op. */
    sha256: varchar('sha256', { length: 64 }).notNull(),
    /** Key of the raw file in the file store. */
    storagePath: text('storage_path').notNull(),
    kind: documentKind('kind').notNull().default('supporting'),
    /** The resume served as the downloadable PDF. At most one per owner. */
    isPrimaryResume: boolean('is_primary_resume').notNull().default(false),
    status: documentStatus('status').notNull().default('pending'),
    error: text('error'),
    /** The text extracted from the file, kept for previews and re-chunking. */
    extractedText: text('extracted_text'),
    chunkCount: integer('chunk_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('documents_owner_sha256_uq').on(t.ownerId, t.sha256),
    uniqueIndex('documents_owner_primary_resume_uq')
      .on(t.ownerId)
      .where(sql`${t.isPrimaryResume} = true`),
    index('documents_status_idx').on(t.status),
  ],
);

export const chunks = knowledge.table(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** Position of the chunk within its document, from 0. */
    ordinal: integer('ordinal').notNull(),
    /** The heading path the chunk sits under, e.g. "Experience > Acme". */
    heading: text('heading'),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chunks_document_ordinal_uq').on(t.documentId, t.ordinal),
    index('chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/**
 * One row per owner. `version` is bumped whenever the set of ready chunks
 * changes, so consumers can use it as a cache key and to detect stale scores.
 */
export const corpusState = knowledge.table('corpus_state', {
  ownerId: varchar('owner_id', { length: 255 }).primaryKey(),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type DocumentRow = typeof documents.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
