import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { SERVICE_KEY_HEADER } from '../contract.js';

/**
 * Who may call a route:
 * - `public`: anyone, no credentials.
 * - `service`: the portfolio and hunter backends, with the shared service key.
 * - `owner`: the knowledge base's owner. Until the owner JWT gate lands, this
 *   also takes the service key; the separate mode marks which routes move.
 */
export type RouteAccess = 'public' | 'service' | 'owner';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Defaults to `service`: a route that forgets to declare access fails closed. */
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** The owner the request acts for; set by the auth hook, null on public routes. */
    ownerId: string | null;
  }
}

export const PUBLIC_ROUTE = { config: { access: 'public' } } as const;
export const SERVICE_ROUTE = { config: { access: 'service' } } as const;
export const OWNER_ROUTE = { config: { access: 'owner' } } as const;

/** Compares in constant time; hashing first makes the lengths equal. */
export function keysMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

class UnauthorizedError extends Error {
  readonly statusCode = 401;
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** The owner the request acts for. Throws a 401 on a route that set none. */
export function requireOwner(req: FastifyRequest): string {
  if (!req.ownerId) throw new UnauthorizedError();
  return req.ownerId;
}

export interface ServiceAuthOptions {
  serviceKey: string;
  /**
   * The single owner every authenticated request acts for, until the owner
   * JWT gate derives it per request from the token's `sub`.
   */
  ownerId: string;
}

/**
 * Every route requires the shared service key unless it opts out with
 * `PUBLIC_ROUTE`, mirroring the backend's private-by-default rule.
 *
 * The key is accepted in a header only, never a query string, so it does not
 * end up in access logs or browser history.
 */
const serviceAuth: FastifyPluginAsync<ServiceAuthOptions> = async (app, options) => {
  app.decorateRequest('ownerId', null);

  app.addHook('onRequest', async (req, reply) => {
    // `config` is absent for requests that matched no route (the 404
    // handler); those fail closed like any other non-public route.
    const access: RouteAccess = req.routeOptions.config?.access ?? 'service';
    if (access === 'public') return;

    const provided = req.headers[SERVICE_KEY_HEADER];
    if (typeof provided !== 'string' || !keysMatch(provided, options.serviceKey)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    req.ownerId = options.ownerId;
  });
};

export default fp(serviceAuth, { name: 'service-auth' });
