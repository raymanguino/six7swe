import {
  PublishedProfileResponseSchema,
  type PublishedProfileResponse,
} from '@six7swe/knowledge-types';
import { getKnowledgeRetrievalConfig } from '../../config/knowledgeRetrieval';
import {
  KnowledgeServiceError,
  KnowledgeTransportError,
  requestKnowledgeJson,
  sendKnowledgeRequestForBytes,
  type FetchLike,
  type KnowledgeBytesReply,
  type KnowledgeClientConfig,
} from './transport';

/**
 * Reads what the public portfolio shows from the knowledge service (#86): the
 * published profile and the primary resume's PDF. Both are service routes, so
 * this uses `KNOWLEDGE_SERVICE_KEY`, like chat retrieval. Failures are
 * `KnowledgeServiceError`s.
 */

export interface KnowledgeProfileClient {
  getPublished(): Promise<PublishedProfileResponse>;
  /**
   * The primary resume's PDF; null when the service has none (404). A body over `maxBytes`
   * (default `RESUME_PDF_MAX_BYTES`) throws `KnowledgeBodyTooLargeError`.
   */
  getResumePdf(maxBytes?: number): Promise<Buffer | null>;
}

/** A resume is at most the service's upload limit; the private network is fast. */
export const RESUME_PDF_TIMEOUT_MS = 15_000;
export const RESUME_PDF_MAX_BYTES = 10 * 1024 * 1024;
const PDF_MIME = 'application/pdf';

export function createKnowledgeProfileClient(
  config: KnowledgeClientConfig,
  fetchFn?: FetchLike,
): KnowledgeProfileClient {
  const base = { baseUrl: config.baseUrl, key: config.key, method: 'GET' as const, fetch: fetchFn };

  return {
    async getPublished() {
      return requestKnowledgeJson(
        { ...base, path: '/profile/published', timeoutMs: config.timeoutMs },
        PublishedProfileResponseSchema,
      );
    },

    async getResumePdf(maxBytes = RESUME_PDF_MAX_BYTES) {
      const path = '/resume.pdf';
      let reply: KnowledgeBytesReply;
      try {
        reply = await sendKnowledgeRequestForBytes(
          {
            ...base,
            path,
            timeoutMs: Math.max(config.timeoutMs, RESUME_PDF_TIMEOUT_MS),
          },
          maxBytes,
        );
      } catch (error) {
        if (!(error instanceof KnowledgeTransportError)) throw error;
        throw new KnowledgeServiceError(`Knowledge service ${path} ${error.message}`, {
          cause: error,
        });
      }
      if (reply.status === 404) return null;
      if (reply.status < 200 || reply.status > 299) {
        throw new KnowledgeServiceError(`Knowledge service ${path} answered ${reply.status}`, {
          status: reply.status,
        });
      }
      if (!reply.contentType?.startsWith(PDF_MIME) || reply.bytes.length === 0) {
        throw new KnowledgeServiceError(`Knowledge service ${path} did not send a PDF`);
      }
      return reply.bytes;
    },
  };
}

let defaultClient: KnowledgeProfileClient | null | undefined;

/**
 * The process-wide client built from the environment, or null when
 * `KNOWLEDGE_URL` / `KNOWLEDGE_SERVICE_KEY` are not set.
 */
export function getDefaultProfileClient(): KnowledgeProfileClient | null {
  if (defaultClient === undefined) {
    const config = getKnowledgeRetrievalConfig();
    defaultClient = config
      ? createKnowledgeProfileClient({
          baseUrl: config.baseUrl,
          key: config.serviceKey,
          timeoutMs: config.timeoutMs,
        })
      : null;
  }
  return defaultClient;
}

/** For tests: forget the client so the next call reads the environment again. */
export function resetDefaultProfileClient(): void {
  defaultClient = undefined;
}
