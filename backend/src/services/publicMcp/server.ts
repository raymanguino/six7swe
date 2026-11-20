import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_RETRIEVE_QUERY_CHARS, type RetrievedChunkDto } from '@six7swe/knowledge-types';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { RetrievalClient } from '../knowledgeRetrieval';
import type { ResumeDownload } from '../resumeDownload';
import type { DailyCap } from './dailyCap';

/**
 * The public MCP server (#205): anyone's MCP client can search the owner's
 * background and fetch the resume. Everything in the corpus is meant to be
 * public, and the risk scan (#212) holds back anything flagged until the owner
 * approves it. Only two read-only tools; the backend reaches the knowledge
 * service with the service key alone, never an owner route.
 */

/** Chunks a search returns by default, and at most (below the service's 20). */
export const PUBLIC_SEARCH_DEFAULT_K = 6;
export const PUBLIC_SEARCH_MAX_K = 8;

/** A resume PDF above this is not inlined: base64 in one MCP message would be too heavy. */
export const PUBLIC_MCP_MAX_PDF_BYTES = 5 * 1024 * 1024;

export const RESUME_PDF_URI = 'six7swe://resume.pdf';

export const PUBLIC_MCP_TOOLS = ['search_background', 'get_resume_pdf'] as const;

export const GENERIC_ERROR = 'Internal error. Try again.';
export const DAILY_CAP_ERROR =
  'The daily search limit for this server has been reached. Try again after 00:00 UTC.';
export const NO_RESUME_ERROR = 'No PDF resume is available. Use search_background for its content.';
export const RESUME_TOO_LARGE_ERROR =
  'The resume PDF is too large to return. Use search_background for its content.';

export interface PublicMcpDeps {
  /** Null when the knowledge service is not configured: every tool then fails generically. */
  getRetrievalClient(): Pick<RetrievalClient, 'retrieve'> | null;
  /** The same cached download `/resume` serves. */
  getResume(log: FastifyBaseLogger): Promise<ResumeDownload>;
  /** The global daily budget of `search_background` calls. */
  dailySearchCap: DailyCap;
  log: FastifyBaseLogger;
  /** A fresh random eval-set session id per search; tests pin it. */
  newSessionId?: () => string;
  maxPdfBytes?: number;
}

const SearchInput = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_RETRIEVE_QUERY_CHARS)
    .describe('A question or topic about the owner, e.g. "experience with distributed systems".'),
  k: z
    .number()
    .int()
    .min(1)
    .max(PUBLIC_SEARCH_MAX_K)
    .default(PUBLIC_SEARCH_DEFAULT_K)
    .describe(`How many passages to return (1 to ${PUBLIC_SEARCH_MAX_K}).`),
};

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/**
 * Runs a tool, logging anything it throws and answering with a generic
 * message, so upstream URLs, statuses and errors never reach the client.
 */
function guarded<A extends unknown[]>(
  log: FastifyBaseLogger,
  tool: string,
  run: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await run(...args);
    } catch (err) {
      log.error({ err, tool }, 'Public MCP tool failed');
      return failure(GENERIC_ERROR);
    }
  };
}

/** What a public client sees of a chunk: no internal ids. */
const toPublicChunk = (chunk: RetrievedChunkDto) => ({
  source: chunk.filename,
  heading: chunk.heading,
  content: chunk.content,
  similarity: Math.round(chunk.similarity * 10_000) / 10_000,
});

/** A fresh server for one request; nothing is shared between callers. */
export function createPublicMcpServer(deps: PublicMcpDeps): McpServer {
  const { log, dailySearchCap } = deps;
  const newSessionId = deps.newSessionId ?? randomUUID;
  const maxPdfBytes = deps.maxPdfBytes ?? PUBLIC_MCP_MAX_PDF_BYTES;
  const server = new McpServer({ name: 'six7swe-background', version: '0.1.0' });

  server.registerTool(
    'search_background',
    {
      title: 'Search background',
      description:
        "Semantic search over Ray Manguino's professional background: resume, projects and " +
        'notes. Returns the most relevant passages with their source file and similarity.',
      inputSchema: SearchInput,
      annotations: { readOnlyHint: true },
    },
    guarded(log, 'search_background', async ({ query, k }) => {
      const client = deps.getRetrievalClient();
      if (!client) throw new Error('The knowledge service is not configured');
      if (!dailySearchCap.tryTake()) {
        log.warn('Public MCP daily search cap reached');
        return failure(DAILY_CAP_ERROR);
      }
      // Recorded for the eval set as its own session: each MCP question counts once.
      const result = await client.retrieve(query, k, { sessionId: newSessionId() });
      return json({ chunks: result.chunks.slice(0, k).map(toPublicChunk) });
    }),
  );

  server.registerTool(
    'get_resume_pdf',
    {
      title: 'Get resume PDF',
      description:
        "Ray Manguino's resume as a PDF, returned as an embedded resource " +
        '(base64 blob, application/pdf).',
      annotations: { readOnlyHint: true },
    },
    guarded(log, 'get_resume_pdf', async () => {
      const resume = await deps.getResume(log);
      if (!resume.found) return failure(NO_RESUME_ERROR);
      if (resume.body.length > maxPdfBytes) return failure(RESUME_TOO_LARGE_ERROR);
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: RESUME_PDF_URI,
              mimeType: 'application/pdf',
              blob: resume.body.toString('base64'),
            },
          },
        ],
      };
    }),
  );

  return server;
}
