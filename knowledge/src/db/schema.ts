import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  EVAL_QUESTION_ORIGINS,
  EVAL_QUESTION_STATUSES,
  EVAL_RUN_STATUSES,
  EVAL_RUN_TRIGGERS,
  PROFILE_STAGES,
  type ProfileData,
  type RiskFinding,
} from '../contract.js';

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
    /**
     * The risk scan's findings for the current extracted text (#212),
     * validated against `RiskFindingSchema` on the way in. Null until the
     * text has been scanned; an empty list when the scan found nothing.
     */
    riskFindings: jsonb('risk_findings').$type<RiskFinding[]>(),
    /** When the current extracted text was scanned; null until then. */
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** When the owner approved the current findings as they are; null otherwise. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      // The database clock, like the defaults and the corpus_state upsert.
      .$onUpdate(() => sql`now()`),
  },
  (t) => [
    uniqueIndex('documents_owner_sha256_uq').on(t.ownerId, t.sha256),
    uniqueIndex('documents_owner_primary_resume_uq')
      .on(t.ownerId)
      .where(sql`${t.isPrimaryResume} = true`),
    index('documents_status_idx').on(t.status),
    // Deleting a document checks whether its content-addressed file is still in use.
    index('documents_storage_path_idx').on(t.storagePath),
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

export const profileStage = knowledge.enum('profile_stage', PROFILE_STAGES);

/** Hands out profile `version`s; see `ProfileDtoSchema.version`. */
export const profileVersionSeq = knowledge.sequence('profile_version_seq');

/** The next profile `version`: the one expression every write to `profiles` uses. */
export const nextProfileVersion = () => sql<number>`nextval('knowledge.profile_version_seq')`;

/**
 * The structured profile behind the landing page (#86), at most one row per
 * owner and stage: the `draft` the model wrote (and the owner may have
 * edited), and the `published` one the portfolio serves. Publishing copies the
 * draft over the published row and deletes the draft, so a draft always means
 * unpublished changes.
 *
 * The list fields are jsonb, validated against `ProfileDataSchema` on the way
 * in and on the way out.
 */
export const profiles = knowledge.table(
  'profiles',
  {
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    stage: profileStage('stage').notNull(),
    name: text('name').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    summary: text('summary').notNull(),
    skills: jsonb('skills').$type<ProfileData['skills']>().notNull(),
    experience: jsonb('experience').$type<ProfileData['experience']>().notNull(),
    projects: jsonb('projects').$type<ProfileData['projects']>().notNull(),
    links: jsonb('links').$type<ProfileData['links']>().notNull(),
    /** The resume it was drafted from. Deleting that resume keeps the profile. */
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    /**
     * See `ProfileDtoSchema.version`. `$onUpdate` bumps it on any update that
     * leaves it out (drizzle applies it to `onConflictDoUpdate` too), but the
     * repository's writes still set it explicitly through `touched()`.
     */
    version: bigint('version', { mode: 'number' })
      .notNull()
      .default(nextProfileVersion())
      .$onUpdate(nextProfileVersion),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.stage] })],
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
    .$onUpdate(() => sql`now()`),
});

export const evalQuestionStatus = knowledge.enum('eval_question_status', EVAL_QUESTION_STATUSES);
export const evalQuestionOrigin = knowledge.enum('eval_question_origin', EVAL_QUESTION_ORIGINS);
export const evalRunTrigger = knowledge.enum('eval_run_trigger', EVAL_RUN_TRIGGERS);
export const evalRunStatus = knowledge.enum('eval_run_status', EVAL_RUN_STATUSES);

/**
 * The evolving chat eval set (#85). Each row is one cluster of similar
 * visitor questions (or a canned question), kept under the first wording seen,
 * redacted and truncated. Nothing else about the visitor is stored: no IPs,
 * no history, and sessions only as hashes (`eval_question_sessions`).
 *
 * Clusters are matched by a brute-force cosine scan over the owner's rows:
 * there are at most a few hundred (candidates expire after 90 days), so an
 * HNSW index, with its post-filtering caveats, would not pay for itself.
 */
export const evalQuestions = knowledge.table(
  'eval_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    question: text('question').notNull(),
    /** The embedding of the stored (redacted) wording; clustering compares against it. */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    status: evalQuestionStatus('status').notNull().default('candidate'),
    origin: evalQuestionOrigin('origin').notNull().default('visitor'),
    pinned: boolean('pinned').notNull().default(false),
    offTopic: boolean('off_topic').notNull().default(false),
    hitCount: integer('hit_count').notNull().default(0),
    distinctSessions: integer('distinct_sessions').notNull().default(0),
    lastAskedAt: timestamp('last_asked_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the question last became `retired` (by the owner or by eviction);
     * null while it is not retired. Retired visitor questions are purged by
     * this, not by `last_asked_at`, so a retirement always stays visible (and
     * reversible) for the full TTL.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [index('eval_questions_owner_status_idx').on(t.ownerId, t.status, t.lastAskedAt)],
);

/** The sessions that asked each question, as SHA-256 hashes of the browser's random id. */
export const evalQuestionSessions = knowledge.table(
  'eval_question_sessions',
  {
    questionId: uuid('question_id')
      .notNull()
      .references(() => evalQuestions.id, { onDelete: 'cascade' }),
    sessionHash: varchar('session_hash', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.questionId, t.sessionHash] })],
);

/** One run of the active questions against the corpus at `corpus_version`. */
export const evalRuns = knowledge.table(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    corpusVersion: integer('corpus_version').notNull(),
    trigger: evalRunTrigger('trigger').notNull(),
    status: evalRunStatus('status').notNull().default('running'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('eval_runs_owner_started_idx').on(t.ownerId, t.startedAt)],
);

/**
 * One question's outcome in a run. The question's text is copied, so the
 * result survives the question being purged (`question_id` is then null).
 */
export const evalResults = knowledge.table(
  'eval_results',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    /** The question's position in the run, for a stable order. */
    ordinal: integer('ordinal').notNull(),
    questionId: uuid('question_id').references(() => evalQuestions.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    answer: text('answer'),
    chunkIds: jsonb('chunk_ids').$type<string[]>().notNull(),
    topSimilarity: doublePrecision('top_similarity'),
    gap: boolean('gap').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.ordinal] })],
);
