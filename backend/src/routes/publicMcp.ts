import fastifyRateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPublicMcpConfig, type PublicMcpConfig } from '../config/publicMcp';
import { getDefaultRetrievalClient } from '../services/knowledgeRetrieval';
import { createSearchBudget } from '../services/publicMcp/dailyCap';
import { createPublicMcpServer, type PublicMcpDeps } from '../services/publicMcp/server';
import { getResumeDownload } from '../services/resumeDownload';
import { PUBLIC_ROUTE } from './access';
import { chatClientKey } from './chatRateLimit';

/**
 * The public MCP endpoint (#205), `POST /mcp/public`: stateless streamable
 * HTTP, no auth, for anyone's MCP client (`claude mcp add --transport http
 * <name> https://<backend-host>/mcp/public`). Not the knowledge service's
 * `/mcp`, which stays the owner's private server.
 *
 * Server-to-server MCP clients send no `Origin`, which CORS does not block
 * (it only adds headers for allowed browser origins), so the browser CORS
 * policy is unchanged.
 */
export const PUBLIC_MCP_PATH = '/mcp/public';

const rpcError = (code: number, message: string) =>
  ({ jsonrpc: '2.0', error: { code, message }, id: null }) as const;

export interface PublicMcpRouteOptions {
  config?: PublicMcpConfig;
  /** Replaces the knowledge clients and the budgets; tests use it. */
  deps?: Partial<Omit<PublicMcpDeps, 'log' | 'clientKey'>>;
}

export async function registerPublicMcpRoutes(
  app: FastifyInstance,
  options: PublicMcpRouteOptions = {},
): Promise<void> {
  const config = options.config ?? getPublicMcpConfig();
  const deps: Omit<PublicMcpDeps, 'log' | 'clientKey'> = {
    getRetrievalClient: getDefaultRetrievalClient,
    getResume: getResumeDownload,
    // Per process: the backend runs one replica, so these are the global budgets.
    searchBudget: createSearchBudget(config),
    ...options.deps,
  };

  /**
   * A fresh server and transport per request, so nothing (session, JSON-RPC
   * ids) is shared between callers.
   */
  async function handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const server = createPublicMcpServer({ ...deps, clientKey: chatClientKey(req), log: req.log });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // `server.close()` closes the transport it is connected to.
    reply.raw.once('close', () => {
      server.close().catch((err: unknown) => req.log.warn({ err }, 'Public MCP close failed'));
    });
    // The transport writes the response itself, so the CORS headers set on
    // `reply` (none for an MCP client without `Origin`) are copied over first.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'Public MCP request failed');
      if (reply.raw.headersSent) {
        reply.raw.end();
      } else {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal server error')));
      }
    }
  }

  /** Stateless: there is no session to stream to or to end. */
  async function notAllowed(_req: FastifyRequest, reply: FastifyReply) {
    return reply.code(405).header('allow', 'POST').send(rpcError(-32000, 'Method not allowed.'));
  }

  // Its own scope, so the limiter applies to these routes and nothing else.
  await app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      global: false,
      keyGenerator: chatClientKey,
      // A JSON-RPC error, which is what an MCP client expects to read.
      errorResponseBuilder: (_req, context) => ({
        statusCode: context.statusCode,
        ...rpcError(-32000, `Too many requests. Try again in ${context.after}.`),
      }),
    });
    const limited = {
      config: {
        ...PUBLIC_ROUTE.config,
        rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindowMs },
      },
    };
    scope.post(PUBLIC_MCP_PATH, limited, handle);
    scope.get(PUBLIC_MCP_PATH, limited, notAllowed);
    scope.delete(PUBLIC_MCP_PATH, limited, notAllowed);
  });
}
