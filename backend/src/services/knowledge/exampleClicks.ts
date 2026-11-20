import {
  ExampleClickResponseSchema,
  isChatExampleQuestion,
  type ExampleClickRequest,
} from '@six7swe/knowledge-types';
import { getKnowledgeRetrievalConfig } from '../../config/knowledgeRetrieval';
import { requestKnowledgeJson, type FetchLike, type KnowledgeClientConfig } from './transport';

/**
 * Counts a click on one of the chat widget's example questions (#205) in the
 * knowledge service's eval set (`POST /eval/example-clicks`, a service route,
 * so `KNOWLEDGE_SERVICE_KEY`). Only an exact example text is ever sent; the
 * service checks that again. Failures are `KnowledgeServiceError`s.
 */
export interface ExampleClickClient {
  /** True when counted; false when the service has no eval question for it. */
  recordClick(question: ExampleClickRequest['question']): Promise<boolean>;
}

export function createExampleClickClient(
  config: KnowledgeClientConfig,
  fetchFn?: FetchLike,
): ExampleClickClient {
  return {
    async recordClick(question) {
      const body = await requestKnowledgeJson(
        {
          baseUrl: config.baseUrl,
          key: config.key,
          method: 'POST',
          path: '/eval/example-clicks',
          body: JSON.stringify({ question }),
          contentType: 'application/json',
          timeoutMs: config.timeoutMs,
          fetch: fetchFn,
        },
        ExampleClickResponseSchema,
      );
      return body.counted;
    },
  };
}

let defaultClient: ExampleClickClient | null | undefined;

/** Null when `KNOWLEDGE_URL` / `KNOWLEDGE_SERVICE_KEY` are not set. */
export function getDefaultExampleClickClient(): ExampleClickClient | null {
  if (defaultClient === undefined) {
    const config = getKnowledgeRetrievalConfig();
    defaultClient = config
      ? createExampleClickClient({
          baseUrl: config.baseUrl,
          key: config.serviceKey,
          timeoutMs: config.timeoutMs,
        })
      : null;
  }
  return defaultClient;
}

/** Structural logger, so a Fastify request logger fits. */
interface ClickLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Counts the click in the background when `message` is exactly an example:
 * the chat answer never waits on it, and a failure is only logged (without
 * the message, which is a fixed example anyway). Returns whether it was an
 * example, i.e. whether the caller must skip the normal eval recording.
 */
export function countExampleClick(
  message: string,
  log: ClickLogger,
  client: ExampleClickClient | null = getDefaultExampleClickClient(),
): boolean {
  if (!isChatExampleQuestion(message)) return false;
  client?.recordClick(message).catch((error: unknown) => {
    log.warn(
      { source: 'knowledge', error: error instanceof Error ? error.message : 'Unknown error' },
      'Counting a chat example click failed',
    );
  });
  return true;
}
