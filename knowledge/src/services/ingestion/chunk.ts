import type { SupportedMimeType } from './parse.js';

/**
 * Splits extracted text into retrieval-sized chunks.
 *
 * Markdown is split at headings first, because a heading is the best signal
 * of where one topic ends and the next begins (a resume's "Experience" and
 * "Education" should never share a chunk if they can help it). Small
 * consecutive sections are packed together so a resume with many tiny
 * headings does not produce dozens of one-line chunks.
 *
 * Anything longer than the limit (a long section, or a PDF/plain-text file
 * with no headings) falls back to a sliding window over paragraphs, then
 * sentences, then words, with an overlap so a fact that straddles a boundary
 * is still retrievable from one chunk.
 */

export interface TextChunk {
  /** Heading path the chunk sits under, e.g. "Experience > Acme". */
  heading: string | null;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Upper bound per chunk, in estimated tokens. */
  maxTokens: number;
  /** Fraction of `maxTokens` repeated at the start of the next window. */
  overlapRatio: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 700, overlapRatio: 0.15 };

/**
 * A cheap token estimate: about four characters per token for English.
 * Only used for sizing, so it does not need to match the model's tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Section {
  path: string | null;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Splits markdown into sections at ATX headings, ignoring fenced code. */
export function splitMarkdownSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: string[] = [];
  let currentPath: string | null = null;
  let inFence = false;

  const flush = () => {
    const body = current.join('\n').trim();
    if (body) sections.push({ path: currentPath, text: body });
    current = [];
  };

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match?.[1] && match[2]) {
      flush();
      const level = match[1].length;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title: match[2] });
      currentPath = stack.map((h) => h.title).join(' > ');
    }
    current.push(line);
  }
  flush();
  return sections;
}

/** Breaks text into units no larger than `maxTokens`: paragraphs, else sentences, else words. */
function splitIntoUnits(text: string, maxTokens: number): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (estimateTokens(p) <= maxTokens) {
      units.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (estimateTokens(sentence) <= maxTokens) {
        units.push(sentence);
        continue;
      }
      // A single run-on "sentence" (common in PDF extraction): cut by words.
      let buffer: string[] = [];
      for (const word of sentence.split(/\s+/)) {
        if (buffer.length > 0 && estimateTokens([...buffer, word].join(' ')) > maxTokens) {
          units.push(buffer.join(' '));
          buffer = [];
        }
        buffer.push(word);
      }
      if (buffer.length > 0) units.push(buffer.join(' '));
    }
  }
  return units;
}

/** Packs units into windows of at most `maxTokens`, repeating a tail of each in the next. */
export function windowSplit(text: string, options: ChunkOptions): string[] {
  const { maxTokens, overlapRatio } = options;
  const overlapTokens = Math.floor(maxTokens * overlapRatio);
  const units = splitIntoUnits(text, maxTokens);
  const windows: string[] = [];

  let window: string[] = [];
  let carried = 0; // leading units of `window` repeated from the previous window
  const size = (parts: string[]) => estimateTokens(parts.join('\n\n'));

  for (const unit of units) {
    const hasNewUnits = window.length > carried;
    if (hasNewUnits && size([...window, unit]) > maxTokens) {
      windows.push(window.join('\n\n'));

      // Carry trailing units forward while they fit in the overlap budget.
      // Never the first unit: repeating the whole window would add nothing.
      let tail: string[] = [];
      for (let i = window.length - 1; i >= 1; i--) {
        const candidate = [window[i] as string, ...tail];
        if (size(candidate) > overlapTokens) break;
        tail = candidate;
      }
      // The overlap must never stop the next unit from fitting.
      while (tail.length > 0 && size([...tail, unit]) > maxTokens) tail = tail.slice(1);

      window = tail;
      carried = tail.length;
    }
    window.push(unit);
  }
  if (window.length > carried) windows.push(window.join('\n\n'));
  return windows;
}

function toChunk(heading: string | null, content: string): TextChunk {
  return { heading, content, tokenCount: estimateTokens(content) };
}

export function chunkDocument(
  text: string,
  mime: SupportedMimeType,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): TextChunk[] {
  if (!text.trim()) return [];

  if (mime !== 'text/markdown') {
    return windowSplit(text, options).map((content) => toChunk(null, content));
  }

  const out: TextChunk[] = [];
  let packed: Section[] = [];
  const packedText = () => packed.map((s) => s.text).join('\n\n');
  const flushPacked = () => {
    if (packed.length > 0) out.push(toChunk(packed[0]?.path ?? null, packedText()));
    packed = [];
  };

  for (const section of splitMarkdownSections(text)) {
    if (estimateTokens(section.text) > options.maxTokens) {
      flushPacked();
      for (const piece of windowSplit(section.text, options)) {
        out.push(toChunk(section.path, piece));
      }
      continue;
    }
    if (
      packed.length > 0 &&
      estimateTokens(`${packedText()}\n\n${section.text}`) > options.maxTokens
    ) {
      flushPacked();
    }
    packed.push(section);
  }
  flushPacked();
  return out;
}

/** What gets embedded: the heading path gives a window cut from a long section its context. */
export function embeddingInput(chunk: Pick<TextChunk, 'heading' | 'content'>): string {
  return chunk.heading && !chunk.content.includes(chunk.heading)
    ? `${chunk.heading}\n\n${chunk.content}`
    : chunk.content;
}
