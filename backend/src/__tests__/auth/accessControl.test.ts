import Fastify, { FastifyInstance } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import { PUBLIC_ROUTE, PRIVATE_ROUTE } from '../../routes/access';
import { extractBearerToken, resolveUserFromToken } from '../../services/auth/supabaseAuth';

/**
 * Verifies the access-control contract: routes are private unless they
 * explicitly opt out, and the opt-out is read from the registered route.
 */
describe('route access control', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(fastifyRequestContext, {
      defaultStoreValues: { user: UnauthenticatedUser },
    });

    // Stands in for the real auth plugin: no token means unauthenticated.
    app.addHook('onRequest', async () => {
      requestContext.set('user', UnauthenticatedUser);
    });

    app.addHook('preHandler', async (req, reply) => {
      const { public: isPublic } = req.routeOptions.config;
      if (isPublic === true) return;
      const user = requestContext.get('user');
      if (!user || user === UnauthenticatedUser) {
        reply.code(401);
        return reply.send({ error: 'Unauthorized' });
      }
    });

    app.get('/public-thing', PUBLIC_ROUTE, async () => ({ ok: true }));
    app.get('/private-thing', PRIVATE_ROUTE, async () => ({ ok: true }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows a public route without a user', async () => {
    const response = await app.inject({ method: 'GET', url: '/public-thing' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a private route without a user', async () => {
    const response = await app.inject({ method: 'GET', url: '/private-thing' });
    expect(response.statusCode).toBe(401);
  });

  it('allows a private route once a user is present', async () => {
    app.addHook('onRequest', async () => {
      requestContext.set('user', { id: 7, email: 'user@example.com' });
    });

    const response = await app.inject({ method: 'GET', url: '/private-thing' });
    expect(response.statusCode).toBe(200);
  });
});

describe('extractBearerToken', () => {
  it('reads a bearer token', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
  });

  it('ignores other authorization schemes', () => {
    expect(extractBearerToken('Basic abc123')).toBeUndefined();
    expect(extractBearerToken('abc123')).toBeUndefined();
  });

  it('returns undefined when the header is missing', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});

describe('resolveUserFromToken', () => {
  it('returns the unauthenticated placeholder when no token is supplied', async () => {
    await expect(resolveUserFromToken(undefined)).resolves.toBe(UnauthenticatedUser);
  });
});
