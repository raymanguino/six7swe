import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { DocumentRecord } from '../db/api/repository.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import { ingestDocument } from '../services/ingestion/pipeline.js';
import { SerialQueue } from '../services/ingestion/queue.js';
import {
  createMemoryFileStore,
  multipartFile,
  PROJECT_NOTES_TXT,
  RESUME_MD,
  silentLogger,
  utf8,
} from './support/fixtures.js';
import { createMemoryRepository } from './support/memoryRepository.js';

const KEY = 'k'.repeat(40);
const auth = { 'x-knowledge-key': KEY };

let app: FastifyInstance;
let queue: SerialQueue<DocumentRecord>;

beforeEach(async () => {
  const repo = createMemoryRepository();
  const files = createMemoryFileStore();
  const embedder = createHashingEmbedder(256);
  queue = new SerialQueue((doc) =>
    ingestDocument({ repo, files, embedder, log: silentLogger }, doc),
  );
  app = await buildApp({
    serviceKey: KEY,
    logger: false,
    context: { repo, files, embedder, queue, ownerId: 'owner', maxUploadBytes: 2048 },
  });
});

afterEach(async () => {
  await queue.idle();
  await app.close();
});

async function uploadFile(name: string, text: string, kind?: string) {
  const { payload, headers } = multipartFile(name, utf8(text));
  return app.inject({
    method: 'POST',
    url: kind ? `/documents?kind=${kind}` : '/documents',
    payload,
    headers: { ...headers, ...auth },
  });
}

describe('auth', () => {
  it('serves /health without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects requests with a missing or wrong key', async () => {
    expect((await app.inject({ method: 'GET', url: '/version' })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/version',
      headers: { 'x-knowledge-key': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('ignores a key passed in the query string', async () => {
    const res = await app.inject({ method: 'GET', url: `/version?key=${KEY}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('documents and retrieval', () => {
  it('uploads, ingests, lists and retrieves', async () => {
    const res = await uploadFile('resume.md', RESUME_MD, 'resume');
    expect(res.statusCode).toBe(202);
    const body = res.json<{ document: Record<string, unknown>; deduplicated: boolean }>();
    expect(body.deduplicated).toBe(false);
    expect(body.document).toMatchObject({
      filename: 'resume.md',
      kind: 'resume',
      status: 'pending',
    });
    expect(body.document).not.toHaveProperty('storagePath');
    expect(body.document).not.toHaveProperty('ownerId');

    await uploadFile('project.txt', PROJECT_NOTES_TXT);
    await queue.idle();

    const list = await app.inject({ method: 'GET', url: '/documents', headers: auth });
    expect(list.json<{ documents: { status: string }[] }>().documents.map((d) => d.status)).toEqual(
      ['ready', 'ready'],
    );

    const version = await app.inject({ method: 'GET', url: '/version', headers: auth });
    expect(version.json()).toEqual({ version: 2 });

    const retrieved = await app.inject({
      method: 'POST',
      url: '/retrieve',
      headers: auth,
      payload: { query: 'pgvector retrieval assistant', k: 1 },
    });
    expect(retrieved.statusCode).toBe(200);
    const result = retrieved.json<{ version: number; chunks: { filename: string }[] }>();
    expect(result.version).toBe(2);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.filename).toBe('project.txt');
  });

  it('returns 200 with deduplicated=true for identical bytes', async () => {
    await uploadFile('a.md', RESUME_MD);
    const again = await uploadFile('a.md', RESUME_MD);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ deduplicated: true });
  });

  it('rejects unsupported types with 415 and oversized files with 413', async () => {
    expect((await uploadFile('a.docx', 'x')).statusCode).toBe(415);
    expect((await uploadFile('big.txt', 'x'.repeat(4096))).statusCode).toBe(413);
  });

  it('rejects a bad kind and a non-multipart body with 4xx', async () => {
    expect((await uploadFile('a.md', '# a', 'cover-letter')).statusCode).toBe(400);
    const json = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: auth,
      payload: { not: 'multipart' },
    });
    expect(json.statusCode).toBeGreaterThanOrEqual(400);
    expect(json.statusCode).toBeLessThan(500);
  });

  it('validates the retrieve body', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/retrieve',
      headers: auth,
      payload: { query: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    const tooMany = await app.inject({
      method: 'POST',
      url: '/retrieve',
      headers: auth,
      payload: { query: 'x', k: 500 },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('gets and deletes a document, 404 afterwards and for bad ids', async () => {
    const { document } = (await uploadFile('a.md', RESUME_MD)).json<{ document: { id: string } }>();
    await queue.idle();

    const got = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: auth,
    });
    expect(got.json()).toMatchObject({ document: { id: document.id, status: 'ready' } });

    const del = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(404);

    const bad = await app.inject({ method: 'GET', url: '/documents/not-a-uuid', headers: auth });
    expect(bad.statusCode).toBe(400);
  });
});
