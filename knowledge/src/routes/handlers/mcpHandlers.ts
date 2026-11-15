import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMcpServer } from '../../mcp/server.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import type { KnowledgeContext } from '../context.js';

const rpcError = (code: number, message: string) =>
  ({ jsonrpc: '2.0', error: { code, message }, id: null }) as const;

export function mcpHandlers(ctx: KnowledgeContext) {
  return {
    /**
     * Stateless streamable HTTP: a fresh server and transport per request, so
     * nothing (session, JSON-RPC ids) is shared between callers.
     */
    async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      const server = createMcpServer(ctx, requireOwner(req), {
        log: req.log,
        maxPdfBytes: ctx.mcpMaxPdfBytes,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      // `server.close()` closes the transport it is connected to.
      reply.raw.once('close', () => {
        server.close().catch((err: unknown) => req.log.warn({ err }, 'MCP close failed'));
      });
      // The transport writes the response itself.
      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error({ err }, 'MCP request failed');
        if (reply.raw.headersSent) {
          reply.raw.end();
        } else {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal server error')));
        }
      }
    },

    /** Stateless: there is no session to stream to or to end. */
    async notAllowed(_req: FastifyRequest, reply: FastifyReply) {
      return reply.code(405).header('allow', 'POST').send(rpcError(-32000, 'Method not allowed.'));
    },
  };
}
