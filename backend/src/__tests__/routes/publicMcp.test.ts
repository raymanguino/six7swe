import fastifyCors from '@fastify/cors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RetrieveResponse } from '@six7swe/knowledge-types';
import Fastify, { FastifyInstance } from 'fastify';
import { DEFAULT_PUBLIC_MCP_CONFIG, getPublicMcpConfig } from '../../config/publicMcp';
import { PUBLIC_MCP_PATH, registerPublicMcpRoutes } from '../../routes/publicMcp';
import type { RecordQuestion } from '../../services/knowledgeRetrieval';
import { createDailyCap } from '../../services/publicMcp/dailyCap';
import {
  DAILY_CAP_ERROR,
  GENERIC_ERROR,
  NO_RESUME_ERROR,
  PUBLIC_MCP_TOOLS,
  RESUME_TOO_LARGE_ERROR,
} from '../../services/publicMcp/server';
import type { ResumeDownload } from '../../services/resumeDownload';

const PDF = Buffer.from('%PDF-1.4 resume');

const CHUNKS: RetrieveResponse = {
  version: 3,
  chunks: Array.from({ length: 10 }, (_, i) => ({
    chunkId: `00000000-0000-4000-8000-00000000000${i}`,
    documentId: '00000000-0000-4000-8000-0000000000aa',
    filename: 'resume.md',
    heading: `Section ${i}`,
    content: `chunk ${i}`,
    similarity: 0.9 - i * 0.01,
  })),
};

type RetrieveFn = (query: string, k: number, record?: RecordQuestion) => Promise<RetrieveResponse>;

interface Harness {
  app: FastifyInstance;
  baseUrl: string;
  retrieve: jest.Mock<ReturnType<RetrieveFn>, Parameters<RetrieveFn>>;
  getResume: jest.Mock<Promise<ResumeDownload>, []>;
  logs: string[];
}

let harness: Harness | null = null;
let clients: Client[] = [];

async function start(
  options: {
    dailySearchCap?: number;
    rateLimitMax?: number;
    configured?: boolean;
    cors?: true | string[];
  } = {},
): Promise<Harness> {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: 'warn',
      stream: { write: (line: string) => void logs.push(line) },
    },
  });
  if (options.cors) {
    await app.register(fastifyCors, { origin: options.cors, credentials: true });
  }
  const retrieve = jest.fn<ReturnType<RetrieveFn>, Parameters<RetrieveFn>>(async () => CHUNKS);
  const getResume = jest.fn<Promise<ResumeDownload>, []>(async () => ({
    found: true,
    body: PDF,
    etag: '"x"',
  }));
  await registerPublicMcpRoutes(app, {
    config: {
      ...DEFAULT_PUBLIC_MCP_CONFIG,
      rateLimitMax: options.rateLimitMax ?? 1000,
    },
    deps: {
      getRetrievalClient: () => (options.configured === false ? null : { retrieve }),
      getResume,
      dailySearchCap: createDailyCap(options.dailySearchCap ?? 1000),
    },
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  harness = { app, baseUrl, retrieve, getResume, logs };
  return harness;
}

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  if (harness) await harness.app.close();
  harness = null;
});

async function connect(h: Harness): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseUrl}${PUBLIC_MCP_PATH}`)),
  );
  clients.push(client);
  return client;
}

/** The first content block of a tool result, as text. */
function text(result: object): string {
  const content = 'content' in result ? result.content : undefined;
  const block: unknown = Array.isArray(content) ? content[0] : undefined;
  if (typeof block !== 'object' || block === null || !('text' in block)) {
    throw new Error('not a text block');
  }
  return String(block.text);
}

const isError = (result: object) => 'isError' in result && result.isError === true;

describe('public MCP endpoint', () => {
  it('lists exactly the two read-only tools', async () => {
    const client = await connect(await start());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...PUBLIC_MCP_TOOLS].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('searches with k 6 by default, recording each call as its own session', async () => {
    const h = await start();
    const client = await connect(h);
    const result = await client.callTool({
      name: 'search_background',
      arguments: { query: 'distributed systems' },
    });
    expect(isError(result)).toBe(false);
    const body = JSON.parse(text(result)) as { chunks: Record<string, unknown>[] };
    expect(body.chunks).toHaveLength(6);
    expect(body.chunks[0]).toEqual({
      source: 'resume.md',
      heading: 'Section 0',
      content: 'chunk 0',
      similarity: 0.9,
    });

    await client.callTool({ name: 'search_background', arguments: { query: 'rust', k: 8 } });
    const [first, second] = h.retrieve.mock.calls;
    expect(first?.slice(0, 2)).toEqual(['distributed systems', 6]);
    expect(second?.slice(0, 2)).toEqual(['rust', 8]);
    const ids = h.retrieve.mock.calls.map((call) => call[2]?.sessionId);
    expect(ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id))).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses a k above 8', async () => {
    const h = await start();
    const client = await connect(h);
    const result = await client.callTool({
      name: 'search_background',
      arguments: { query: 'rust', k: 9 },
    });
    expect(isError(result)).toBe(true);
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it('stops searching at the daily cap until the next UTC day', async () => {
    const h = await start({ dailySearchCap: 2 });
    const client = await connect(h);
    const search = () =>
      client.callTool({ name: 'search_background', arguments: { query: 'rust' } });
    expect(isError(await search())).toBe(false);
    expect(isError(await search())).toBe(false);
    const capped = await search();
    expect(isError(capped)).toBe(true);
    expect(text(capped)).toBe(DAILY_CAP_ERROR);
    expect(h.retrieve).toHaveBeenCalledTimes(2);
    // The resume costs no embedding, so it is not capped.
    expect(isError(await client.callTool({ name: 'get_resume_pdf', arguments: {} }))).toBe(false);
  });

  it('answers an upstream failure with the generic error, and logs it', async () => {
    const h = await start();
    h.retrieve.mockRejectedValueOnce(
      new Error('Knowledge service http://six7sweknowledge.railway.internal answered 500'),
    );
    const client = await connect(h);
    const result = await client.callTool({
      name: 'search_background',
      arguments: { query: 'rust' },
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toBe(GENERIC_ERROR);
    expect(h.logs.join('')).toContain('Public MCP tool failed');

    h.getResume.mockRejectedValueOnce(new Error('/resume.pdf answered 503'));
    const resume = await client.callTool({ name: 'get_resume_pdf', arguments: {} });
    expect(text(resume)).toBe(GENERIC_ERROR);
  });

  it('fails generically when the knowledge service is not configured', async () => {
    const client = await connect(await start({ configured: false }));
    const result = await client.callTool({
      name: 'search_background',
      arguments: { query: 'rust' },
    });
    expect(text(result)).toBe(GENERIC_ERROR);
  });

  it('returns the resume PDF as an embedded resource, or a tool error', async () => {
    const h = await start();
    const client = await connect(h);
    const result = await client.callTool({ name: 'get_resume_pdf', arguments: {} });
    expect(result.content).toEqual([
      {
        type: 'resource',
        resource: {
          uri: expect.any(String),
          mimeType: 'application/pdf',
          blob: PDF.toString('base64'),
        },
      },
    ]);

    h.getResume.mockResolvedValueOnce({ found: false });
    expect(text(await client.callTool({ name: 'get_resume_pdf', arguments: {} }))).toBe(
      NO_RESUME_ERROR,
    );

    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024)]);
    h.getResume.mockResolvedValueOnce({ found: true, body: big, etag: '"big"' });
    expect(text(await client.callTool({ name: 'get_resume_pdf', arguments: {} }))).toBe(
      RESUME_TOO_LARGE_ERROR,
    );
  });

  it('answers GET and DELETE with 405', async () => {
    const h = await start();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await h.app.inject({ method, url: PUBLIC_MCP_PATH });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });
});

describe('public MCP rate limit', () => {
  const listTools = (h: Harness, client: string) =>
    h.app.inject({
      method: 'POST',
      url: PUBLIC_MCP_PATH,
      headers: {
        'x-forwarded-for': client,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });

  it('answers 429 with a JSON-RPC error once a client spends its budget, per client', async () => {
    const h = await start({ rateLimitMax: 3 });
    for (let i = 0; i < 3; i++) expect((await listTools(h, '1.1.1.1')).statusCode).toBe(200);
    const limited = await listTools(h, '1.1.1.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.stringContaining('Too many requests') },
    });
    expect((await listTools(h, '2.2.2.2')).statusCode).toBe(200);
    expect((await listTools(h, '9.9.9.9, 1.1.1.1')).statusCode).toBe(429);
  });

  it('serves a client without an Origin under the production CORS policy', async () => {
    const h = await start({ cors: ['https://ray-manguino.dev'] });
    const res = await listTools(h, '3.3.3.3');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: { tools: expect.any(Array) } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    // A browser on another site gets no CORS grant: the policy is not loosened.
    const browser = await h.app.inject({
      method: 'OPTIONS',
      url: PUBLIC_MCP_PATH,
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('marks every method of the route public', async () => {
    const app = Fastify({ logger: false });
    const seen: { method: string | string[]; public: boolean | undefined }[] = [];
    app.addHook('onRoute', (route) => {
      if (route.url === PUBLIC_MCP_PATH) {
        seen.push({ method: route.method, public: route.config?.public });
      }
    });
    await registerPublicMcpRoutes(app, { config: DEFAULT_PUBLIC_MCP_CONFIG });
    await app.ready();
    expect(seen.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'POST']);
    expect(seen.every((r) => r.public === true)).toBe(true);
    await app.close();
  });
});

describe('getPublicMcpConfig', () => {
  it('reads the env, falling back to the defaults on bad values', () => {
    expect(getPublicMcpConfig({})).toEqual(DEFAULT_PUBLIC_MCP_CONFIG);
    expect(
      getPublicMcpConfig({
        PUBLIC_MCP_RATE_LIMIT_MAX: '5',
        PUBLIC_MCP_RATE_LIMIT_WINDOW_MS: '60000',
        PUBLIC_MCP_DAILY_SEARCH_CAP: '0',
      }),
    ).toEqual({ rateLimitMax: 5, rateLimitWindowMs: 60_000, dailySearchCap: 500 });
  });
});

describe('createDailyCap', () => {
  it('resets at the next UTC day', () => {
    let now = Date.parse('2026-11-20T23:59:00Z');
    const cap = createDailyCap(2, () => now);
    expect(cap.tryTake()).toBe(true);
    expect(cap.tryTake()).toBe(true);
    expect(cap.tryTake()).toBe(false);
    expect(cap.remaining()).toBe(0);
    now = Date.parse('2026-11-21T00:00:01Z');
    expect(cap.remaining()).toBe(2);
    expect(cap.tryTake()).toBe(true);
  });
});
