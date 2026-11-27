import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../constants';
import { getAuthConfig, isAuthConfigured } from '../config/auth';
import { AuthError, extractBearerToken, resolveUserFromToken } from '../services/auth/supabaseAuth';
import { findOrCreateUserByAuthId } from '../db/api/user';
import type { ContextUser } from '../types';

/**
 * The identity the development bypass impersonates.
 *
 * The row is created on demand so a freshly reset database is usable
 * without seeding: profiles reference a user, so a missing row would make
 * every write fail on the foreign key.
 */
const DEV_AUTH_ID = 'auth-dev-bypass';
const DEV_EMAIL = 'dev@localhost';

let devUser: Promise<ContextUser> | null = null;

/**
 * Returns the local user the development bypass acts as.
 *
 * The result is cached for the life of the process so the lookup happens
 * once rather than on every request.
 */
async function resolveDevUser(): Promise<ContextUser> {
  if (!devUser) {
    devUser = findOrCreateUserByAuthId({ authId: DEV_AUTH_ID, email: DEV_EMAIL })
      .then((user) => ({
        id: user.id,
        email: user.email,
        authId: user.authId ?? DEV_AUTH_ID,
      }))
      .catch((error: unknown) => {
        // Do not cache a failure: the database may not be up yet.
        devUser = null;
        throw error;
      });
  }
  return devUser;
}

/**
 * Resolves the authenticated user for each request.
 *
 * The user is written into the request context, where the route guard in
 * `src/index.ts` reads it. Public routes and unmatched URLs always get the
 * unauthenticated user. On private routes a missing or invalid token also
 * leaves the context unauthenticated, and the guard answers 401; other
 * failures, such as a database error, propagate as a 500.
 */
async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    // Public routes get no identity: the token is neither verified nor used to
    // create a user row. A public handler must not read the request-context
    // user; it always sees UnauthenticatedUser. An unmatched URL has no
    // `routeOptions.url` and ends in a 404, so it needs no identity either.
    if (req.routeOptions.url === undefined || req.routeOptions.config?.public === true) {
      requestContext.set('user', UnauthenticatedUser);
      return;
    }

    const config = getAuthConfig();

    if (config.devBypass) {
      // Development-only: impersonate a local user so the job-hunter can
      // be exercised without a Supabase project. Never enabled in production.
      requestContext.set('user', await resolveDevUser());
      return;
    }

    if (!isAuthConfigured()) {
      requestContext.set('user', UnauthenticatedUser);
      return;
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      requestContext.set('user', UnauthenticatedUser);
      return;
    }

    try {
      const identity = await resolveUserFromToken(token);

      if (identity.authId) {
        const user = await findOrCreateUserByAuthId({
          authId: identity.authId,
          email: identity.email,
        });

        requestContext.set('user', {
          id: user.id,
          email: user.email,
          authId: user.authId ?? identity.authId,
        } satisfies ContextUser);
        return;
      }

      requestContext.set('user', identity);
    } catch (error) {
      if (error instanceof AuthError) {
        req.log.warn({ err: error }, 'Rejected invalid access token');
        requestContext.set('user', UnauthenticatedUser);
        return;
      }
      throw error;
    }
  });
}

export default fp(authPlugin, { name: 'auth', dependencies: [] });
