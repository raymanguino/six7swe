import { describe, expect, it } from 'vitest';
import {
  chunkDocument,
  DEFAULT_CHUNK_OPTIONS,
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
    expect(splitMarkdownSections('intro\n\n# A\n\nbody')[0]).toEqual({
      trail: [],
      path: null,
      text: 'intro',
    });
  });

  it('ignores heading-like lines inside fenced code', () => {
    const md = '# Real\n\n```sh\n# not a heading\n```\n\nafter';
    const sections = splitMarkdownSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('# not a heading');
  });

  it('strips an ATX closing sequence but keeps a hash that is part of the title', () => {
    const md = '# Skills ##\n\na\n\n## C#\n\nb\n\n## Tabs\t#\t\n\nc';
    expect(splitMarkdownSections(md).map((s) => s.path)).toEqual([
      'Skills',
      'Skills > C#',
      'Skills > Tabs',
    ]);
  });

  it('handles a pathological heading line in linear time', () => {
    const line = `# a${' '.repeat(50_000)}b${' '.repeat(50_000)}`;
    const started = Date.now();
    expect(splitMarkdownSections(`${line}\n\nbody`)[0]?.path).toMatch(/^a +b$/);
    expect(Date.now() - started).toBeLessThan(500);
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

  it('keeps an overlap between windows of large paragraphs', () => {
    // Each paragraph is about 300 tokens, far above the 105-token overlap
    // budget, so whole-unit carry-over alone would give no overlap.
    const paragraphs = Array.from({ length: 4 }, (_, p) =>
      Array.from({ length: 150 }, (_, i) => `p${p}w${i}`).join(' '),
    );
    const windows = windowSplit(paragraphs.join('\n\n'), DEFAULT_CHUNK_OPTIONS);
    expect(windows.length).toBeGreaterThan(1);
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1] ?? '';
      const head = (windows[i] ?? '').split('\n\n')[0] ?? '';
      // The next window opens with the end of the previous one, cut at a word.
      expect(prev.endsWith(head)).toBe(true);
      expect(head.split(' ')[0]).toMatch(/^p\dw\d+$/);
      expect(estimateTokens(head)).toBeGreaterThan(50);
      expect(estimateTokens(head)).toBeLessThanOrEqual(105);
    }
    for (const w of windows) expect(estimateTokens(w)).toBeLessThanOrEqual(700);
  });

  it('hard-splits a single word longer than the budget', () => {
    const windows = windowSplit('x'.repeat(5000), DEFAULT_CHUNK_OPTIONS);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(estimateTokens(w)).toBeLessThanOrEqual(700);
    expect(windows.join('').replace(/\s/g, '').length).toBeGreaterThanOrEqual(5000);

    const chunks = chunkDocument(`# Blob\n\n${'y'.repeat(5000)}`, 'text/markdown');
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(700);
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

  it('labels a packed chunk with the deepest heading all its sections share', () => {
    const md = '# Resume\n\n## Experience\n\n### Acme\n\na\n\n### Globex\n\nb\n\n## Education\n\nc';
    const [all] = chunkDocument(md, 'text/markdown');
    expect(all?.heading).toBe('Resume');

    const experience = chunkDocument(
      // The intro section alone is exactly 60 tokens, so the next heading overflows it.
      `# Resume\n\nintro ${words(58)}\n\n## Experience\n\n### Acme\n\na\n\n### Globex\n\nb`,
      'text/markdown',
      { maxTokens: 60, overlapRatio: 0.15 },
    );
    // The first chunk holds only the intro; the rest share "Resume > Experience".
    expect(experience.map((c) => c.heading)).toEqual(['Resume', 'Resume > Experience']);

    // Text before any heading shares nothing with a headed section.
    expect(chunkDocument('intro\n\n# A\n\nbody', 'text/markdown')[0]?.heading).toBeNull();
  });
});

describe('embeddingInput', () => {
  it('prefixes the heading path whenever there is one', () => {
    expect(embeddingInput({ heading: 'Exp > Acme', content: 'Led things' })).toBe(
      'Exp > Acme\n\nLed things',
    );
    expect(embeddingInput({ heading: 'Exp > Acme', content: '### Acme\n\nLed things' })).toBe(
      'Exp > Acme\n\n### Acme\n\nLed things',
    );
    expect(embeddingInput({ heading: null, content: 'x' })).toBe('x');
  });
});
