import {
  PublishedProfileResponseSchema,
  type PublishedProfileResponse,
} from '@six7swe/knowledge-types';
import {
  getKnowledgeRetrievalConfig,
  type KnowledgeRetrievalConfig,
} from '../../config/knowledgeRetrieval';
import {
  KnowledgeTransportError,
  parseJsonBody,
  sendKnowledgeRequest,
  sendKnowledgeRequestForBytes,
  type FetchLike,
} from './transport';

/**
 * Reads what the public portfolio shows from the knowledge service (#86): the
 * published profile and the primary resume's PDF. Both are service routes, so
 * this uses `KNOWLEDGE_SERVICE_KEY`, like chat retrieval.
 */

export class KnowledgeProfileError extends Error {
  /** The HTTP status, when the service answered with one. */
  readonly status: number | undefined;
  /** The transport failure behind it (the TS lib target has no `Error.cause`). */
  readonly cause?: unknown;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'KnowledgeProfileError';
    this.status = options?.status;
    this.cause = options?.cause;
  }
}

export interface KnowledgeProfileClient {
  getPublished(): Promise<PublishedProfileResponse>;
  /** The primary resume's PDF; null when the service has none (404). */
  getResumePdf(): Promise<Buffer | null>;
}

/** A resume is at most the service's upload limit; the private network is fast. */
export const RESUME_PDF_TIMEOUT_MS = 15_000;
const PDF_MIME = 'application/pdf';

function transportFailure(path: string, error: unknown): never {
  if (!(error instanceof KnowledgeTransportError)) throw error;
  throw new KnowledgeProfileError(`Knowledge service ${path} ${error.message}`, { cause: error });
}

export function createKnowledgeProfileClient(
  config: Pick<KnowledgeRetrievalConfig, 'baseUrl' | 'serviceKey' | 'timeoutMs'>,
  fetchFn?: FetchLike,
): KnowledgeProfileClient {
  const request = (path: string, timeoutMs: number) => ({
    baseUrl: config.baseUrl,
    key: config.serviceKey,
    method: 'GET' as const,
    path,
    timeoutMs,
    fetch: fetchFn,
  });

  return {
    async getPublished() {
      const path = '/profile/published';
      let reply;
      try {
        reply = await sendKnowledgeRequest(request(path, config.timeoutMs));
      } catch (error) {
        transportFailure(path, error);
      }
      if (reply.status < 200 || reply.status > 299) {
        throw new KnowledgeProfileError(`Knowledge service ${path} answered ${reply.status}`, {
          status: reply.status,
        });
      }
      const parsed = PublishedProfileResponseSchema.safeParse(parseJsonBody(reply.text));
      if (!parsed.success) {
        throw new KnowledgeProfileError(
          `Knowledge service ${path} response did not match the contract`,
        );
      }
      return parsed.data;
    },

    async getResumePdf() {
      const path = '/resume.pdf';
      let reply;
      try {
        reply = await sendKnowledgeRequestForBytes(
          request(path, Math.max(config.timeoutMs, RESUME_PDF_TIMEOUT_MS)),
        );
      } catch (error) {
        transportFailure(path, error);
      }
      if (reply.status === 404) return null;
      if (reply.status < 200 || reply.status > 299) {
        throw new KnowledgeProfileError(`Knowledge service ${path} answered ${reply.status}`, {
          status: reply.status,
        });
      }
      if (!reply.contentType?.startsWith(PDF_MIME) || reply.bytes.length === 0) {
        throw new KnowledgeProfileError(`Knowledge service ${path} did not send a PDF`);
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
    defaultClient = config ? createKnowledgeProfileClient(config) : null;
  }
  return defaultClient;
}

/** For tests: forget the client so the next call reads the environment again. */
export function resetDefaultProfileClient(): void {
  defaultClient = undefined;
}
