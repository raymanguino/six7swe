import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleRepository } from '../db/api/drizzleRepository.js';
import type { DocumentRecord, KnowledgeRepository } from '../db/api/repository.js';
import { createDb, type DbHandle } from '../db/index.js';
import { chunks, corpusState, documents, EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { deleteDocument, uploadDocument } from '../services/documents.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import { ingestDocument } from '../services/ingestion/pipeline.js';
import { SerialQueue } from '../services/ingestion/queue.js';
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
 * Runs the Drizzle repository against a real Postgres with pgvector.
 *
 * Skipped unless KNOWLEDGE_TEST_DATABASE_URL points at a database where
 * `db:migrate` has been applied, e.g. the local Supabase stack:
 *
 *   KNOWLEDGE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     pnpm --filter @six7swe/knowledge test
 *
 * Every row is written under a random owner id and removed afterwards, so
 * it is safe to run against a development database.
 */
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;

describe.skipIf(!url)('Drizzle repository (Postgres + pgvector)', () => {
  const owner = `test-${randomUUID()}`;
  const embedder = createHashingEmbedder(EMBEDDING_DIMENSIONS);
  const files = createMemoryFileStore();
  let handle: DbHandle;
  let repo: KnowledgeRepository;
  let queue: SerialQueue<DocumentRecord>;
  let deps: Parameters<typeof uploadDocument>[0];

  beforeAll(() => {
    handle = createDb(url as string);
    repo = createDrizzleRepository(handle.db);
    queue = new SerialQueue((doc) =>
      ingestDocument({ repo, files, embedder, log: silentLogger }, doc),
    );
    deps = { repo, files, queue, log: silentLogger };
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(documents).where(eq(documents.ownerId, owner));
    await handle.db.delete(corpusState).where(eq(corpusState.ownerId, owner));
    await handle.close();
  });

  const upload = (
    filename: string,
    bytes: Uint8Array,
    kind: 'resume' | 'supporting' = 'supporting',
  ) => uploadDocument(deps, { ownerId: owner, filename, bytes, kind });

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

  it('deduplicates identical bytes through the unique index', async () => {
    const again = await upload('copy.md', utf8(RESUME_MD));
    expect(again.deduplicated).toBe(true);
    expect((await repo.listDocuments(owner)).filter((d) => d.filename === 'copy.md')).toHaveLength(
      0,
    );
  });

  it('does not return chunks of another owner', async () => {
    const other = await retrieve({ repo, embedder }, `nobody-${randomUUID()}`, 'Kafka', 5);
    expect(other).toEqual({ version: 0, chunks: [] });
  });

  it('cascades chunk deletion and bumps the version', async () => {
    const before = await repo.getVersion(owner);
    const cert = (await repo.listDocuments(owner)).find((d) => d.filename === 'cert.pdf');
    expect(cert).toBeDefined();
    const result = await deleteDocument(deps, owner, cert?.id as string);
    expect(result).toEqual({ deleted: true, version: before + 1 });

    const remaining = await handle.db
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.documentId, cert?.id as string));
    expect(remaining).toHaveLength(0);
  });

  it('lists unfinished documents for the boot re-queue', async () => {
    const pending = await repo.createDocument({
      ownerId: owner,
      filename: 'pending.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      sha256: 'f'.repeat(64),
      storagePath: `${owner}/pending.txt`,
      kind: 'supporting',
    });
    const unfinished = await repo.listUnfinished();
    expect(unfinished.map((d) => d.id)).toContain(pending.id);
  });
});
