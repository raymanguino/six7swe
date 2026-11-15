import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SearchRequestSchema, type DocumentDto } from '../contract.js';
import type { KnowledgeContext } from '../routes/context.js';
import { toChunkDto, toDocumentDto, toPrimaryResumeDto, toProfileDto } from '../routes/mappers.js';
import { listDocuments } from '../services/documents.js';
import { getPrimaryResumePdf, getPublishedView } from '../services/profile/profiles.js';
import { retrieve } from '../services/retrieval.js';

/** A resume PDF above this is not inlined: base64 in one MCP message would be too heavy. */
export const MAX_MCP_PDF_BYTES = 5 * 1024 * 1024;

export const RESUME_PDF_URI = 'knowledge://resume.pdf';

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/**
 * Builds an MCP server for one request and one owner. A thin adapter over the
 * same service functions the HTTP routes call; the owner comes from the
 * authenticated request, never from tool input.
 */
export function createMcpServer(ctx: KnowledgeContext, ownerId: string): McpServer {
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
    async ({ query, k }) => {
      const result = await retrieve(ctx, ownerId, query, k);
      return json({ version: result.version, chunks: result.chunks.map(toChunkDto) });
    },
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
    async () => {
      const { profile, resume } = await getPublishedView(ctx, ownerId);
      return json({
        profile: profile && toProfileDto(profile),
        resume: resume && toPrimaryResumeDto(resume.document, resume.text),
      });
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: "The owner's background documents with their kind and processing status.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const documents: DocumentDto[] = (await listDocuments(ctx, ownerId)).map(toDocumentDto);
      return json({ documents });
    },
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
    async () => {
      const bytes = await getPrimaryResumePdf(ctx, ownerId);
      if (!bytes) return failure('No PDF resume. Use get_profile for the resume text.');
      if (bytes.byteLength > MAX_MCP_PDF_BYTES) {
        return failure('The resume PDF is too large to return. Use get_profile for its text.');
      }
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: RESUME_PDF_URI,
              mimeType: 'application/pdf',
              blob: Buffer.from(bytes).toString('base64'),
            },
          },
        ],
      };
    },
  );

  return server;
}
