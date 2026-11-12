import { describe, expect, it, vi } from 'vitest';
import { hashEmbed, tokenize } from '../services/embedding/hashing.js';
import { createOpenRouterEmbedder, EmbeddingError } from '../services/embedding/openrouter.js';

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

describe('OpenRouter embedder', () => {
  const base = { apiKey: 'k', model: 'm', dimensions: 3, backoffMs: () => 0 };

  it('orders results by index and batches large inputs', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      const data = input.map((_, index) => ({ index, embedding: vec(3, index) })).reverse();
      return jsonResponse({ data });
    });
    const embedder = createOpenRouterEmbedder({ ...base, fetchImpl: fetchImpl as typeof fetch });

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
    const embedder = createOpenRouterEmbedder({ ...base, fetchImpl });
    expect(await embedder.embed(['x'])).toEqual([vec(3, 1)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad model', { status: 400 }));
    const embedder = createOpenRouterEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after three attempts', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('down', { status: 503 }));
    const embedder = createOpenRouterEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects vectors with the wrong dimension', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: vec(5, 1) }] }));
    const embedder = createOpenRouterEmbedder({ ...base, fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/returned 5 dimensions, expected 3/);
  });
});
