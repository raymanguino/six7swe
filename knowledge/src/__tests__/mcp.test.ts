import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createMemoryProfileRepository } from './support/memoryProfileRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';

const KEY = 'k'.repeat(40);
const OWNER_KEY = 'o'.repeat(40);
const ownerAuth = { 'x-knowledge-key': OWNER_KEY };
const bearer = { authorization: `Bearer ${OWNER_KEY}` };

let app: FastifyInstance;
let baseUrl: string;
let clients: Client[] = [];

beforeEach(async () => {
  app = await buildApp({
    deps: {
      repo: createMemoryRepository(),
      files: createMemoryFileStore(),
      embedder: createHashingEmbedder(256),
    },
    profile: { repo: createMemoryProfileRepository(), drafter: null },
    evaluation: { repo: createMemoryEvalRepository(), answerer: null },
    serviceKey: KEY,
    ownerKey: OWNER_KEY,
    ownerId: 'owner',
    maxUploadBytes: 1024 * 1024,
    logger: false,
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await app.ingestionQueue.idle();
  await app.evalRunner.idle();
  await app.evalSet.idle();
  await app.close();
});

async function connect(headers: Record<string, string> = bearer): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers },
    }),
  );
  clients.push(client);
  return client;
}

async function upload(name: string, bytes: Uint8Array, kind: string) {
  const { payload, headers } = multipartFile(name, bytes);
  const res = await app.inject({
    method: 'POST',
    url: `/documents?kind=${kind}`,
    payload,
    headers: { ...headers, ...ownerAuth },
  });
  expect(res.statusCode).toBeLessThan(300);
  await app.ingestionQueue.idle();
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

describe('MCP adapter', () => {
  it('lists the tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_profile',
      'get_resume_pdf',
      'list_documents',
      'search_background',
    ]);
  });

  it('search_background returns chunks through the stub embedder', async () => {
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    const client = await connect();
    const result = await client.callTool({
      name: 'search_background',
      arguments: { query: 'experience', k: 3 },
    });
    expect(result.isError).toBeFalsy();
    const [block] = result.content as { type: string; text: string }[];
    const body = JSON.parse(block?.text ?? '{}') as { chunks: { filename: string }[] };
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.chunks[0]?.filename).toBe('resume.md');
  });

  it('rejects tool input that fails validation', async () => {
    const client = await connect();
    const result = await client
      .callTool({ name: 'search_background', arguments: { query: '' } })
      .catch((e: unknown) => e);
    const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });

  it('list_documents lists the uploaded documents', async () => {
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    const client = await connect();
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    const [block] = result.content as { text: string }[];
    const body = JSON.parse(block?.text ?? '{}') as { documents: { filename: string }[] };
    expect(body.documents.map((d) => d.filename)).toEqual(['resume.md']);
  });

  it('get_resume_pdf returns the PDF as an embedded resource blob', async () => {
    const pdf = makePdf(['Jane Doe', 'Software engineer']);
    await upload('resume.pdf', pdf, 'resume');
    const client = await connect();
    const result = await client.callTool({ name: 'get_resume_pdf', arguments: {} });
    const [block] = result.content as {
      type: string;
      resource: { mimeType: string; blob: string };
    }[];
    expect(block?.type).toBe('resource');
    expect(block?.resource.mimeType).toBe('application/pdf');
    expect(Buffer.from(block?.resource.blob ?? '', 'base64').equals(Buffer.from(pdf))).toBe(true);
  });

  it('get_resume_pdf reports a missing PDF as a tool error', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'get_resume_pdf', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('rejects a missing or wrong bearer token with 401', async () => {
    const send = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...mcpHeaders, ...headers },
        payload: initializeBody,
      });
    expect((await send({})).statusCode).toBe(401);
    expect((await send({ authorization: 'Bearer wrong' })).statusCode).toBe(401);
    // The service key and the header the other modes use do not open /mcp.
    expect((await send({ authorization: `Bearer ${KEY}` })).statusCode).toBe(401);
    expect((await send(ownerAuth)).statusCode).toBe(401);
  });

  it('rejects a key in the query string, even beside a valid header', async () => {
    const inQuery = await app.inject({
      method: 'POST',
      url: `/mcp?key=${OWNER_KEY}`,
      headers: mcpHeaders,
      payload: initializeBody,
    });
    expect(inQuery.statusCode).toBe(401);
    const both = await app.inject({
      method: 'POST',
      url: `/mcp?access_token=${OWNER_KEY}`,
      headers: { ...mcpHeaders, ...bearer },
      payload: initializeBody,
    });
    expect(both.statusCode).toBe(401);
  });

  it('answers 405 to GET, as the adapter is stateless', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: bearer });
    expect(res.statusCode).toBe(405);
  });
});
