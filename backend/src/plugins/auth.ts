import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../constants';
import { getAuthConfig, isAuthConfigured } from '../config/auth';
import { AuthError, extractBearerToken, resolveUserFromToken } from '../services/auth/supabaseAuth';
import { findOrCreateUserByAuthId } from '../db/api/user';
import type { ContextUser } from '../types';

/**
 * Resolves the authenticated user for each request.
 *
 * The user is written into the request context, where the route guard reads
 * it. A missing or invalid token leaves the context unauthenticated rather
 * than throwing, so public routes keep working for signed-out visitors.
 */
async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const config = getAuthConfig();

    if (config.devBypass) {
      // Development-only: impersonate the seeded user so the job-hunter can
      // be exercised without a Supabase project. Never enabled in production.
      requestContext.set('user', { id: 1, email: 'john@example.com' } as ContextUser);
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
