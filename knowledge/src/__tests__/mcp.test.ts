import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { request } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { KnowledgeRepository } from '../db/api/repository.js';
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
const ownerAuth = { 'x-knowledge-key': OWNER_KEY };
const MCP_KEY = 'm'.repeat(40);
const bearer = { authorization: `Bearer ${MCP_KEY}` };

interface Harness {
  app: FastifyInstance;
  baseUrl: string;
  logs: string[];
}

let current: Harness | null = null;
let clients: Client[] = [];

interface StartOptions {
  /** The MCP key; `null` leaves it unset. Defaults to `MCP_KEY`. */
  mcpKey?: string | null;
  mcpMaxPdfBytes?: number;
  /** Replaces methods of the in-memory repository, e.g. to make one throw. */
  repoOverrides?: Partial<KnowledgeRepository>;
}

async function start(options: StartOptions = {}): Promise<Harness> {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const app = await buildApp({
    deps: {
      repo: { ...createMemoryRepository(), ...options.repoOverrides },
      files: createMemoryFileStore(),
      embedder: createHashingEmbedder(256),
    },
    evaluation: { repo: createMemoryEvalRepository(), answerer: null },
    serviceKey: KEY,
    ownerKey: OWNER_KEY,
    mcpKey: options.mcpKey === null ? undefined : (options.mcpKey ?? MCP_KEY),
    ownerId: 'owner',
    maxUploadBytes: 1024 * 1024,
    mcpMaxPdfBytes: options.mcpMaxPdfBytes,
    logger: { level: 'error', stream },
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  current = { app, baseUrl, logs };
  return current;
}

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  if (!current) return;
  const { app } = current;
  current = null;
  await app.ingestionQueue.idle();
  await app.evalRunner.idle();
  await app.evalSet.idle();
  await app.close();
});

async function connect(h: Harness, headers: Record<string, string> = bearer): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers } }),
  );
  clients.push(client);
  return client;
}

async function upload(h: Harness, name: string, bytes: Uint8Array, kind: string) {
  const { payload, headers } = multipartFile(name, bytes);
  const res = await h.app.inject({
    method: 'POST',
    url: `/documents?kind=${kind}`,
    payload,
    headers: { ...headers, ...ownerAuth },
  });
  expect(res.statusCode).toBeLessThan(300);
  await h.app.ingestionQueue.idle();
}

/** The first content block of a tool result (the SDK types `content` loosely). */
function firstBlock(result: object): unknown {
  const content = 'content' in result ? result.content : undefined;
  return Array.isArray(content) ? (content[0] as unknown) : undefined;
}

/** The first content block of a tool result, narrowed to the text it must be. */
function textOf(result: object): string {
  const block: unknown = firstBlock(result);
  if (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    typeof block.text === 'string'
  ) {
    return block.text;
  }
  throw new Error('Expected a text block');
}

/** The first content block of a tool result, narrowed to an embedded resource. */
function resourceOf(result: object): { mimeType?: string; blob?: string } {
  const block: unknown = firstBlock(result);
  if (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'resource' &&
    'resource' in block &&
    typeof block.resource === 'object' &&
    block.resource !== null
  ) {
    return block.resource;
  }
  throw new Error('Expected a resource block');
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe('MCP adapter tools', () => {
  it('lists the tools', async () => {
    const client = await connect(await start());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_resume_pdf',
      'list_documents',
      'search_background',
    ]);
  });

  it('search_background returns chunks through the stub embedder', async () => {
    const h = await start();
    await upload(h, 'resume.md', utf8(RESUME_MD), 'resume');
    const client = await connect(h);
    const result = await client.callTool({
      name: 'search_background',
      arguments: { query: 'experience', k: 3 },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result)) as { chunks: { filename: string }[] };
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.chunks[0]?.filename).toBe('resume.md');
  });

  it('reports invalid tool input as an isError result, without running the tool', async () => {
    const h = await start();
    const client = await connect(h);
    const result = await client.callTool({ name: 'search_background', arguments: { query: '' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Input validation error');
    expect(h.logs).toEqual([]);
  });

  it('list_documents lists the uploaded documents', async () => {
    const h = await start();
    await upload(h, 'resume.md', utf8(RESUME_MD), 'resume');
    const client = await connect(h);
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    const body = JSON.parse(textOf(result)) as { documents: { filename: string }[] };
    expect(body.documents.map((d) => d.filename)).toEqual(['resume.md']);
  });

  it('get_resume_pdf returns the PDF as an embedded resource blob', async () => {
    const h = await start();
    const pdf = makePdf(['Jane Doe', 'Software engineer']);
    await upload(h, 'resume.pdf', pdf, 'resume');
    const client = await connect(h);
    const resource = resourceOf(await client.callTool({ name: 'get_resume_pdf', arguments: {} }));
    expect(resource.mimeType).toBe('application/pdf');
    expect(Buffer.from(resource.blob ?? '', 'base64').equals(Buffer.from(pdf))).toBe(true);
  });

  it('get_resume_pdf reports a missing PDF as a tool error', async () => {
    const client = await connect(await start());
    const result = await client.callTool({ name: 'get_resume_pdf', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No PDF resume');
  });

  it('get_resume_pdf refuses a PDF over the limit before fetching it', async () => {
    const h = await start({ mcpMaxPdfBytes: 100 });
    await upload(h, 'resume.pdf', makePdf(['Jane Doe', 'Software engineer']), 'resume');
    const client = await connect(h);
    const result = await client.callTool({ name: 'get_resume_pdf', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('too large');
  });

  it('answers a failing tool with a generic message and logs the cause', async () => {
    const h = await start({
      repoOverrides: {
        async listDocuments() {
          throw new Error('select * from knowledge.documents: connection refused');
        },
      },
    });
    const client = await connect(h);
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Internal error. Try again.');
    expect(h.logs.join('')).toContain('connection refused');
    expect(h.logs.join('')).toContain('list_documents');
  });
});

describe('MCP adapter auth and methods', () => {
  const post = (h: Harness, url: string, headers: Record<string, string>) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: { ...mcpHeaders, ...headers },
      payload: initializeBody,
    });

  it('opens with the MCP key as a bearer token', async () => {
    const h = await start();
    expect((await post(h, '/mcp', bearer)).statusCode).toBe(200);
  });

  it('rejects a missing or wrong bearer token with 401', async () => {
    const h = await start();
    expect((await post(h, '/mcp', {})).statusCode).toBe(401);
    expect((await post(h, '/mcp', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    // No other key opens /mcp, as a bearer token or in the other header.
    expect((await post(h, '/mcp', { authorization: `Bearer ${KEY}` })).statusCode).toBe(401);
    expect((await post(h, '/mcp', { authorization: `Bearer ${OWNER_KEY}` })).statusCode).toBe(401);
    expect((await post(h, '/mcp', ownerAuth)).statusCode).toBe(401);
    expect((await post(h, '/mcp', { 'x-knowledge-key': MCP_KEY })).statusCode).toBe(401);
  });

  it('does not let the MCP key open owner or service routes', async () => {
    const h = await start();
    const mcpAsHeader = { 'x-knowledge-key': MCP_KEY };
    expect(
      (await h.app.inject({ method: 'GET', url: '/documents', headers: mcpAsHeader })).statusCode,
    ).toBe(401);
    expect(
      (await h.app.inject({ method: 'GET', url: '/version', headers: mcpAsHeader })).statusCode,
    ).toBe(401);
  });

  it('is closed when no MCP key is configured', async () => {
    const h = await start({ mcpKey: null });
    expect((await post(h, '/mcp', bearer)).statusCode).toBe(401);
    expect((await post(h, '/mcp', { authorization: 'Bearer ' })).statusCode).toBe(401);
    expect((await post(h, '/mcp', { authorization: `Bearer ${OWNER_KEY}` })).statusCode).toBe(401);
  });

  it('rejects a key in the query string, with or without a valid header', async () => {
    const h = await start();
    expect((await post(h, `/mcp?key=${MCP_KEY}`, {})).statusCode).toBe(401);
    expect((await post(h, `/mcp?key=${MCP_KEY}`, bearer)).statusCode).toBe(401);
    expect((await post(h, `/mcp?access_token=${MCP_KEY}`, bearer)).statusCode).toBe(401);
  });

  it('rejects any query string, including a benign one, and says why', async () => {
    const h = await start();
    const res = await post(h, '/mcp?x=1', bearer);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toContain('Authorization header');
  });

  it('rejects a trailing ? too (sent raw: inject and fetch both drop it)', async () => {
    const h = await start();
    const { port } = new URL(h.baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp?',
          method: 'POST',
          headers: { ...mcpHeaders, ...bearer },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(initializeBody));
    });
    expect(status).toBe(401);
  });

  it('answers 405 to GET and DELETE, as the adapter is stateless', async () => {
    const h = await start();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await h.app.inject({ method, url: '/mcp', headers: bearer });
      expect(res.statusCode).toBe(405);
    }
  });
});
