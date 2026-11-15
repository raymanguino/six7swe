import fastifyRateLimit from '@fastify/rate-limit';
import { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { PUBLIC_ROUTE } from './access';

/**
 * The public `/chat` endpoint costs a model call per message, so each client
 * gets a budget (#85). A person chatting sends a few messages a minute; a
 * script hammering the endpoint gets 429s with a `retry-after`.
 */
export const CHAT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/**
 * The client's address as the proxy in front of the backend saw it.
 *
 * Railway's edge appends the connecting address to `X-Forwarded-For`, so the
 * last entry is the one it vouches for; anything before it came from the
 * client and could be forged to dodge the limit. Without the header (local
 * runs) the socket address is used. The address is only a key in the
 * limiter's in-memory window; it is never stored or logged.
 */
export function chatClientKey(req: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const header = req.headers['x-forwarded-for'];
  const joined = Array.isArray(header) ? header.join(',') : header;
  const last = joined
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .pop();
  return last ?? req.ip;
}

export interface ChatRouteOptions {
  max?: number;
  timeWindow?: string | number;
}

/**
 * Registers `POST /chat` in its own scope with the rate limiter, so the
 * limiter applies to it and nothing else.
 */
export async function registerChatRoute(
  app: FastifyInstance,
  handler: RouteHandlerMethod,
  options: ChatRouteOptions = {},
): Promise<void> {
  await app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      global: false,
      keyGenerator: chatClientKey,
      // `error` is what the chat widget shows the visitor.
      errorResponseBuilder: (_req, context) => ({
        statusCode: context.statusCode,
        error: `You're sending messages too quickly. Try again in ${context.after}.`,
      }),
    });
    scope.post(
      '/chat',
      {
        config: {
          ...PUBLIC_ROUTE.config,
          rateLimit: {
            max: options.max ?? CHAT_RATE_LIMIT.max,
            timeWindow: options.timeWindow ?? CHAT_RATE_LIMIT.timeWindow,
          },
        },
      },
      handler,
    );
  });
}
