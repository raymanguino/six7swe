import type { FastifyBaseLogger } from 'fastify';
import type { FileStore } from '../../services/storage/index.js';

/**
 * Builds a minimal, valid single-page PDF with one line of text per entry.
 * ASCII only, so string length equals byte length for the xref offsets.
 */
export function makePdf(lines: string[]): Uint8Array {
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = lines
    .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${escape(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A multipart/form-data body with a single `file` part, for `app.inject`. */
export function multipartFile(
  filename: string,
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----knowledge-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export function createMemoryFileStore(): FileStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    name: 'memory',
    files,
    async put(key, bytes) {
      files.set(key, bytes);
    },
    async get(key) {
      const bytes = files.get(key);
      if (!bytes) throw new Error(`no such file: ${key}`);
      return bytes;
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

/** A logger that discards everything. */
export const silentLogger: FastifyBaseLogger = (() => {
  const noop = () => {};
  const log = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => log,
  };
  return log;
})();

/** A fictional person; tests must not read as anyone's real history. */
export const RESUME_MD = `# Jordan Example

Senior software engineer.

## Experience

### Acme Corp — Staff Engineer (2021–2024)

Led the migration of the billing platform from a monolith to event-driven services on Kafka.
Cut invoice generation time from 6 hours to 20 minutes.

### Globex — Software Engineer (2017–2021)

Built the customer onboarding API in TypeScript and Fastify, serving 2M requests a day.

## Education

BSc Computer Science, University of Toronto.
`;

export const PROJECT_NOTES_TXT = `Side project: a retrieval-augmented portfolio assistant.

It embeds resume documents with pgvector and answers recruiter questions about past work.

The ingestion pipeline parses PDFs, chunks by headings, and embeds with text-embedding-3-small.`;
