import type { Embedder } from './index.js';

/**
 * A deterministic, offline embedder for local development and tests.
 *
 * It hashes words into a fixed-size vector (the "hashing trick"), so texts
 * that share words land close together. It knows nothing about meaning:
 * "Kubernetes" and "container orchestration" are unrelated to it. Use it to
 * exercise the pipeline without an API key, never in production (the config
 * refuses `EMBEDDER=hashing` when NODE_ENV=production).
 */

const STOPWORDS = new Set(
  'a an and are as at be by for from has have i in is it its of on or that the this to was were with you your'.split(
    ' ',
  ),
);

/** FNV-1a, 32-bit. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

export function hashEmbed(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const h = fnv1a(token);
    const sign = (h & 0x80000000) === 0 ? 1 : -1;
    const i = h % dimensions;
    vector[i] = (vector[i] ?? 0) + sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    // Cosine distance is undefined for a zero vector; give empty text a
    // fixed direction instead so pgvector never returns NaN.
    vector[0] = 1;
    return vector;
  }
  return vector.map((v) => v / norm);
}

export function createHashingEmbedder(dimensions: number): Embedder {
  return {
    name: 'hashing',
    dimensions,
    embed: async (texts) => texts.map((t) => hashEmbed(t, dimensions)),
  };
}
