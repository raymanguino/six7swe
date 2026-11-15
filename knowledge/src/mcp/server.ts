import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger } from 'fastify';
import { SearchRequestSchema } from '../contract.js';
import type { KnowledgeContext } from '../routes/context.js';
import {
  toDocumentDto,
  toPrimaryResumeDto,
  toProfileDto,
  toRetrieveResponse,
} from '../routes/mappers.js';
import { listDocuments } from '../services/documents.js';
import { findPrimaryResumePdf, getPublishedView } from '../services/profile/profiles.js';
import { retrieve } from '../services/retrieval.js';

/** A resume PDF above this is not inlined: base64 in one MCP message would be too heavy. */
export const MAX_MCP_PDF_BYTES = 5 * 1024 * 1024;

export const RESUME_PDF_URI = 'knowledge://resume.pdf';

export interface McpServerOptions {
  log: FastifyBaseLogger;
  /** Largest resume PDF `get_resume_pdf` returns. */
  maxPdfBytes?: number;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/**
 * Runs a tool, logging anything it throws and answering with a generic
 * message, so SQL, storage paths and provider errors never reach the client.
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
      log.error({ err, tool }, 'MCP tool failed');
      return failure('Internal error. Try again.');
    }
  };
}

/**
 * Builds an MCP server for one request and one owner. A thin adapter over the
 * same service functions the HTTP routes call; the owner comes from the
 * authenticated request, never from tool input.
 */
export function createMcpServer(
  ctx: KnowledgeContext,
  ownerId: string,
  options: McpServerOptions,
): McpServer {
  const { log, maxPdfBytes = MAX_MCP_PDF_BYTES } = options;
  const server = new McpServer({ name: 'six7swe-knowledge', version: '0.1.0' });

  server.registerTool(
    'search_background',
    {
      title: 'Search background',
      description:
        "Semantic search over the owner's background documents (resume, projects, notes). " +
        'Returns the most relevant passages with their source file and similarity.',
      inputSchema: SearchRequestSchema.shape,
      annotations: { readOnlyHint: true },
    },
    guarded(log, 'search_background', async ({ query, k }) =>
      json(toRetrieveResponse(await retrieve(ctx, ownerId, query, k))),
    ),
  );

  server.registerTool(
    'get_profile',
    {
      title: 'Get profile',
      description:
        "The owner's published structured profile (experience, projects, links) and the " +
        'primary resume text, if any.',
      annotations: { readOnlyHint: true },
    },
    guarded(log, 'get_profile', async () => {
      const { profile, resume } = await getPublishedView(ctx, ownerId);
      return json({
        profile: profile && toProfileDto(profile),
        resume: resume && toPrimaryResumeDto(resume.document, resume.text),
      });
    }),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: "The owner's background documents with their kind and processing status.",
      annotations: { readOnlyHint: true },
    },
    guarded(log, 'list_documents', async () =>
      json({ documents: (await listDocuments(ctx, ownerId)).map(toDocumentDto) }),
    ),
  );

  server.registerTool(
    'get_resume_pdf',
    {
      title: 'Get resume PDF',
      description:
        "The owner's primary resume as a PDF, returned as an embedded resource " +
        '(base64 blob, application/pdf).',
      annotations: { readOnlyHint: true },
    },
    guarded(log, 'get_resume_pdf', async () => {
      const found = await findPrimaryResumePdf(ctx, ownerId, maxPdfBytes);
      if (found.status === 'none') {
        return failure('No PDF resume. Use get_profile for the resume text.');
      }
      if (found.status === 'too-large') {
        return failure('The resume PDF is too large to return. Use get_profile for its text.');
      }
      const { bytes } = found;
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: RESUME_PDF_URI,
              mimeType: 'application/pdf',
              blob: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                'base64',
              ),
            },
          },
        ],
      };
    }),
  );

  return server;
}
