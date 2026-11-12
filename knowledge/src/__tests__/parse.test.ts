import { describe, expect, it } from 'vitest';
import {
  detectMimeType,
  extractText,
  normalizeText,
  UnsupportedFileError,
} from '../services/ingestion/parse.js';
import { makePdf, utf8 } from './support/fixtures.js';

describe('detectMimeType', () => {
  it('maps the supported extensions, case-insensitively', () => {
    expect(detectMimeType('resume.PDF', makePdf(['x']))).toBe('application/pdf');
    expect(detectMimeType('notes.md', utf8('# hi'))).toBe('text/markdown');
    expect(detectMimeType('notes.markdown', utf8('# hi'))).toBe('text/markdown');
    expect(detectMimeType('notes.txt', utf8('hi'))).toBe('text/plain');
  });

  it('rejects other extensions', () => {
    expect(() => detectMimeType('resume.docx', utf8('x'))).toThrow(UnsupportedFileError);
    expect(() => detectMimeType('README', utf8('x'))).toThrow(/\(none\)/);
  });

  it('rejects a .pdf that is not a PDF', () => {
    expect(() => detectMimeType('fake.pdf', utf8('hello'))).toThrow(/not a PDF/);
  });

  it('rejects a text file containing binary data', () => {
    expect(() => detectMimeType('bin.txt', new Uint8Array([104, 0, 105]))).toThrow(
      /does not look like a text file/,
    );
  });
});

describe('normalizeText', () => {
  it('normalizes line endings, BOM, control chars, trailing spaces and blank runs', () => {
    expect(normalizeText('\uFEFFa  \r\nb\r\n\r\n\r\n\r\nc\u0007\n')).toBe('a\nb\n\nc');
  });
});

describe('extractText', () => {
  it('decodes markdown and text as UTF-8', async () => {
    expect(await extractText(utf8('# Café\r\n\r\nnaïve'), 'text/markdown')).toBe('# Café\n\nnaïve');
    expect(await extractText(utf8('plain'), 'text/plain')).toBe('plain');
  });

  it('extracts text from a PDF', async () => {
    const text = await extractText(
      makePdf(['Staff Engineer at Acme Corp', 'Kafka migration']),
      'application/pdf',
    );
    expect(text).toContain('Staff Engineer at Acme Corp');
    expect(text).toContain('Kafka migration');
  });

  it('returns empty text for a PDF with no text layer', async () => {
    expect(await extractText(makePdf([]), 'application/pdf')).toBe('');
  });
});
