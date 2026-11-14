import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import {
  DocumentDtoSchema,
  DocumentTextResponseSchema,
  ErrorResponseSchema,
  RetrieveResponseSchema,
  UploadResponseSchema,
} from '../contract.js';
import { ConflictError } from '../db/api/repository.js';
import type { Authenticators } from '../plugins/serviceAuth.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import {
  createMemoryFileStore,
  multipartFile,
  PROJECT_NOTES_TXT,
  RESUME_MD,
  utf8,
} from './support/fixtures.js';
import { createMemoryRepository } from './support/memoryRepository.js';

const KEY = 'k'.repeat(40);
const OWNER_KEY = 'o'.repeat(40);
/** The service key, for service routes (`/retrieve`, `/version`). */
const auth = { 'x-knowledge-key': KEY };
/** The owner key, for owner routes (`/documents`). */
const ownerAuth = { 'x-knowledge-key': OWNER_KEY };

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({
    deps: {
      repo: createMemoryRepository(),
      files: createMemoryFileStore(),
      embedder: createHashingEmbedder(256),
    },
    serviceKey: KEY,
    ownerKey: OWNER_KEY,
    ownerId: 'owner',
    maxUploadBytes: 2048,
    logger: false,
  });
});

afterEach(async () => {
  await app.ingestionQueue.idle();
  await app.close();
});

const idle = () => app.ingestionQueue.idle();

async function uploadFile(name: string, text: string, kind?: string) {
  const { payload, headers } = multipartFile(name, utf8(text));
  return app.inject({
    method: 'POST',
    url: kind ? `/documents?kind=${kind}` : '/documents',
    payload,
    headers: { ...headers, ...ownerAuth },
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

  it('opens owner routes with the owner key only', async () => {
    const status = async (headers?: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: '/documents', headers })).statusCode;
    expect(await status()).toBe(401);
    expect(await status(ownerAuth)).toBe(200);
    // The shared service key cannot upload, list or delete.
    expect(await status(auth)).toBe(401);
  });

  it('opens service routes with the service key only', async () => {
    const status = async (headers?: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: '/version', headers })).statusCode;
    expect(await status(auth)).toBe(200);
    // The owner key is not a service credential either.
    expect(await status(ownerAuth)).toBe(401);
    const retrieve = await app.inject({
      method: 'POST',
      url: '/retrieve',
      headers: ownerAuth,
      payload: { query: 'x' },
    });
    expect(retrieve.statusCode).toBe(401);
  });

  it('answers an unknown path with 401 without a key and 404 with one, never 500', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(anonymous.statusCode).toBe(401);
    const keyed = await app.inject({ method: 'POST', url: '/no-such-route', headers: auth });
    expect(keyed.statusCode).toBe(404);
  });
});

describe('pluggable authenticators', () => {
  async function appWith(authenticators: Partial<Authenticators>) {
    return buildApp({
      deps: {
        repo: createMemoryRepository(),
        files: createMemoryFileStore(),
        embedder: createHashingEmbedder(256),
      },
      serviceKey: KEY,
      ownerKey: OWNER_KEY,
      ownerId: 'owner',
      maxUploadBytes: 2048,
      logger: false,
      authenticators,
    });
  }

  it('replaces only the owner check, leaving service routes on the key', async () => {
    const custom = await appWith({
      owner: (req) => (req.headers.authorization === 'Bearer owner-token' ? 'jwt-owner' : null),
    });
    try {
      const owner = { authorization: 'Bearer owner-token' };
      expect(
        (await custom.inject({ method: 'GET', url: '/documents', headers: owner })).statusCode,
      ).toBe(200);
      // The service key no longer opens owner routes...
      expect(
        (await custom.inject({ method: 'GET', url: '/documents', headers: auth })).statusCode,
      ).toBe(401);
      // ...and the owner token does not open service routes.
      expect(
        (await custom.inject({ method: 'GET', url: '/version', headers: owner })).statusCode,
      ).toBe(401);
      expect(
        (await custom.inject({ method: 'GET', url: '/version', headers: auth })).statusCode,
      ).toBe(200);
    } finally {
      await custom.close();
    }
  });

  it('rejects an owner id that is not a safe storage-key segment', async () => {
    const custom = await appWith({ owner: () => '../escape' });
    try {
      expect((await custom.inject({ method: 'GET', url: '/documents' })).statusCode).toBe(401);
    } finally {
      await custom.close();
    }
  });
});

describe('errors', () => {
  it('maps a repository ConflictError to 409', async () => {
    const repo = createMemoryRepository();
    repo.createDocument = () => Promise.reject(new ConflictError('The document conflicts'));
    const conflicted = await buildApp({
      deps: { repo, files: createMemoryFileStore(), embedder: createHashingEmbedder(256) },
      serviceKey: KEY,
      ownerKey: OWNER_KEY,
      ownerId: 'owner',
      maxUploadBytes: 2048,
      logger: false,
    });
    try {
      const { payload, headers } = multipartFile('a.md', utf8('# A'));
      const res = await conflicted.inject({
        method: 'POST',
        url: '/documents',
        payload,
        headers: { ...headers, ...ownerAuth },
      });
      expect(res.statusCode).toBe(409);
      expect(ErrorResponseSchema.parse(res.json())).toEqual({ error: 'The document conflicts' });
    } finally {
      await conflicted.close();
    }
  });
});

describe('documents and retrieval', () => {
  it('uploads, ingests, lists and retrieves', async () => {
    const res = await uploadFile('resume.md', RESUME_MD, 'resume');
    expect(res.statusCode).toBe(202);
    // The response matches the wire contract exactly.
    const body = UploadResponseSchema.strict().parse(res.json());
    expect(DocumentDtoSchema.strict().safeParse(body.document).success).toBe(true);
    expect(body.deduplicated).toBe(false);
    expect(body.document).toMatchObject({
      filename: 'resume.md',
      kind: 'resume',
      status: 'pending',
    });
    expect(body.document).not.toHaveProperty('storagePath');
    expect(body.document).not.toHaveProperty('ownerId');

    await uploadFile('project.txt', PROJECT_NOTES_TXT);
    await idle();

    const list = await app.inject({ method: 'GET', url: '/documents', headers: ownerAuth });
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
    const result = RetrieveResponseSchema.parse(retrieved.json());
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
      headers: ownerAuth,
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

  it('searches as the owner, with the owner key only', async () => {
    await uploadFile('project.txt', PROJECT_NOTES_TXT);
    await idle();

    const search = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/search', headers, payload });
    const res = await search(ownerAuth, { query: 'pgvector retrieval assistant', k: 2 });
    expect(res.statusCode).toBe(200);
    const result = RetrieveResponseSchema.strict().parse(res.json());
    expect(result.chunks[0]?.filename).toBe('project.txt');

    expect((await search(auth, { query: 'pgvector' })).statusCode).toBe(401);
    expect((await search(ownerAuth, { query: ' ' })).statusCode).toBe(400);
  });

  it('serves the extracted text of a document', async () => {
    const { document } = (await uploadFile('notes.txt', PROJECT_NOTES_TXT)).json<{
      document: { id: string };
    }>();
    await idle();
    const url = `/documents/${document.id}/text`;
    const res = await app.inject({ method: 'GET', url, headers: ownerAuth });
    const body = DocumentTextResponseSchema.strict().parse(res.json());
    expect(body.documentId).toBe(document.id);
    expect(body.text).toContain('retrieval-augmented');
    expect((await app.inject({ method: 'GET', url, headers: auth })).statusCode).toBe(401);
    const missing = await app.inject({
      method: 'GET',
      url: `/documents/${randomUUID()}/text`,
      headers: ownerAuth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('sets the primary resume, 409 for a document that is not a ready resume', async () => {
    const old = (await uploadFile('old.md', RESUME_MD, 'resume')).json<{
      document: { id: string };
    }>();
    await idle();
    const newer = (await uploadFile('new.md', `${RESUME_MD}\nMore.`, 'resume')).json<{
      document: { id: string };
    }>();
    const notes = (await uploadFile('notes.txt', PROJECT_NOTES_TXT)).json<{
      document: { id: string };
    }>();
    await idle();

    const setPrimary = (id: string) =>
      app.inject({ method: 'PUT', url: `/documents/${id}/primary`, headers: ownerAuth });
    const res = await setPrimary(old.document.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ document: { id: old.document.id, isPrimaryResume: true } });

    const list = await app.inject({ method: 'GET', url: '/documents', headers: ownerAuth });
    const primaries = list
      .json<{ documents: { id: string; isPrimaryResume: boolean }[] }>()
      .documents.filter((d) => d.isPrimaryResume)
      .map((d) => d.id);
    expect(primaries).toEqual([old.document.id]);
    expect(newer.document.id).not.toBe(old.document.id);

    expect((await setPrimary(notes.document.id)).statusCode).toBe(409);
    expect((await setPrimary(randomUUID())).statusCode).toBe(404);
  });

  it('gets and deletes a document, 404 afterwards and for bad ids', async () => {
    const { document } = (await uploadFile('a.md', RESUME_MD)).json<{ document: { id: string } }>();
    await idle();

    const got = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: ownerAuth,
    });
    expect(got.json()).toMatchObject({ document: { id: document.id, status: 'ready' } });

    const del = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: ownerAuth,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: ownerAuth,
    });
    expect(gone.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'GET',
      url: '/documents/not-a-uuid',
      headers: ownerAuth,
    });
    expect(bad.statusCode).toBe(400);
  });
});
