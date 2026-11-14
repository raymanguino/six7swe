import type { RetrievedChunkDto } from '@six7swe/knowledge-types';
import { getPortfolioData } from '../services/portfolioService';
import { getDefaultRetriever, type CachedRetriever } from '../services/knowledgeRetrieval';
import type { PortfolioProfileData } from '../types/portfolio';

/**
 * The stuffed context: the whole resume plus every content section. Used by
 * chat when `PORTFOLIO_DATA_SOURCE` is `db` or `mcp`, and by fitcheck.
 */
export async function getChatContext(): Promise<string> {
  const { profile, contentSections } = await getPortfolioData();

  const resumeSection = profile
    ? `Resume Information:\n${profile.fullResumeText}`
    : 'Resume Information:\n(No profile data available.)';

  if (contentSections.length === 0) {
    return resumeSection;
  }

  const additional = contentSections
    .map((s) => {
      const title = s.filename.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return `## ${title}\n\n${s.content.trim()}`;
    })
    .join('\n\n');

  return [resumeSection, '', 'Additional context:', '', additional].join('\n');
}

const MAX_SUMMARY_SKILLS = 30;
const MAX_SUMMARY_CHARS = 800;
/** Each turn is capped so the query stays well inside the service's 2000-character limit. */
const MAX_QUERY_PART_CHARS = 900;

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

export type ChatHistory = Array<{ role: string; content: string }>;

/**
 * What to retrieve for: the current question plus the last user turn, so a
 * follow-up such as "how long were you there?" still finds the right chunks.
 */
export function buildRetrievalQuery(message: string, history?: ChatHistory): string {
  const current = message.trim().slice(0, MAX_QUERY_PART_CHARS);
  const lastUser = Array.isArray(history)
    ? [...history].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')
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
}

export interface KnowledgeChatContext {
  context: string;
  /** `retrieved` when chunks were found; `profile-only` otherwise. */
  mode: 'retrieved' | 'profile-only';
  chunkCount: number;
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
      'PORTFOLIO_DATA_SOURCE=knowledge but KNOWLEDGE_SERVICE_URL or KNOWLEDGE_SERVICE_KEY is not set; answering from the profile only',
    );
  } else {
    try {
      chunks = await retriever.retrieve(buildRetrievalQuery(options.message, options.history));
    } catch (err) {
      unavailable = true;
      options.log?.warn(
        { err, source: 'knowledge' },
        'Knowledge retrieval failed; answering from the profile only',
      );
    }
  }

  if (chunks.length === 0) {
    return {
      context: [summary, '', unavailable ? PROFILE_ONLY_NOTE : NO_MATCH_NOTE].join('\n'),
      mode: 'profile-only',
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
