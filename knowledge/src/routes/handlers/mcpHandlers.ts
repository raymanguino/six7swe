import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMcpServer } from '../../mcp/server.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import type { KnowledgeContext } from '../context.js';

const methodNotAllowed = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
} as const;

export function mcpHandlers(ctx: KnowledgeContext) {
  return {
    /**
     * Stateless streamable HTTP: a fresh server and transport per request, so
     * nothing (session, JSON-RPC ids) is shared between callers.
     */
    async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      const server = createMcpServer(ctx, requireOwner(req));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      // The transport writes the response itself.
      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error({ err }, 'MCP request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        }
      }
    },

    /** Stateless: there is no session to stream to or to end. */
    async notAllowed(_req: FastifyRequest, reply: FastifyReply) {
      return reply.code(405).header('allow', 'POST').send(methodNotAllowed);
    },
  };
}
