import { describe, expect, it } from 'vitest';
import {
  chunkDocument,
  embeddingInput,
  estimateTokens,
  splitMarkdownSections,
  windowSplit,
} from '../services/ingestion/chunk.js';
import { RESUME_MD } from './support/fixtures.js';

const words = (n: number, prefix = 'w') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

describe('splitMarkdownSections', () => {
  it('tracks the heading path through nested levels', () => {
    const sections = splitMarkdownSections(RESUME_MD);
    expect(sections.map((s) => s.path)).toEqual([
      'Jordan Example',
      'Jordan Example > Experience',
      'Jordan Example > Experience > Acme Corp — Staff Engineer (2021–2024)',
      'Jordan Example > Experience > Globex — Software Engineer (2017–2021)',
      'Jordan Example > Education',
    ]);
  });

  it('pops back up to a shallower heading', () => {
    const md = '# A\n\ntext\n\n## B\n\nb\n\n# C\n\nc';
    expect(splitMarkdownSections(md).map((s) => s.path)).toEqual(['A', 'A > B', 'C']);
  });

  it('keeps text before the first heading with a null path', () => {
    expect(splitMarkdownSections('intro\n\n# A\n\nbody')[0]).toEqual({ path: null, text: 'intro' });
  });

  it('ignores heading-like lines inside fenced code', () => {
    const md = '# Real\n\n```sh\n# not a heading\n```\n\nafter';
    const sections = splitMarkdownSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('# not a heading');
  });
});

describe('windowSplit', () => {
  const opts = { maxTokens: 50, overlapRatio: 0.3 };

  it('never exceeds the token limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${words(8)}.`).join('\n\n');
    for (const w of windowSplit(text, opts)) {
      expect(estimateTokens(w)).toBeLessThanOrEqual(opts.maxTokens);
    }
  });

  it('repeats the tail of one window at the start of the next', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `P${i} ${words(5, `p${i}x`)}`);
    const windows = windowSplit(paragraphs.join('\n\n'), opts);
    expect(windows.length).toBeGreaterThan(1);
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1]?.split('\n\n') ?? [];
      const firstOfNext = windows[i]?.split('\n\n')[0] ?? '';
      // The next window opens with one of the previous window's trailing units.
      expect(prev.slice(1)).toContain(firstOfNext);
    }
  });

  it('covers every paragraph', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Para${i} ${words(6)}`);
    const joined = windowSplit(paragraphs.join('\n\n'), opts).join('\n\n');
    for (const p of paragraphs) expect(joined).toContain(p);
  });

  it('splits a paragraph with no breaks by sentences, then by words', () => {
    const sentences = windowSplit(
      Array.from({ length: 20 }, (_, i) => `Sentence ${i} ${words(4)}.`).join(' '),
      opts,
    );
    expect(sentences.length).toBeGreaterThan(1);

    const runOn = windowSplit(words(400), opts);
    expect(runOn.length).toBeGreaterThan(1);
    for (const w of runOn) expect(estimateTokens(w)).toBeLessThanOrEqual(opts.maxTokens);
  });

  it('returns nothing for blank text', () => {
    expect(windowSplit('  \n\n ', opts)).toEqual([]);
  });
});

describe('chunkDocument', () => {
  it('packs a short markdown resume into one chunk', () => {
    const chunks = chunkDocument(RESUME_MD, 'text/markdown');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe('Jordan Example');
    expect(chunks[0]?.content).toContain('Kafka');
  });

  it('starts a new chunk at a heading boundary when packing would overflow', () => {
    const md = `# A\n\n${words(60)}\n\n# B\n\n${words(60)}`;
    // Each section is about 60 tokens: either fits alone, both together do not.
    const chunks = chunkDocument(md, 'text/markdown', { maxTokens: 100, overlapRatio: 0.15 });
    expect(chunks.map((c) => c.heading)).toEqual(['A', 'B']);
    expect(chunks[1]?.content.startsWith('# B')).toBe(true);
  });

  it('windows a long section and keeps its heading on every piece', () => {
    const md = `# Intro\n\nshort\n\n## Long\n\n${Array.from({ length: 40 }, (_, i) => `Line ${i} ${words(10)}.`).join('\n\n')}`;
    const chunks = chunkDocument(md, 'text/markdown', { maxTokens: 120, overlapRatio: 0.15 });
    const long = chunks.filter((c) => c.heading === 'Intro > Long');
    expect(long.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(120);
  });

  it('windows plain text and PDFs without headings', () => {
    const text = Array.from({ length: 30 }, (_, i) => `# not markdown ${i} ${words(10)}`).join(
      '\n\n',
    );
    const chunks = chunkDocument(text, 'text/plain', { maxTokens: 100, overlapRatio: 0.15 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === null)).toBe(true);
  });

  it('returns no chunks for empty text', () => {
    expect(chunkDocument('', 'text/markdown')).toEqual([]);
  });
});

describe('embeddingInput', () => {
  it('prefixes the heading when the content does not already contain it', () => {
    expect(embeddingInput({ heading: 'Exp > Acme', content: 'Led things' })).toBe(
      'Exp > Acme\n\nLed things',
    );
    expect(embeddingInput({ heading: 'Acme', content: '# Acme\n\nLed things' })).toBe(
      '# Acme\n\nLed things',
    );
    expect(embeddingInput({ heading: null, content: 'x' })).toBe('x');
  });
});
