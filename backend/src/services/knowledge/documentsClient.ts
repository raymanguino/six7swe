import {
  DocumentListResponseSchema,
  DocumentTextResponseSchema,
  SERVICE_KEY_HEADER,
  type DocumentDto,
} from '@six7swe/knowledge-types';
import type { z } from 'zod';
import type { KnowledgeDocumentSource } from '../../domain/chatEval';
import type { FetchLike } from './ownerProxy';

export class KnowledgeDocumentsError extends Error {
  constructor(message: string) {
    super(message);
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
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): KnowledgeDocumentSource {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { [SERVICE_KEY_HEADER]: config.ownerKey },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw new KnowledgeDocumentsError(
        `Knowledge service ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new KnowledgeDocumentsError(`Knowledge service ${path} answered ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
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
