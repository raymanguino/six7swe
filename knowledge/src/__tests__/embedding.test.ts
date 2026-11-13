import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { EmbeddingError } from '../services/embedding/errors.js';
import { createEmbedder } from '../services/embedding/index.js';
import { hashEmbed, tokenize } from '../services/embedding/hashing.js';
import {
  createOpenAICompatibleEmbedder,
  defaultBackoffMs,
  isRetryable,
  parseRetryAfter,
} from '../services/embedding/openaiCompatible.js';

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

describe('hashing embedder', () => {
  it('is deterministic and unit length', () => {
    const a = hashEmbed('Kafka billing migration', 64);
    expect(a).toEqual(hashEmbed('Kafka billing migration', 64));
    expect(Math.sqrt(dot(a, a))).toBeCloseTo(1, 10);
  });

  it('ranks texts that share words above texts that do not', () => {
    const query = hashEmbed('billing migration to Kafka', 256);
    const related = hashEmbed('Led the billing platform migration onto Kafka', 256);
    const unrelated = hashEmbed('BSc Computer Science, University of Toronto', 256);
    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
  });

  it('gives empty text a non-zero vector so cosine distance is defined', () => {
    const v = hashEmbed('the and of', 8);
    expect(v.some((x) => x !== 0)).toBe(true);
  });

  it('drops stopwords and folds simple plurals', () => {
    expect(tokenize('The Services and the APIs, CSS')).toEqual(['service', 'api', 'css']);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const vec = (n: number, fill: number) => new Array<number>(n).fill(fill);

describe('createEmbedder providers', () => {
  const ok = () =>
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return jsonResponse({
        data: input.map((_, index) => ({ index, embedding: vec(EMBEDDING_DIMENSIONS, 1) })),
      });
    });

  async function callWith(env: Record<string, string>) {
    const config = loadEnv({
      DATABASE_URL: 'postgres://localhost/db',
      KNOWLEDGE_SERVICE_KEY: 'k'.repeat(32),
      KNOWLEDGE_OWNER_KEY: 'o'.repeat(32),
      OWNER_AUTH_ID: 'owner',
      FILE_STORE: 'local',
      ...env,
    }).embedder;
    const fetchImpl = ok();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const embedder = createEmbedder(config, EMBEDDING_DIMENSIONS);
      await embedder.embed(['x']);
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { model: string };
      return { name: embedder.name, url: String(url), auth: headers.get('authorization'), body };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('defaults to OpenAI with text-embedding-3-small', async () => {
    const call = await callWith({ OPENAI_API_KEY: 'sk-openai' });
    expect(call).toEqual({
      name: 'openai:text-embedding-3-small',
      url: 'https://api.openai.com/v1/embeddings',
      auth: 'Bearer sk-openai',
      body: { model: 'text-embedding-3-small', input: ['x'] },
    });
  });

  it('still supports OpenRouter with its own key and model id', async () => {
    const call = await callWith({ EMBEDDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or' });
    expect(call).toMatchObject({
      name: 'openrouter:openai/text-embedding-3-small',
      url: 'https://openrouter.ai/api/v1/embeddings',
      auth: 'Bearer sk-or',
      body: { model: 'openai/text-embedding-3-small' },
    });
  });

  it('honours EMBEDDING_MODEL as an override', async () => {
    const call = await callWith({ OPENAI_API_KEY: 'sk', EMBEDDING_MODEL: 'my-model' });
    expect(call.body.model).toBe('my-model');
  });

  it('names the provider in error messages', async () => {
    const config = loadEnv({
      DATABASE_URL: 'postgres://localhost/db',
      KNOWLEDGE_SERVICE_KEY: 'k'.repeat(32),
      KNOWLEDGE_OWNER_KEY: 'o'.repeat(32),
      OWNER_AUTH_ID: 'owner',
      FILE_STORE: 'local',
      OPENAI_API_KEY: 'sk',
    }).embedder;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    );
    try {
      const error: unknown = await createEmbedder(config, 3)
        .embed(['x'])
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/OpenAI embedding request failed \(400\)/);
      expect(String(error)).not.toMatch(/OpenRouter/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('OpenAI-compatible embedder', () => {
  const base = {
    provider: 'test',
    label: 'Test',
    baseUrl: 'https://example.test/v1/',
    apiKey: 'k',
    model: 'm',
    dimensions: 3,
    backoffMs: () => 0,
  };

  it('posts to {baseUrl}/embeddings, without doubling a trailing slash', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ data: [{ index: 0, embedding: vec(3, 1) }] }),
    );
    await createOpenAICompatibleEmbedder({ ...base, fetchImpl }).embed(['x']);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/v1/embeddings');
  });

  it('orders results by index and batches large inputs', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      const data = input.map((_, index) => ({ index, embedding: vec(3, index) })).reverse();
      return jsonResponse({ data });
    });
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });

    const result = await embedder.embed(Array.from({ length: 70 }, (_, i) => `t${i}`));
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 64 + 6
    expect(result).toHaveLength(70);
    expect(result[0]).toEqual(vec(3, 0));
    expect(result[63]).toEqual(vec(3, 63));
    expect(result[64]).toEqual(vec(3, 0));
  });

  it('retries a 429 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: vec(3, 1) }] }));
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    expect(await embedder.embed(['x'])).toEqual([vec(3, 1)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad model', { status: 400 }));
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after three attempts', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('down', { status: 503 }));
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects vectors with the wrong dimension', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: vec(5, 1) }] }));
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/returned 5 dimensions, expected 3/);
  });

  it('rejects duplicate or missing indexes even when the count matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { index: 0, embedding: vec(3, 0) },
          { index: 0, embedding: vec(3, 1) },
          { index: 2, embedding: vec(3, 2) },
        ],
      }),
    );
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['a', 'b', 'c'])).rejects.toThrow(/indexes are not 0\.\.2/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: vec(3, 1) }] }));
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    expect(await embedder.embed(['x'])).toEqual([vec(3, 1)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('records the status and Retry-After on a provider error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      );
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    const error: unknown = await embedder.embed(['x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error).toMatchObject({ status: 429, details: { retryAfterMs: 0 } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('wraps transport failures and timeouts in a retryable EmbeddingError with the cause', async () => {
    const network = new TypeError('fetch failed');
    const timeout = new DOMException('timed out', 'TimeoutError');
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(network)
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(network);
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    const error: unknown = await embedder.embed(['x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error).toMatchObject({ retryable: true, cause: network });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a body that is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }));
    const embedder = createOpenAICompatibleEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/not JSON/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('retry helpers', () => {
  it('isRetryable reads only EmbeddingError.retryable', () => {
    expect(isRetryable(new EmbeddingError('x', true))).toBe(true);
    expect(isRetryable(new EmbeddingError('x', false))).toBe(false);
    // Raw errors never reach the retry loop from fetch; anything else is a bug.
    expect(isRetryable(new TypeError('fetch failed'))).toBe(false);
    expect(isRetryable(new SyntaxError('bad json'))).toBe(false);
  });

  it('parseRetryAfter reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('defaultBackoffMs grows exponentially with jitter', () => {
    for (let i = 0; i < 20; i++) {
      const first = defaultBackoffMs(1);
      expect(first).toBeGreaterThanOrEqual(250);
      expect(first).toBeLessThanOrEqual(500);
      expect(defaultBackoffMs(3)).toBeGreaterThanOrEqual(1000);
    }
  });
});
