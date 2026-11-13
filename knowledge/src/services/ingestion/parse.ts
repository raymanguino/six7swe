import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';

/** The file types the knowledge base accepts. */
export const SUPPORTED_MIME_TYPES = ['application/pdf', 'text/markdown', 'text/plain'] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export function isSupportedMime(mime: string): mime is SupportedMimeType {
  return SUPPORTED_MIME_TYPES.some((supported) => supported === mime);
}

const EXTENSION_TO_MIME: Record<string, SupportedMimeType> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
};

export class UnsupportedFileError extends Error {
  readonly statusCode = 415;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Decides the type from the extension, then checks the bytes agree.
 *
 * The client's Content-Type is not trusted: browsers report `.md` files
 * inconsistently, and the extension plus a content check is what matters.
 */
export function detectMimeType(filename: string, bytes: Uint8Array): SupportedMimeType {
  const ext = extensionOf(filename);
  const mime = EXTENSION_TO_MIME[ext];
  if (!mime) {
    throw new UnsupportedFileError(
      `Unsupported file type "${ext || '(none)'}". Upload a .pdf, .md or .txt file.`,
    );
  }

  if (mime === 'application/pdf') {
    if (!startsWithPdfMagic(bytes)) {
      throw new UnsupportedFileError(`${filename} has a .pdf extension but is not a PDF.`);
    }
    return mime;
  }

  // A text file with NUL bytes in it is almost certainly binary.
  if (bytes.includes(0)) {
    throw new UnsupportedFileError(`${filename} does not look like a text file.`);
  }
  return mime;
}

/**
 * Cleans extracted text into a stable form for chunking: LF line endings,
 * no BOM or control characters, no trailing spaces, at most one blank line.
 */
export function normalizeText(text: string): string {
  return (
    text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      // Control characters other than tab and newline.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Extracts plain text from a supported file. */
export async function extractText(bytes: Uint8Array, mime: SupportedMimeType): Promise<string> {
  if (mime === 'application/pdf') {
    // pdf.js takes ownership of the buffer it is given, so pass a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const { text } = await extractPdfText(pdf, { mergePages: true });
      return normalizeText(text);
    } finally {
      // destroy() (not cleanup(), which only drops caches) releases the
      // document and its worker-side state. The typings expose it on the
      // loading task; PDFDocumentProxy.destroy() is the same call.
      await pdf.loadingTask.destroy();
    }
  }

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return normalizeText(decoded);
}
