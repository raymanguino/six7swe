/**
 * Route access declarations.
 *
 * Routes are private by default. A route becomes public only by explicitly
 * opting in, so adding an endpoint can never accidentally expose it to the
 * public internet. Both read `request.routeOptions.config.public`: the auth
 * plugin (`src/plugins/auth.ts`) skips token verification for public routes,
 * and `requireAuthenticatedUser` (registered in `src/index.ts`) skips the 401
 * check. Neither acts on an unmatched URL: only a matched route is
 * authenticated, so the 404 handler answers every caller alike.
 */

import { requestContext } from '@fastify/request-context';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthenticatedUser } from '../constants';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** When true, the route is reachable without authentication. */
    public?: boolean;
  }
}

/** Marks a route as publicly reachable. */
export const PUBLIC_ROUTE = { config: { public: true } } as const;

/** Marks a route as requiring authentication. */
export const PRIVATE_ROUTE = { config: { public: false } } as const;

/**
 * The route guard, run as a `preHandler`: answers 401 unless the route is
 * public or the request context holds an authenticated user. A URL that
 * matches no route (`routeOptions.url` is undefined) is skipped so Fastify's
 * 404 handler answers it, whatever token the caller sent.
 */
export async function requireAuthenticatedUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (req.routeOptions.url === undefined) return;
  if (req.routeOptions.config.public === true) return;

  const user = requestContext.get('user');
  if (!user || user === UnauthenticatedUser) {
    reply.code(401);
    return reply.send({ error: 'Unauthorized' });
  }
}
