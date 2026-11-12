import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set on a route to skip the service key check. */
    public?: boolean;
  }
}

/** Route config for the few endpoints that need no credentials. */
export const PUBLIC_ROUTE = { config: { public: true } } as const;

export const SERVICE_KEY_HEADER = 'x-knowledge-key';

/** Compares in constant time; hashing first makes the lengths equal. */
export function keysMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface ServiceAuthOptions {
  serviceKey: string;
}

/**
 * Every route requires the shared service key unless it opts out with
 * `PUBLIC_ROUTE`, mirroring the backend's private-by-default rule.
 *
 * The key is accepted in a header only, never a query string, so it does not
 * end up in access logs or browser history.
 */
const serviceAuth: FastifyPluginAsync<ServiceAuthOptions> = async (app, options) => {
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.config.public === true) return;

    const provided = req.headers[SERVICE_KEY_HEADER];
    if (typeof provided !== 'string' || !keysMatch(provided, options.serviceKey)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
};

export default fp(serviceAuth, { name: 'service-auth' });
