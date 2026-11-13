import { randomUUID } from 'node:crypto';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleRepository } from '../db/api/drizzleRepository.js';
import type { KnowledgeRepository, NewChunk, NewDocument } from '../db/api/repository.js';
import { createDb, type DbHandle } from '../db/index.js';
import { corpusState, documents, EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { uploadDocument } from '../services/documents.js';
import { createHashingEmbedder, hashEmbed } from '../services/embedding/hashing.js';
import { createIngestionQueue } from '../services/ingestion/pipeline.js';
import { retrieve } from '../services/retrieval.js';
import {
  createMemoryFileStore,
  makePdf,
  PROJECT_NOTES_TXT,
  RESUME_MD,
  silentLogger,
  utf8,
} from './support/fixtures.js';
import { describeRepositoryContract } from './support/repositoryContract.js';

/**
 * Runs the Drizzle repository against a real Postgres with pgvector 0.8+.
 *
 * Skipped locally unless KNOWLEDGE_TEST_DATABASE_URL points at a database
 * where `db:migrate` has been applied, e.g. the local Supabase stack:
 *
 *   KNOWLEDGE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     pnpm --filter @six7swe/knowledge test
 *
 * In CI the variable is required, so the suite cannot be skipped silently.
 *
 * Every test writes under its own owner id, all sharing this run's prefix,
 * and the rows are removed afterwards, so it is safe against a development
 * database and no test depends on another.
 */
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
if (process.env.CI && !url) {
  throw new Error(
    'KNOWLEDGE_TEST_DATABASE_URL must be set in CI; the Postgres suite would be skipped.',
  );
}

const RUN_PREFIX = `test-${randomUUID()}-`;
const freshOwner = () => `${RUN_PREFIX}${randomUUID()}`;

/** The same URL with connection parameters set at startup (postgres.js passes unknown ones on). */
function withParams(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u.toString();
}

let handle: DbHandle | undefined;
let repo: KnowledgeRepository | undefined;

function db(): { handle: DbHandle; repo: KnowledgeRepository } {
  if (!handle || !repo) throw new Error('database not opened');
  return { handle, repo };
}

beforeAll(() => {
  if (!url) return;
  handle = createDb(url);
  repo = createDrizzleRepository(handle.db);
});

afterAll(async () => {
  if (!handle) return;
  await handle.db.delete(documents).where(like(documents.ownerId, `${RUN_PREFIX}%`));
  await handle.db.delete(corpusState).where(like(corpusState.ownerId, `${RUN_PREFIX}%`));
  await handle.close();
});

describeRepositoryContract(
  'drizzle (Postgres + pgvector)',
  () => ({ repo: db().repo, newOwner: freshOwner }),
  {
    skip: !url,
  },
);

describe.skipIf(!url)('Drizzle repository (Postgres + pgvector)', () => {
  const embedder = createHashingEmbedder(EMBEDDING_DIMENSIONS);

  /** The real pipeline on top of the Drizzle repository, for one test. */
  const pipeline = () => {
    const { repo: r } = db();
    const files = createMemoryFileStore();
    const queue = createIngestionQueue({ repo: r, files, embedder }, silentLogger);
    const deps = { repo: r, files, queue, log: silentLogger };
    const owner = freshOwner();
    const upload = (
      filename: string,
      bytes: Uint8Array,
      kind: 'resume' | 'supporting' = 'supporting',
    ) => uploadDocument(deps, { ownerId: owner, filename, bytes, kind });
    return { repo: r, queue, owner, upload };
  };

  const newDoc = (ownerId: string, name: string): NewDocument => ({
    ownerId,
    filename: name,
    mimeType: 'text/plain',
    sizeBytes: 1,
    sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    storagePath: `${ownerId}/${name}`,
    kind: 'supporting',
  });

  const chunkOf = (text: string, ordinal: number, embedding: number[]): NewChunk => ({
    ordinal,
    heading: null,
    content: text,
    tokenCount: 1,
    embedding,
  });

  it('ingests md, txt and pdf end to end and retrieves by vector similarity', async () => {
    const { repo: r, queue, owner, upload } = pipeline();
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    await upload('project.txt', utf8(PROJECT_NOTES_TXT));
    await upload('cert.pdf', makePdf(['Certified Kubernetes Administrator, 2023']));
    await queue.idle();

    const docs = await r.listDocuments(owner);
    expect(docs.map((d) => d.status)).toEqual(['ready', 'ready', 'ready']);
    expect(docs.find((d) => d.filename === 'resume.md')?.isPrimaryResume).toBe(true);
    expect(await r.getVersion(owner)).toBe(3);

    const result = await retrieve(
      { repo: r, embedder },
      owner,
      'Kubernetes administrator certification',
      2,
    );
    expect(result.version).toBe(3);
    expect(result.chunks[0]?.filename).toBe('cert.pdf');
  });

  it('bumps the version exactly once per concurrent completeIngestion', async () => {
    const { repo: r } = db();
    const o = freshOwner();
    const [a, b] = await Promise.all([
      r.createDocument(newDoc(o, 'a.txt')),
      r.createDocument(newDoc(o, 'b.txt')),
    ]);
    const vec = (t: string) => hashEmbed(t, EMBEDDING_DIMENSIONS);
    await Promise.all([
      r.completeIngestion(a.document.id, 'a', [chunkOf('alpha', 0, vec('alpha'))]),
      r.completeIngestion(b.document.id, 'b', [chunkOf('bravo', 0, vec('bravo'))]),
    ]);
    expect(await r.getVersion(o)).toBe(2);
  });

  it('handles concurrent resume uploads and deletes without errors', async () => {
    const { repo: r, queue, owner, upload } = pipeline();
    const results = await Promise.all([
      upload('r1.md', utf8('# Resume one'), 'resume'),
      upload('r2.md', utf8('# Resume two'), 'resume'),
      upload('r3.md', utf8('# Resume three'), 'resume'),
      // Identical bytes racing each other: one is created, the other deduplicated.
      upload('r4.md', utf8('# Resume four'), 'resume'),
      upload('r4-copy.md', utf8('# Resume four'), 'resume'),
    ]);
    expect(results.filter((res) => res.deduplicated)).toHaveLength(1);
    await queue.idle();

    const docs = await r.listDocuments(owner);
    expect(docs).toHaveLength(4);
    expect(docs.filter((d) => d.isPrimaryResume)).toHaveLength(1);

    // Deleting every resume at once, while re-uploading one, never trips the
    // one-primary index or leaves a primary that is gone.
    await Promise.all([
      ...docs.map((d) => r.deleteDocument(owner, d.id)),
      upload('r5.md', utf8('# Resume five'), 'resume'),
    ]);
    await queue.idle();
    const left = await r.listDocuments(owner);
    expect(left.map((d) => d.filename)).toEqual(['r5.md']);
    expect(left[0]?.isPrimaryResume).toBe(true);
  });

  it('returns k ready rows when a non-ready document holds the nearest chunks', async () => {
    const { repo: r } = db();
    // Force the ordered HNSW index scan (on a table this small the planner
    // would otherwise filter by owner first and sort, which hides the
    // problem), and shrink the candidate list from its default of 40 so a
    // handful of rows reproduces it: one pass of the index then yields only
    // the few nearest chunks, and the owner/status filter runs afterwards.
    const indexed = createDb(
      withParams(url ?? '', {
        enable_seqscan: 'off',
        enable_sort: 'off',
        'hnsw.ef_search': '2',
      }),
    );
    try {
      const indexedRepo = createDrizzleRepository(indexed.db);
      const o = freshOwner();
      const query = hashEmbed('needle haystack', EMBEDDING_DIMENSIONS);

      // The nearest chunks (three of the query's words) belong to a document
      // that is not ready, so a single post-filtered pass finds none.
      const { document: hidden } = await r.createDocument(newDoc(o, 'hidden.txt'));
      await r.completeIngestion(
        hidden.id,
        'hidden',
        Array.from({ length: 6 }, (_, i) =>
          chunkOf(`hidden ${i}`, i, hashEmbed(`needle haystack hidden${i}`, EMBEDDING_DIMENSIONS)),
        ),
      );
      await r.markProcessing(hidden.id);

      // Farther from the query (two of four words shared), but ready.
      const { document: visible } = await r.createDocument(newDoc(o, 'visible.txt'));
      await r.completeIngestion(
        visible.id,
        'visible',
        Array.from({ length: 4 }, (_, i) =>
          chunkOf(
            `visible ${i}`,
            i,
            hashEmbed(`needle haystack visible${i} extra${i}`, EMBEDDING_DIMENSIONS),
          ),
        ),
      );

      const found = await indexedRepo.search(o, query, 3);
      expect(found).toHaveLength(3);
      expect(found.every((c) => c.documentId === visible.id)).toBe(true);
      const sims = found.map((c) => c.similarity);
      expect([...sims].sort((x, y) => y - x)).toEqual(sims);
    } finally {
      await indexed.close();
    }
  });
});
