import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { SERVICE_KEY_HEADER } from '../contract.js';
import { isSafeKeySegment } from '../lib/storageKeys.js';

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

/**
 * Decides whether a request may use a route, and for which owner. Returns
 * the owner id, or null to reject with 401.
 */
export type Authenticator = (req: FastifyRequest) => string | null | Promise<string | null>;

/** One authenticator per non-public access mode. */
export type Authenticators = Record<Exclude<RouteAccess, 'public'>, Authenticator>;

/**
 * Accepts the shared service key from its header (never a query string, so
 * it does not end up in access logs or browser history) and acts for the
 * single configured owner.
 */
export function serviceKeyAuthenticator(serviceKey: string, ownerId: string): Authenticator {
  return (req) => {
    const provided = req.headers[SERVICE_KEY_HEADER];
    return typeof provided === 'string' && keysMatch(provided, serviceKey) ? ownerId : null;
  };
}

export interface ServiceAuthOptions {
  serviceKey: string;
  /**
   * The single owner every authenticated request acts for, until the owner
   * JWT gate derives it per request from the token's `sub`.
   */
  ownerId: string;
  /**
   * Overrides per access mode. Step 2 replaces `owner` with the JWT check;
   * `service` keeps the key.
   */
  authenticators?: Partial<Authenticators>;
}

/**
 * Every route requires credentials unless it opts out with `PUBLIC_ROUTE`,
 * mirroring the backend's private-by-default rule. Which credentials depends
 * on the route's access mode; today both modes take the service key.
 */
const serviceAuth: FastifyPluginAsync<ServiceAuthOptions> = async (app, options) => {
  const byKey = serviceKeyAuthenticator(options.serviceKey, options.ownerId);
  const authenticators: Authenticators = {
    service: byKey,
    owner: byKey,
    ...options.authenticators,
  };

  app.decorateRequest('ownerId', null);

  app.addHook('onRequest', async (req, reply) => {
    // `config` is absent for requests that matched no route (the 404
    // handler); those fail closed like any other non-public route.
    const access: RouteAccess = req.routeOptions.config?.access ?? 'service';
    if (access === 'public') return;

    const ownerId = await authenticators[access](req);
    // The owner id becomes a storage-key segment, whatever produced it.
    if (!ownerId || !isSafeKeySegment(ownerId)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    req.ownerId = ownerId;
  });
};

export default fp(serviceAuth, { name: 'service-auth' });
