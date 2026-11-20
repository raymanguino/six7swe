import { getKnowledgeRetrievalConfig } from '../../config/knowledgeRetrieval';
import {
  KnowledgeServiceError,
  KnowledgeTransportError,
  sendKnowledgeRequestForBytes,
  type FetchLike,
  type KnowledgeBytesReply,
  type KnowledgeClientConfig,
} from './transport';

/**
 * Reads the primary resume's PDF from the knowledge service, which `/resume`
 * serves. A service route, so this uses `KNOWLEDGE_SERVICE_KEY`, like chat
 * retrieval. Failures are `KnowledgeServiceError`s.
 */

export interface KnowledgeResumeClient {
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

export function createKnowledgeResumeClient(
  config: KnowledgeClientConfig,
  fetchFn?: FetchLike,
): KnowledgeResumeClient {
  return {
    async getResumePdf(maxBytes = RESUME_PDF_MAX_BYTES) {
      const path = '/resume.pdf';
      let reply: KnowledgeBytesReply;
      try {
        reply = await sendKnowledgeRequestForBytes(
          {
            baseUrl: config.baseUrl,
            key: config.key,
            method: 'GET',
            path,
            timeoutMs: Math.max(config.timeoutMs, RESUME_PDF_TIMEOUT_MS),
            fetch: fetchFn,
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

let defaultClient: KnowledgeResumeClient | null | undefined;

/**
 * The process-wide client built from the environment, or null when
 * `KNOWLEDGE_URL` / `KNOWLEDGE_SERVICE_KEY` are not set.
 */
export function getDefaultResumeClient(): KnowledgeResumeClient | null {
  if (defaultClient === undefined) {
    const config = getKnowledgeRetrievalConfig();
    defaultClient = config
      ? createKnowledgeResumeClient({
          baseUrl: config.baseUrl,
          key: config.serviceKey,
          timeoutMs: config.timeoutMs,
        })
      : null;
  }
  return defaultClient;
}

/** For tests: forget the client so the next call reads the environment again. */
export function resetDefaultResumeClient(): void {
  defaultClient = undefined;
}
