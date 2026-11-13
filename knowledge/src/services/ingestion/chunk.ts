import type { SupportedMimeType } from './parse.js';

/**
 * Splits extracted text into retrieval-sized chunks.
 *
 * Markdown is split into sections at headings, because a heading is the best
 * signal of where one topic ends and the next begins. Consecutive sections
 * are then packed greedily into one chunk while they fit the limit, so a
 * resume with many tiny headings does not produce dozens of one-line chunks;
 * a new chunk starts at the first heading that would overflow it. Packing
 * does cross topic boundaries (a short resume becomes one chunk), and a
 * packed chunk is labelled with the deepest heading every packed section
 * shares.
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

/** About four characters per token for English text. */
export const CHARS_PER_TOKEN = 4;

/**
 * A cheap token estimate. Only used for sizing, so it does not need to match
 * the model's tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface Section {
  /** The heading titles above this section, outermost first; empty before any heading. */
  trail: string[];
  /** `trail` joined with " > ", or null when it is empty. */
  path: string | null;
  text: string;
}

const HEADING_SEPARATOR = ' > ';

function joinTrail(trail: string[]): string | null {
  return trail.length > 0 ? trail.join(HEADING_SEPARATOR) : null;
}

/** The longest heading trail every section shares, e.g. [A, B] for "A > B > C" and "A > B > D". */
function sharedTrail(sections: Section[]): string[] {
  const [first, ...rest] = sections;
  if (!first) return [];
  let length = first.trail.length;
  for (const section of rest) {
    let i = 0;
    while (i < length && section.trail[i] === first.trail[i]) i++;
    length = i;
  }
  return first.trail.slice(0, length);
}

// Linear-time patterns: the space run and the title cannot overlap (the
// title starts with a non-space), so there is nothing to backtrack over.
const HEADING = /^(#{1,6})[ \t]+(\S.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Drops an ATX closing sequence ("## Title ##" is "Title"). Done by hand
 * rather than with a trailing-anchored regex, which backtracks
 * quadratically over long runs of spaces.
 */
function headingTitle(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === text.length) return text;
  // Only a run of hashes after whitespace closes the heading: "C#" keeps its hash.
  const before = text[end - 1];
  if (before !== ' ' && before !== '\t') return text;
  return text.slice(0, end).trimEnd() || text;
}

/** Splits markdown into sections at ATX headings, ignoring fenced code. */
export function splitMarkdownSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: string[] = [];
  let currentTrail: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = current.join('\n').trim();
    if (body) sections.push({ trail: currentTrail, path: joinTrail(currentTrail), text: body });
    current = [];
  };

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match?.[1] && match[2]) {
      flush();
      const level = match[1].length;
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title: headingTitle(match[2]) });
      currentTrail = stack.map((h) => h.title);
    }
    current.push(line);
  }
  flush();
  return sections;
}

/**
 * Cuts a "word" longer than the budget (a URL, a base64 blob, PDF text with
 * no spaces) into pieces that fit. Cuts between code points, never inside a
 * surrogate pair.
 */
function hardSplit(word: string, maxTokens: number): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (word.length <= maxChars) return [word];
  const pieces: string[] = [];
  let piece = '';
  for (const char of word) {
    if (piece && piece.length + char.length > maxChars) {
      pieces.push(piece);
      piece = '';
    }
    piece += char;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Packs words into space-joined runs that each fit `maxTokens`. */
function splitByWords(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const runs: string[] = [];
  let buffer = '';
  for (const word of text.split(/\s+/)) {
    for (const piece of hardSplit(word, maxTokens)) {
      if (!piece) continue;
      if (buffer && buffer.length + 1 + piece.length > maxChars) {
        runs.push(buffer);
        buffer = '';
      }
      buffer = buffer ? `${buffer} ${piece}` : piece;
    }
  }
  if (buffer) runs.push(buffer);
  return runs;
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
      units.push(...splitByWords(sentence, maxTokens));
    }
  }
  return units;
}

/**
 * The end of `text`, at most `maxTokens` long, starting at a word boundary.
 * Empty when no boundary falls inside the budget.
 */
function wordSuffix(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  for (let start = text.length - maxChars; start < text.length; start++) {
    if (/\s/.test(text[start - 1] ?? '') && !/\s/.test(text[start] ?? '')) {
      return text.slice(start);
    }
  }
  return '';
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
        const unitText = window[i];
        if (unitText === undefined) break;
        const candidate = [unitText, ...tail];
        if (size(candidate) > overlapTokens) break;
        tail = candidate;
      }
      // The last unit alone is bigger than the overlap budget (a long
      // paragraph): carry the end of it instead, so the overlap still holds.
      const last = window[window.length - 1];
      if (tail.length === 0 && last !== undefined) {
        const suffix = wordSuffix(last, overlapTokens);
        if (suffix && suffix !== last) tail = [suffix];
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
    if (packed.length > 0) out.push(toChunk(joinTrail(sharedTrail(packed)), packedText()));
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

/**
 * What gets embedded: the heading path, when there is one, then the content.
 * The full path ("Experience > Acme") gives context even when the content
 * repeats only the innermost heading line, or none (a window cut from a long
 * section).
 */
export function embeddingInput(chunk: Pick<TextChunk, 'heading' | 'content'>): string {
  return chunk.heading ? `${chunk.heading}\n\n${chunk.content}` : chunk.content;
}
