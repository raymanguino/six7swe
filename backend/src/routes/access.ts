/**
 * Route access declarations.
 *
 * Routes are private by default. A route becomes public only by explicitly
 * opting in, so adding an endpoint can never accidentally expose it to the
 * public internet. Both read `request.routeOptions.config.public`: the auth
 * plugin (`src/plugins/auth.ts`) skips token verification for public routes,
 * and the preHandler in `src/index.ts` skips the 401 check.
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
