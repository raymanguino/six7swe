import { MAX_RETRIEVE_QUERY_CHARS, type RetrievedChunkDto } from '@six7swe/knowledge-types';
import { getPortfolioData } from '../services/portfolioService';
import {
  getDefaultRetriever,
  KnowledgeRetrievalError,
  type CachedRetriever,
  type RecordQuestion,
} from '../services/knowledgeRetrieval';
import type { PortfolioProfileData } from '../types/portfolio';

/**
 * The whole resume text, for fitcheck. The supporting documents are not
 * stuffed in: they live in the knowledge service and reach chat through
 * retrieval.
 */
export async function getChatContext(): Promise<string> {
  const { profile } = await getPortfolioData();
  return `Resume Information:\n${profile ? profile.fullResumeText : '(No profile data available.)'}`;
}

const MAX_SUMMARY_SKILLS = 30;
const MAX_SUMMARY_CHARS = 800;
/** Each of the two turns gets just under half, so the joined query fits the service's limit. */
const MAX_QUERY_PART_CHARS = Math.floor((MAX_RETRIEVE_QUERY_CHARS - 1) / 2);

/**
 * A compact profile: who, what, where, the summary, the skills and one line
 * per role. It grounds every answer, including when retrieval is down.
 */
export function buildProfileSummary(profile: PortfolioProfileData | null): string {
  if (!profile) return 'Profile summary:\n(No profile data available.)';

  const lines = [`Profile summary:`, `Name: ${profile.name}`, `Title: ${profile.title}`];
  if (profile.location) lines.push(`Location: ${profile.location}`);
  if (profile.summary) {
    const summary = profile.summary.trim();
    lines.push(
      `Summary: ${summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary}`,
    );
  }
  if (profile.skills.length > 0) {
    lines.push(`Skills: ${profile.skills.slice(0, MAX_SUMMARY_SKILLS).join(', ')}`);
  }
  if (profile.experience.length > 0) {
    lines.push('Roles:');
    for (const role of profile.experience) {
      lines.push(`- ${role.title}, ${role.company} (${role.period})`);
    }
  }
  return lines.join('\n');
}

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

export function formatRetrievedChunks(chunks: RetrievedChunkDto[]): string {
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
 * `retrieved` when chunks were found. `profile-only` otherwise, with why:
 * `unavailable` (the service failed or is not configured, an outage) or
 * `no-match` (the service answered, but nothing matched).
 */
export type KnowledgeChatContext =
  | { mode: 'retrieved'; context: string; chunkCount: number }
  | { mode: 'profile-only'; reason: 'unavailable' | 'no-match'; context: string; chunkCount: 0 };

/** The error fields worth logging: no raw cause objects, which can carry request details. */
function describeError(err: unknown): { message: string; status?: number } {
  if (err instanceof KnowledgeRetrievalError && err.status !== undefined) {
    return { message: err.message, status: err.status };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

const PROFILE_ONLY_NOTE =
  'Detailed background documents are unavailable right now. Answer from the profile summary above; ' +
  'if the question needs details it does not cover, say so briefly and suggest the visitor ask again later or get in touch.';

const NO_MATCH_NOTE =
  'No background documents matched this question. Answer from the profile summary above; ' +
  'if it does not cover the question, say so briefly.';

/**
 * The retrieved context: a compact profile summary plus the top-k chunks for
 * this question. If retrieval fails (or is not configured), chat still
 * answers from the profile summary alone rather than failing.
 */
export async function getKnowledgeChatContext(
  options: KnowledgeChatContextOptions,
): Promise<KnowledgeChatContext> {
  const { profile } = await getPortfolioData();
  const summary = buildProfileSummary(profile);
  const retriever = options.retriever === undefined ? getDefaultRetriever() : options.retriever;

  let chunks: RetrievedChunkDto[] = [];
  let unavailable = false;
  if (!retriever) {
    unavailable = true;
    options.log?.warn(
      { source: 'knowledge' },
      'KNOWLEDGE_URL or KNOWLEDGE_SERVICE_KEY is not set; answering from the profile only',
    );
  } else {
    try {
      const query = buildRetrievalQuery(options.message, options.history);
      const record = recordFor(query, options);
      chunks = await (record ? retriever.retrieve(query, { record }) : retriever.retrieve(query));
    } catch (err) {
      unavailable = true;
      options.log?.warn(
        { source: 'knowledge', error: describeError(err) },
        'Knowledge retrieval failed; answering from the profile only',
      );
    }
  }

  if (chunks.length === 0) {
    return {
      context: [summary, '', unavailable ? PROFILE_ONLY_NOTE : NO_MATCH_NOTE].join('\n'),
      mode: 'profile-only',
      reason: unavailable ? 'unavailable' : 'no-match',
      chunkCount: 0,
    };
  }

  return {
    context: [
      summary,
      '',
      'Relevant excerpts from my background documents (retrieved for this question):',
      '',
      formatRetrievedChunks(chunks),
    ].join('\n'),
    mode: 'retrieved',
    chunkCount: chunks.length,
  };
}
