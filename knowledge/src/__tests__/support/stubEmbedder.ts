import type { Embedder } from '../../services/embedding/index.js';
import { hashEmbed } from '../../services/embedding/hashing.js';

/**
 * A deterministic embeddings stub: each listed text maps to a fixed vector,
 * so a test states exactly how similar two questions are. Unlisted texts fall
 * back to the hashing embedder. Every call's input is kept in `calls`.
 */
export function createStubEmbedder(
  vectors: Record<string, number[]>,
  dimensions: number,
): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const pad = (v: number[]) => [...v, ...new Array<number>(dimensions - v.length).fill(0)];
  return {
    name: 'stub',
    dimensions,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => {
        const fixed = vectors[t];
        return fixed ? pad(fixed) : hashEmbed(t, dimensions);
      });
    },
  };
}

/** The unit vector along `axis`. */
export function axis(index: number, dimensions: number): number[] {
  const v = new Array<number>(dimensions).fill(0);
  v[index] = 1;
  return v;
}

/** A unit vector at `similarity` (cosine) to axis `a`, leaning toward axis `b`. */
export function near(a: number, b: number, similarity: number, dimensions: number): number[] {
  const v = new Array<number>(dimensions).fill(0);
  v[a] = similarity;
  v[b] = Math.sqrt(1 - similarity * similarity);
  return v;
}
