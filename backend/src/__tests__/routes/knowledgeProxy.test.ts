import Fastify, { FastifyInstance } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { loadKnowledgeConfig, type KnowledgeConfig } from '../../config/knowledge';
import { UnauthenticatedUser } from '../../constants';
import { registerKnowledgeRoutes } from '../../routes/knowledge';
import { isKnowledgeOwner } from '../../services/knowledge/ownerGate';
import {
  DEFAULT_TIMEOUT_MS,
  forwardToKnowledge,
  UPLOAD_TIMEOUT_MS,
} from '../../services/knowledge/ownerProxy';
import type { FetchLike } from '../../services/knowledge/transport';
import { SERVICE_KEY_HEADER } from '@six7swe/knowledge-types';
import type { ContextUser } from '../../types';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_KEY = 'o'.repeat(40);
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_URL = 'http://knowledge.internal:3100';

const owner: ContextUser = { id: 1, email: 'owner@example.com', authId: OWNER_ID };
const stranger: ContextUser = { id: 2, email: 'owner@example.com', authId: 'someone-else' };

const configured: KnowledgeConfig = {
  ownerAuthId: OWNER_ID,
  target: { url: SERVICE_URL, ownerKey: OWNER_KEY },
};

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

/** A fake knowledge service that records every call. */
function fakeService(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

/**
 * Mirrors the real server's wiring: the request context, an auth hook that
 * sets the user, and the private-by-default guard, then the knowledge routes.
 */
async function buildServer(options: {
  user: ContextUser;
  config?: KnowledgeConfig;
  fetch: FetchLike;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyRequestContext, { defaultStoreValues: { user: UnauthenticatedUser } });
  app.addHook('onRequest', async () => {
    requestContext.set('user', options.user);
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.routeOptions.config.public === true) return;
    const user = requestContext.get('user');
    if (!user || user === UnauthenticatedUser) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  await app.register(async (scope) =>
    registerKnowledgeRoutes(scope, {
      config: options.config ?? configured,
      fetch: options.fetch,
    }),
  );
  await app.ready();
  return app;
}

function multipart(text: string): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----proxy-test-boundary';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n` +
      `Content-Type: text/markdown\r\n\r\n${text}\r\n--${boundary}--\r\n`,
  );
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('isKnowledgeOwner', () => {
  it('matches on the verified subject only', () => {
    expect(isKnowledgeOwner(owner, OWNER_ID)).toBe(true);
    // Same email, different subject: not the owner.
    expect(isKnowledgeOwner(stranger, OWNER_ID)).toBe(false);
    expect(isKnowledgeOwner({ id: 3, email: null }, OWNER_ID)).toBe(false);
    expect(isKnowledgeOwner(UnauthenticatedUser, OWNER_ID)).toBe(false);
    expect(isKnowledgeOwner(undefined, OWNER_ID)).toBe(false);
  });

  it('fails closed without OWNER_AUTH_ID', () => {
    expect(isKnowledgeOwner(owner, null)).toBe(false);
  });
});

describe('loadKnowledgeConfig', () => {
  it('treats missing and blank values as unset', () => {
    expect(loadKnowledgeConfig({})).toEqual({ ownerAuthId: null, target: null });
    expect(
      loadKnowledgeConfig({ OWNER_AUTH_ID: ' ', KNOWLEDGE_URL: '', KNOWLEDGE_OWNER_KEY: '' }),
    ).toEqual({ ownerAuthId: null, target: null });
  });

  it('leaves the proxy off when only the URL is set (chat retrieval shares it)', () => {
    expect(
      loadKnowledgeConfig({ OWNER_AUTH_ID: OWNER_ID, KNOWLEDGE_URL: `${SERVICE_URL}/` }),
    ).toEqual({ ownerAuthId: OWNER_ID, target: null });
  });

  it('needs the URL when the key is set, and trims a trailing slash', () => {
    expect(() => loadKnowledgeConfig({ KNOWLEDGE_OWNER_KEY: OWNER_KEY })).toThrow(
      /KNOWLEDGE_URL: KNOWLEDGE_URL is required when KNOWLEDGE_OWNER_KEY is set/,
    );
    expect(loadKnowledgeConfig({ OWNER_AUTH_ID: OWNER_ID })).toEqual({
      ownerAuthId: OWNER_ID,
      target: null,
    });
    expect(
      loadKnowledgeConfig({ KNOWLEDGE_URL: `${SERVICE_URL}/`, KNOWLEDGE_OWNER_KEY: OWNER_KEY })
        .target,
    ).toEqual({ url: SERVICE_URL, ownerKey: OWNER_KEY });
  });

  it('rejects a URL with credentials without echoing it', () => {
    const load = () =>
      loadKnowledgeConfig({
        KNOWLEDGE_URL: 'http://user:secret-pw@knowledge:3100',
        KNOWLEDGE_OWNER_KEY: OWNER_KEY,
      });
    expect(load).toThrow(/KNOWLEDGE_URL must be an http\(s\) URL without credentials/);
    expect(load).not.toThrow(/secret-pw/);
  });

  it('rejects a URL with a query or fragment', () => {
    for (const KNOWLEDGE_URL of [
      'http://knowledge:3100/base?x=1',
      'http://knowledge:3100/base#f',
      'http://knowledge:3100/base?',
    ]) {
      const load = () => loadKnowledgeConfig({ KNOWLEDGE_URL, KNOWLEDGE_OWNER_KEY: OWNER_KEY });
      expect(load).toThrow(
        /KNOWLEDGE_URL must be an http\(s\) URL without credentials, query or fragment/,
      );
    }
  });

  it('rejects malformed values without echoing them', () => {
    const load = () =>
      loadKnowledgeConfig({ KNOWLEDGE_URL: 'ftp://x', KNOWLEDGE_OWNER_KEY: 'short-secret' });
    expect(load).toThrow(/KNOWLEDGE_URL/);
    expect(load).toThrow(/KNOWLEDGE_OWNER_KEY must be at least 32 characters/);
    expect(load).not.toThrow(/short-secret/);
  });
});

describe('knowledge owner proxy routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers 401 without a user and 403 for a signed-in non-owner, never calling the service', async () => {
    const service = fakeService(() => jsonResponse(200, { documents: [] }));

    app = await buildServer({ user: UnauthenticatedUser, fetch: service.fetch });
    expect((await app.inject({ method: 'GET', url: '/knowledge/documents' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/knowledge/access' })).statusCode).toBe(401);
    await app.close();

    app = await buildServer({ user: stranger, fetch: service.fetch });
    const routes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }> = [
      { method: 'GET', url: '/knowledge/documents' },
      { method: 'GET', url: `/knowledge/documents/${DOC_ID}` },
      { method: 'GET', url: `/knowledge/documents/${DOC_ID}/text` },
      { method: 'PUT', url: `/knowledge/documents/${DOC_ID}/primary` },
      { method: 'DELETE', url: `/knowledge/documents/${DOC_ID}` },
    ];
    for (const route of routes) {
      const res = await app.inject(route);
      expect({ ...route, status: res.statusCode }).toEqual({ ...route, status: 403 });
    }
    const search = await app.inject({
      method: 'POST',
      url: '/knowledge/search',
      payload: { query: 'kafka' },
    });
    expect(search.statusCode).toBe(403);
    const upload = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      ...multipart('# Resume'),
    });
    expect(upload.statusCode).toBe(403);
    expect(service.calls).toHaveLength(0);

    const access = await app.inject({ method: 'GET', url: '/knowledge/access' });
    expect(access.json()).toEqual({ isOwner: false });
  });

  it('tells the owner they are the owner', async () => {
    const service = fakeService(() => jsonResponse(200, {}));
    app = await buildServer({ user: owner, fetch: service.fetch });
    const access = await app.inject({ method: 'GET', url: '/knowledge/access' });
    expect(access.json()).toEqual({ isOwner: true });
  });

  it('forwards owner requests with the owner key and never the user token', async () => {
    const service = fakeService(() => jsonResponse(200, { documents: [] }));
    app = await buildServer({ user: owner, fetch: service.fetch });

    const res = await app.inject({
      method: 'GET',
      url: '/knowledge/documents',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documents: [] });
    expect(service.calls).toHaveLength(1);
    const [call] = service.calls;
    expect(call?.url).toBe(`${SERVICE_URL}/documents`);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers[SERVICE_KEY_HEADER]).toBe(OWNER_KEY);
    expect(headers).not.toHaveProperty('authorization');
  });

  it('maps each owner route to its service path', async () => {
    const service = fakeService(({ init }) =>
      init.method === 'DELETE' ? jsonResponse(204) : jsonResponse(200, { ok: true }),
    );
    app = await buildServer({ user: owner, fetch: service.fetch });

    const del = await app.inject({ method: 'DELETE', url: `/knowledge/documents/${DOC_ID}` });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    await app.inject({ method: 'GET', url: `/knowledge/documents/${DOC_ID}` });
    await app.inject({ method: 'GET', url: `/knowledge/documents/${DOC_ID}/text` });
    await app.inject({ method: 'PUT', url: `/knowledge/documents/${DOC_ID}/primary` });
    const search = await app.inject({
      method: 'POST',
      url: '/knowledge/search',
      payload: { query: 'kafka', k: 3 },
    });
    expect(search.statusCode).toBe(200);

    expect(service.calls.map((c) => `${c.init.method} ${c.url.slice(SERVICE_URL.length)}`)).toEqual(
      [
        `DELETE /documents/${DOC_ID}`,
        `GET /documents/${DOC_ID}`,
        `GET /documents/${DOC_ID}/text`,
        `PUT /documents/${DOC_ID}/primary`,
        'POST /search',
      ],
    );
    const searchCall = service.calls[4];
    expect(JSON.parse(String(searchCall?.init.body))).toEqual({ query: 'kafka', k: 3 });
    expect((searchCall?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('relays an upload byte for byte, with the kind', async () => {
    const service = fakeService(() =>
      jsonResponse(202, { document: { id: DOC_ID }, deduplicated: false }),
    );
    app = await buildServer({ user: owner, fetch: service.fetch });
    const { payload, headers } = multipart('# Resume\n\nKafka.');

    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/documents?kind=resume',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ document: { id: DOC_ID }, deduplicated: false });
    const [call] = service.calls;
    expect(call?.url).toBe(`${SERVICE_URL}/documents?kind=resume`);
    expect(Buffer.from(call?.init.body as Uint8Array).equals(payload)).toBe(true);
    expect((call?.init.headers as Record<string, string>)['content-type']).toBe(
      headers['content-type'],
    );
  });

  it('validates ids, kinds and the upload type before calling the service', async () => {
    const service = fakeService(() => jsonResponse(200, {}));
    app = await buildServer({ user: owner, fetch: service.fetch });

    const badId = await app.inject({ method: 'GET', url: '/knowledge/documents/..%2Fversion' });
    expect(badId.statusCode).toBe(400);
    const badKind = await app.inject({
      method: 'POST',
      url: '/knowledge/documents?kind=cover-letter',
      ...multipart('x'),
    });
    expect(badKind.statusCode).toBe(400);
    const json = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      payload: { not: 'multipart' },
    });
    expect(json.statusCode).toBe(415);
    expect(service.calls).toHaveLength(0);
  });

  it('passes 4xx answers through and hides service failures', async () => {
    let next: () => Response = () => jsonResponse(404, { error: 'Document not found' });
    const service = fakeService(() => next());
    app = await buildServer({ user: owner, fetch: service.fetch });
    const get = () => app!.inject({ method: 'GET', url: `/knowledge/documents/${DOC_ID}` });

    const notFound = await get();
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: 'Document not found' });

    // A rejected key is the backend's fault, not an expired session.
    next = () => jsonResponse(401, { error: 'Unauthorized' });
    expect((await get()).statusCode).toBe(502);

    next = () => jsonResponse(500, { error: 'Internal Server Error', stack: 'secret' });
    const failed = await get();
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('secret');

    next = () => {
      throw new TypeError('fetch failed');
    };
    expect((await get()).statusCode).toBe(502);

    // A 200 without a JSON body is a broken answer, not an empty success.
    next = () => new Response('', { status: 200 });
    expect((await get()).statusCode).toBe(502);
    next = () => new Response('<html>', { status: 200 });
    expect((await get()).statusCode).toBe(502);
    next = () => new Response('null', { status: 200 });
    expect((await get()).statusCode).toBe(502);
  });

  it('validates the search body before calling the service', async () => {
    const service = fakeService(() => jsonResponse(200, { version: 1, chunks: [] }));
    app = await buildServer({ user: owner, fetch: service.fetch });
    const search = (payload: Record<string, unknown>) =>
      app!.inject({ method: 'POST', url: '/knowledge/search', payload });

    expect((await search({ query: '  ' })).statusCode).toBe(400);
    expect((await search({ query: 'x', k: 50 })).statusCode).toBe(400);
    expect((await search({ query: 'x', extra: true })).statusCode).toBe(400);
    expect(service.calls).toHaveLength(0);

    expect((await search({ query: ' kafka ' })).statusCode).toBe(200);
    expect(JSON.parse(String(service.calls[0]?.init.body))).toEqual({ query: 'kafka' });
  });

  it('answers 503 to the owner when the service is not configured', async () => {
    const service = fakeService(() => jsonResponse(200, {}));
    app = await buildServer({
      user: owner,
      config: { ownerAuthId: OWNER_ID, target: null },
      fetch: service.fetch,
    });
    expect((await app.inject({ method: 'GET', url: '/knowledge/documents' })).statusCode).toBe(503);
    expect(service.calls).toHaveLength(0);
  });
});

describe('forwardToKnowledge', () => {
  it('reports a timeout as 504', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const result = await forwardToKnowledge(
      { url: SERVICE_URL, ownerKey: OWNER_KEY },
      { method: 'GET', path: '/documents' },
      { fetch, timeoutMs: 10 },
    );
    expect(result.status).toBe(504);
  });

  it('maps a connection dropped while reading the body to 502 and reports it', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"documents":'));
        controller.error(new TypeError('terminated'));
      },
    });
    const failures: string[] = [];
    const result = await forwardToKnowledge(
      { url: SERVICE_URL, ownerKey: OWNER_KEY },
      { method: 'GET', path: '/documents' },
      {
        fetch: async () => new Response(body, { status: 200 }),
        onFailure: (message) => failures.push(message),
      },
    );
    expect(result.status).toBe(502);
    expect(failures).toEqual(['Knowledge service request failed']);
  });

  it('gives uploads a longer timeout than the JSON routes', () => {
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});
