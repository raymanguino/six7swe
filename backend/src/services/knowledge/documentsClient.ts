import {
  DocumentListResponseSchema,
  DocumentTextResponseSchema,
  type DocumentDto,
} from '@six7swe/knowledge-types';
import type { z } from 'zod';
import { normalizeKnowledgeUrl } from '../../config/knowledgeUrl';
import type { KnowledgeDocumentSource } from '../../domain/chatEval';
import {
  KnowledgeTransportError,
  parseJsonBody,
  sendKnowledgeRequest,
  type FetchLike,
} from './transport';

export class KnowledgeDocumentsError extends Error {
  /** The transport failure behind it (the TS lib target has no `Error.cause`). */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
    this.name = 'KnowledgeDocumentsError';
  }
}

/**
 * Reads the knowledge service's documents and their extracted text through
 * the owner routes, with the owner key. The chat eval uses it to build the
 * judge's reference; it never writes.
 */
export function createKnowledgeDocumentClient(
  config: { baseUrl: string; ownerKey: string; timeoutMs: number },
  fetchFn?: FetchLike,
): KnowledgeDocumentSource {
  const normalized = normalizeKnowledgeUrl(config.baseUrl);
  if (normalized === null) {
    throw new KnowledgeDocumentsError('The knowledge service URL is not a valid http(s) URL');
  }
  const baseUrl: string = normalized;

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let reply;
    try {
      reply = await sendKnowledgeRequest({
        baseUrl,
        key: config.ownerKey,
        method: 'GET',
        path,
        timeoutMs: config.timeoutMs,
        fetch: fetchFn,
      });
    } catch (error) {
      if (!(error instanceof KnowledgeTransportError)) throw error;
      throw new KnowledgeDocumentsError(`Knowledge service ${path} ${error.message}`, {
        cause: error,
      });
    }
    if (reply.status < 200 || reply.status > 299) {
      throw new KnowledgeDocumentsError(`Knowledge service ${path} answered ${reply.status}`);
    }
    const body = parseJsonBody(reply.text);
    if (body === undefined) {
      throw new KnowledgeDocumentsError(`Knowledge service ${path} sent invalid JSON`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new KnowledgeDocumentsError(
        `Knowledge service ${path} response did not match the contract`,
      );
    }
    return parsed.data;
  }

  return {
    async listDocuments(): Promise<DocumentDto[]> {
      return (await get('/documents', DocumentListResponseSchema)).documents;
    },
    async getDocumentText(documentId: string): Promise<string | null> {
      const path = `/documents/${encodeURIComponent(documentId)}/text`;
      return (await get(path, DocumentTextResponseSchema)).text;
    },
  };
}
