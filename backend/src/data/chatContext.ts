import { MAX_RETRIEVE_QUERY_CHARS, type RetrievedChunkDto } from '@six7swe/knowledge-types';
import {
  getDefaultRetriever,
  KnowledgeRetrievalError,
  toRetrieveQuery,
  type CachedRetriever,
  type RecordQuestion,
} from '../services/knowledgeRetrieval';

/**
 * The background chat and fitcheck answer from: the chunks the knowledge
 * service retrieves for the question (chat) or the job description
 * (fitcheck). Retrieval is the only source of background; there is no
 * stuffed resume or profile to fall back on.
 */

/** Each of the two turns gets just under half, so the joined query fits the service's limit. */
const MAX_QUERY_PART_CHARS = Math.floor((MAX_RETRIEVE_QUERY_CHARS - 1) / 2);

export type ChatRole = 'user' | 'assistant';
export type ChatHistory = Array<{ role: ChatRole; content: string }>;

/**
 * What to retrieve for: the current question plus the last user turn, so a
 * follow-up such as "how long were you there?" still finds the right chunks.
 */
export function buildRetrievalQuery(message: string, history?: ChatHistory): string {
  const current = message.trim().slice(0, MAX_QUERY_PART_CHARS);
  const lastUser = Array.isArray(history)
    ? [...history].reverse().find((m) => m.role === 'user')
    : undefined;
  const previous = lastUser?.content.trim().slice(0, MAX_QUERY_PART_CHARS);
  if (!previous || previous === current) return current;
  return `${previous}\n${current}`;
}

export function formatRetrievedChunks(chunks: readonly RetrievedChunkDto[]): string {
  return chunks
    .map((chunk, i) => {
      const source = chunk.heading ? `${chunk.filename} > ${chunk.heading}` : chunk.filename;
      return `[${i + 1}] ${source}\n${chunk.content.trim()}`;
    })
    .join('\n\n');
}

/** Structural so a Fastify request logger fits, and tests can pass a stub. */
export interface ContextLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface KnowledgeChatContextOptions {
  message: string;
  history?: ChatHistory;
  /** Defaults to the retriever built from the environment. */
  retriever?: CachedRetriever | null;
  log?: ContextLogger;
  /**
   * The visitor's random per-session id. With it, the question is recorded
   * for the knowledge service's evolving eval set (#85).
   */
  sessionId?: string;
}

/**
 * What to ask the service to record. Only a standalone question is: the
 * service stores the query, and a follow-up's query carries the previous
 * turn too, which is history, not the visitor's current question.
 */
export function recordFor(
  query: string,
  options: Pick<KnowledgeChatContextOptions, 'message' | 'sessionId'>,
): RecordQuestion | undefined {
  if (!options.sessionId || query !== options.message.trim()) return undefined;
  return { sessionId: options.sessionId };
}

/**
 * `retrieved` when chunks were found. `no-background` otherwise, with why:
 * `unavailable` (the service failed or is not configured, an outage) or
 * `no-match` (the service answered, but nothing matched).
 */
export type KnowledgeChatContext =
  | { mode: 'retrieved'; context: string; chunkCount: number }
  | {
      mode: 'no-background';
      reason: 'unavailable' | 'no-match';
      context: string;
      chunkCount: 0;
    };

/** The error fields worth logging: no raw cause objects, which can carry request details. */
function describeError(err: unknown): { message: string; status?: number } {
  if (err instanceof KnowledgeRetrievalError && err.status !== undefined) {
    return { message: err.message, status: err.status };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

export const UNAVAILABLE_NOTE =
  "Ray's background documents are unavailable right now. Do not guess at his background: " +
  'say briefly that you cannot look it up at the moment, and suggest the visitor ask again later or get in touch.';

export const NO_MATCH_NOTE =
  "None of Ray's background documents matched this question. If it asks about his background, " +
  'say briefly that you do not have details on that.';

/**
 * Retrieves for `query` and renders the chunks under `heading`. A failure (or
 * a service that is not configured) is logged and reported as `unavailable`,
 * never thrown: the caller decides what an outage means for it.
 */
async function retrieveContext(
  query: string,
  options: {
    retriever?: CachedRetriever | null;
    log?: ContextLogger;
    record?: RecordQuestion;
    heading: string;
  },
): Promise<KnowledgeChatContext> {
  const retriever = options.retriever === undefined ? getDefaultRetriever() : options.retriever;

  let chunks: RetrievedChunkDto[] = [];
  let unavailable = false;
  if (!retriever) {
    unavailable = true;
    options.log?.warn(
      { source: 'knowledge' },
      'KNOWLEDGE_URL or KNOWLEDGE_SERVICE_KEY is not set; answering without background',
    );
  } else {
    try {
      chunks = await (options.record
        ? retriever.retrieve(query, { record: options.record })
        : retriever.retrieve(query));
    } catch (err) {
      unavailable = true;
      options.log?.warn(
        { source: 'knowledge', error: describeError(err) },
        'Knowledge retrieval failed; answering without background',
      );
    }
  }

  if (chunks.length === 0) {
    return {
      context: unavailable ? UNAVAILABLE_NOTE : NO_MATCH_NOTE,
      mode: 'no-background',
      reason: unavailable ? 'unavailable' : 'no-match',
      chunkCount: 0,
    };
  }

  return {
    context: [options.heading, '', formatRetrievedChunks(chunks)].join('\n'),
    mode: 'retrieved',
    chunkCount: chunks.length,
  };
}

/**
 * Chat's context: the top-k chunks for this question (and the previous user
 * turn). If retrieval fails or is not configured, chat still answers, with a
 * note that says the background is unavailable, rather than failing.
 *
 * The retriever caches by `(corpus version, question)` and re-reads the
 * version at most every 30 s, so an upload or delete reaches chat within
 * that window on every replica, without a restart or a cache bust.
 */
export async function getKnowledgeChatContext(
  options: KnowledgeChatContextOptions,
): Promise<KnowledgeChatContext> {
  const query = buildRetrievalQuery(options.message, options.history);
  return retrieveContext(query, {
    retriever: options.retriever,
    log: options.log,
    record: recordFor(query, options),
    heading: 'Relevant excerpts from my background documents (retrieved for this question):',
  });
}

export interface FitcheckContextOptions {
  jobDescription: string;
  /** Defaults to the retriever built from the environment. */
  retriever?: CachedRetriever | null;
  log?: ContextLogger;
}

/**
 * Fitcheck's context: the chunks most relevant to the job description, the
 * way job matching retrieves (`services/jobHunt/knowledgeSource.ts`). Never
 * recorded for the eval set: a job description is not a visitor question.
 */
export async function getFitcheckContext(
  options: FitcheckContextOptions,
): Promise<KnowledgeChatContext> {
  return retrieveContext(toRetrieveQuery(options.jobDescription), {
    retriever: options.retriever,
    log: options.log,
    heading: 'Excerpts from my background documents most relevant to this job:',
  });
}
