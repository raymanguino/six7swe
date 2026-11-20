import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import {
  createMemoryFileStore,
  makePdf,
  multipartFile,
  RESUME_MD,
  utf8,
} from './support/fixtures.js';
import { createMemoryEvalRepository } from './support/memoryEvalRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';

const KEY = 'k'.repeat(40);
const OWNER_KEY = 'o'.repeat(40);
const serviceAuth = { 'x-knowledge-key': KEY };
const ownerAuth = { 'x-knowledge-key': OWNER_KEY };

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (!app) return;
  await app.ingestionQueue.idle();
  await app.evalRunner.idle();
  await app.evalSet.idle();
  await app.close();
  app = undefined;
});

async function start() {
  const built = await buildApp({
    deps: {
      repo: createMemoryRepository(),
      files: createMemoryFileStore(),
      embedder: createHashingEmbedder(256),
    },
    evaluation: { repo: createMemoryEvalRepository(), answerer: null },
    serviceKey: KEY,
    ownerKey: OWNER_KEY,
    ownerId: 'owner',
    maxUploadBytes: 4096,
    logger: false,
  });
  app = built;
  const upload = async (name: string, bytes: Uint8Array, kind: 'resume' | 'supporting') => {
    const { payload, headers } = multipartFile(name, bytes);
    const res = await built.inject({
      method: 'POST',
      url: `/documents?kind=${kind}`,
      payload,
      headers: { ...headers, ...ownerAuth },
    });
    expect(res.statusCode).toBe(202);
    await built.ingestionQueue.idle();
    return res.json<{ document: { id: string } }>().document;
  };
  const get = async (url: string, headers: Record<string, string>) =>
    (await built.inject({ method: 'GET', url, headers })).statusCode;
  return { app: built, upload, get };
}

/** `GET /resume.pdf` (service): the primary resume the backend serves as `/resume`. */
describe('primary resume PDF', () => {
  it('is a service route: the owner key is refused', async () => {
    const { get } = await start();
    expect(await get('/resume.pdf', ownerAuth)).toBe(401);
  });

  it('serves the primary resume when it is a PDF', async () => {
    const { app: a, upload } = await start();
    const pdf = makePdf(['Jordan Example', 'Senior software engineer']);
    await upload('jordan.pdf', pdf, 'resume');

    const file = await a.inject({ method: 'GET', url: '/resume.pdf', headers: serviceAuth });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(new Uint8Array(file.rawPayload)).toEqual(pdf);
  });

  it('answers 404 when there is no primary resume, or it is not a PDF', async () => {
    const { get, upload } = await start();
    expect(await get('/resume.pdf', serviceAuth)).toBe(404);
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    expect(await get('/resume.pdf', serviceAuth)).toBe(404);
  });

  it('has no profile routes any more', async () => {
    const { app: a } = await start();
    for (const [method, url] of [
      ['GET', '/profile'],
      ['GET', '/profile/published'],
      ['POST', '/profile/publish'],
      ['POST', '/profile/draft'],
    ] as const) {
      expect((await a.inject({ method, url, headers: serviceAuth })).statusCode).toBe(404);
    }
  });
});
