/**
 * Route access declarations.
 *
 * Routes are private by default. A route becomes public only by explicitly
 * opting in, so adding an endpoint can never accidentally expose it to the
 * public internet. The authentication hook in `src/index.ts` reads
 * `request.routeOptions.config.public` to decide whether to enforce auth.
 */

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
