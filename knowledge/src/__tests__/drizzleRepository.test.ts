import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleRepository } from '../db/api/drizzleRepository.js';
import type { KnowledgeRepository, NewChunk, NewDocument } from '../db/api/repository.js';
import { createDb, type DbHandle } from '../db/index.js';
import { chunks, corpusState, documents, EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { deleteDocument, uploadDocument } from '../services/documents.js';
import { createHashingEmbedder, hashEmbed } from '../services/embedding/hashing.js';
import { createIngestionQueue, type IngestionQueue } from '../services/ingestion/pipeline.js';
import { retrieve } from '../services/retrieval.js';
import {
  createMemoryFileStore,
  makePdf,
  PROJECT_NOTES_TXT,
  RESUME_MD,
  silentLogger,
  utf8,
} from './support/fixtures.js';

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
 * Every row is written under random owner ids and removed afterwards, so it
 * is safe to run against a development database.
 */
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
if (process.env.CI && !url) {
  throw new Error(
    'KNOWLEDGE_TEST_DATABASE_URL must be set in CI; the Postgres suite would be skipped.',
  );
}

/** The same URL with connection parameters set at startup (postgres.js passes unknown ones on). */
function withParams(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u.toString();
}

describe.skipIf(!url)('Drizzle repository (Postgres + pgvector)', () => {
  const owner = `test-${randomUUID()}`;
  const owners = [owner];
  const freshOwner = () => {
    const id = `test-${randomUUID()}`;
    owners.push(id);
    return id;
  };
  const embedder = createHashingEmbedder(EMBEDDING_DIMENSIONS);
  const files = createMemoryFileStore();
  let handle: DbHandle;
  let repo: KnowledgeRepository;
  let queue: IngestionQueue;
  let deps: Parameters<typeof uploadDocument>[0];

  beforeAll(() => {
    handle = createDb(url ?? '');
    repo = createDrizzleRepository(handle.db);
    queue = createIngestionQueue({ repo, files, embedder }, silentLogger);
    deps = { repo, files, queue, log: silentLogger };
  });

  afterAll(async () => {
    if (!handle) return;
    await queue.idle();
    await handle.db.delete(documents).where(inArray(documents.ownerId, owners));
    await handle.db.delete(corpusState).where(inArray(corpusState.ownerId, owners));
    await handle.close();
  });

  const upload = (
    filename: string,
    bytes: Uint8Array,
    kind: 'resume' | 'supporting' = 'supporting',
    ownerId = owner,
  ) => uploadDocument(deps, { ownerId, filename, bytes, kind });

  const newDoc = (ownerId: string, name: string): NewDocument => ({
    ownerId,
    filename: name,
    mimeType: 'text/plain',
    sizeBytes: 1,
    sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    storagePath: `${ownerId}/${name}`,
    kind: 'supporting',
  });

  const chunkOf = (
    text: string,
    ordinal: number,
    embedding = hashEmbed(text, EMBEDDING_DIMENSIONS),
  ): NewChunk => ({
    ordinal,
    heading: null,
    content: text,
    tokenCount: 1,
    embedding,
  });

  it('ingests md, txt and pdf, and retrieves by vector similarity', async () => {
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    await upload('project.txt', utf8(PROJECT_NOTES_TXT));
    await upload('cert.pdf', makePdf(['Certified Kubernetes Administrator, 2023']));
    await queue.idle();

    const docs = await repo.listDocuments(owner);
    expect(docs.map((d) => [d.filename, d.status])).toEqual(
      expect.arrayContaining([
        ['resume.md', 'ready'],
        ['project.txt', 'ready'],
        ['cert.pdf', 'ready'],
      ]),
    );
    expect(await repo.getVersion(owner)).toBe(3);

    const result = await retrieve(
      { repo, embedder },
      owner,
      'Kubernetes administrator certification',
      2,
    );
    expect(result.version).toBe(3);
    expect(result.chunks[0]?.filename).toBe('cert.pdf');
    expect(result.chunks[0]?.similarity).toBeGreaterThan(result.chunks[1]?.similarity ?? 1);
  });

  it('enforces one primary resume per owner', async () => {
    const second = await upload('resume-v2.md', utf8(`${RESUME_MD}\nUpdated.`), 'resume');
    const primaries = (await repo.listDocuments(owner)).filter((d) => d.isPrimaryResume);
    expect(primaries.map((d) => d.id)).toEqual([second.document.id]);
    await queue.idle();
  });

  it('deduplicates identical bytes through the unique index without demoting the primary', async () => {
    const primaryBefore = (await repo.listDocuments(owner)).find((d) => d.isPrimaryResume);
    const again = await upload('copy.md', utf8(RESUME_MD), 'resume');
    expect(again.deduplicated).toBe(true);
    const docs = await repo.listDocuments(owner);
    expect(docs.filter((d) => d.filename === 'copy.md')).toHaveLength(0);
    expect(docs.find((d) => d.isPrimaryResume)?.id).toBe(primaryBefore?.id);
  });

  it('does not return chunks of another owner', async () => {
    const other = await retrieve({ repo, embedder }, `nobody-${randomUUID()}`, 'Kafka', 5);
    expect(other).toEqual({ version: 0, chunks: [] });
  });

  it('cascades chunk deletion and bumps the version', async () => {
    const before = await repo.getVersion(owner);
    const cert = (await repo.listDocuments(owner)).find((d) => d.filename === 'cert.pdf');
    if (!cert) throw new Error('cert.pdf was not ingested');
    expect(await deleteDocument(deps, owner, cert.id)).toBe(true);
    expect(await repo.getVersion(owner)).toBe(before + 1);

    const remaining = await handle.db
      .select({ id: chunks.id })
      .from(chunks)
      .where(inArray(chunks.documentId, [cert.id]));
    expect(remaining).toHaveLength(0);
  });

  it('lists unfinished documents for the boot re-queue', async () => {
    const { document: pending, created } = await repo.createDocument(newDoc(owner, 'pending.txt'));
    expect(created).toBe(true);
    const unfinished = await repo.listUnfinished();
    expect(unfinished.map((d) => d.id)).toContain(pending.id);
  });

  it('bumps the version exactly once per concurrent completeIngestion', async () => {
    const o = freshOwner();
    const [a, b] = await Promise.all([
      repo.createDocument(newDoc(o, 'a.txt')),
      repo.createDocument(newDoc(o, 'b.txt')),
    ]);
    await Promise.all([
      repo.completeIngestion(a.document.id, 'a', [chunkOf('alpha', 0)]),
      repo.completeIngestion(b.document.id, 'b', [chunkOf('bravo', 0)]),
    ]);
    expect(await repo.getVersion(o)).toBe(2);
  });

  it('handles concurrent primary-resume uploads without a 500', async () => {
    const o = freshOwner();
    const results = await Promise.all([
      upload('r1.md', utf8('# Resume one'), 'resume', o),
      upload('r2.md', utf8('# Resume two'), 'resume', o),
      upload('r3.md', utf8('# Resume three'), 'resume', o),
      // Identical bytes racing each other: one is created, the other deduplicated.
      upload('r4.md', utf8('# Resume four'), 'resume', o),
      upload('r4-copy.md', utf8('# Resume four'), 'resume', o),
    ]);
    expect(results.filter((r) => r.deduplicated)).toHaveLength(1);
    const docs = await repo.listDocuments(o);
    expect(docs).toHaveLength(4);
    expect(docs.filter((d) => d.isPrimaryResume)).toHaveLength(1);
    await queue.idle();
  });

  it('bumps the version when a ready document stops being served', async () => {
    const o = freshOwner();
    const { document } = await repo.createDocument(newDoc(o, 'served.txt'));
    await repo.completeIngestion(document.id, 'x', [chunkOf('served text', 0)]);
    expect(await repo.getVersion(o)).toBe(1);
    await repo.markProcessing(document.id);
    expect(await repo.getVersion(o)).toBe(2);
    await repo.failIngestion(document.id, 'failed');
    expect(await repo.getVersion(o)).toBe(2); // already out of the corpus
  });

  it('returns k ready rows when a non-ready document holds the nearest chunks', async () => {
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
      const { document: hidden } = await repo.createDocument(newDoc(o, 'hidden.txt'));
      await repo.completeIngestion(
        hidden.id,
        'hidden',
        Array.from({ length: 6 }, (_, i) =>
          chunkOf(`hidden ${i}`, i, hashEmbed(`needle haystack hidden${i}`, EMBEDDING_DIMENSIONS)),
        ),
      );
      await repo.markProcessing(hidden.id);

      // Farther from the query (two of four words shared), but ready.
      const { document: visible } = await repo.createDocument(newDoc(o, 'visible.txt'));
      await repo.completeIngestion(
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
