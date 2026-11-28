import Fastify, { FastifyInstance } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import { PRIVATE_ROUTE, PUBLIC_ROUTE, requireAuthenticatedUser } from '../../routes/access';

const mockResolveUserFromToken = jest.fn();
const mockFindOrCreateUserByAuthId = jest.fn();

const mockGetAuthConfig = jest.fn();

jest.mock('../../config/auth', () => ({
  getAuthConfig: () => mockGetAuthConfig(),
  isAuthConfigured: () => true,
}));

jest.mock('../../services/auth/supabaseAuth', () => ({
  AuthError: class AuthError extends Error {},
  extractBearerToken: (header: string | undefined) => header?.replace(/^Bearer /i, ''),
  resolveUserFromToken: (...args: unknown[]) => mockResolveUserFromToken(...args),
}));

jest.mock('../../db/api/user', () => ({
  findOrCreateUserByAuthId: (...args: unknown[]) => mockFindOrCreateUserByAuthId(...args),
}));

import authPlugin from '../../plugins/auth';
import { registerChatRoute } from '../../routes/chatRateLimit';
import { AuthError } from '../../services/auth/supabaseAuth';

describe('auth plugin token verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockResolveUserFromToken.mockReset();
    mockFindOrCreateUserByAuthId.mockReset();
    mockGetAuthConfig.mockReset();
    mockGetAuthConfig.mockReturnValue({ devBypass: false });
    mockResolveUserFromToken.mockResolvedValue({ authId: 'auth-1', email: 'a@example.com' });
    mockFindOrCreateUserByAuthId.mockResolvedValue({
      id: 7,
      email: 'a@example.com',
      authId: 'auth-1',
    });

    app = Fastify();
    await app.register(fastifyRequestContext, {
      defaultStoreValues: { user: UnauthenticatedUser },
    });
    await app.register(authPlugin);
    app.addHook('preHandler', requireAuthenticatedUser);
    app.get('/public-thing', PUBLIC_ROUTE, async () => ({ user: requestContext.get('user') }));
    app.get('/private-thing', PRIVATE_ROUTE, async () => ({ user: requestContext.get('user') }));
    await registerChatRoute(app, async () => ({ user: requestContext.get('user') }));
  });

  afterEach(async () => {
    await app.close();
  });

  const headers = { authorization: 'Bearer valid-token' };

  it('does not verify the token or create a user on a public route', async () => {
    const response = await app.inject({ method: 'GET', url: '/public-thing', headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: UnauthenticatedUser });
    expect(mockResolveUserFromToken).not.toHaveBeenCalled();
    expect(mockFindOrCreateUserByAuthId).not.toHaveBeenCalled();
  });

  it('still verifies the token and resolves the user on a private route', async () => {
    const response = await app.inject({ method: 'GET', url: '/private-thing', headers });

    expect(response.json()).toEqual({ user: { id: 7, email: 'a@example.com', authId: 'auth-1' } });
    expect(mockResolveUserFromToken).toHaveBeenCalledWith('valid-token');
    expect(mockFindOrCreateUserByAuthId).toHaveBeenCalledTimes(1);
  });

  it('treats a route registered by registerChatRoute as public', async () => {
    const response = await app.inject({ method: 'POST', url: '/chat', headers, payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: UnauthenticatedUser });
    expect(mockResolveUserFromToken).not.toHaveBeenCalled();
    expect(mockFindOrCreateUserByAuthId).not.toHaveBeenCalled();
  });

  it('does not create the dev user on a public route under the dev bypass', async () => {
    mockGetAuthConfig.mockReturnValue({ devBypass: true });

    const response = await app.inject({ method: 'GET', url: '/public-thing', headers });

    expect(response.json()).toEqual({ user: UnauthenticatedUser });
    expect(mockFindOrCreateUserByAuthId).not.toHaveBeenCalled();
  });

  it('leaves the user unauthenticated and answers 401 when a private route token is rejected', async () => {
    mockResolveUserFromToken.mockRejectedValue(new AuthError('bad token'));

    const response = await app.inject({ method: 'GET', url: '/private-thing', headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockFindOrCreateUserByAuthId).not.toHaveBeenCalled();
  });

  describe('unmatched URLs', () => {
    it('answer 404 without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/no-such-route' });

      expect(response.statusCode).toBe(404);
    });

    it('answer 404 with an invalid token', async () => {
      mockResolveUserFromToken.mockRejectedValue(new AuthError('bad token'));

      const response = await app.inject({ method: 'GET', url: '/no-such-route', headers });

      expect(response.statusCode).toBe(404);
    });

    it('answer 404 with a valid token, without verifying it', async () => {
      const response = await app.inject({ method: 'GET', url: '/no-such-route', headers });

      expect(response.statusCode).toBe(404);
      expect(mockResolveUserFromToken).not.toHaveBeenCalled();
      expect(mockFindOrCreateUserByAuthId).not.toHaveBeenCalled();
    });
  });

  it('answers 401 on a matched private route without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/private-thing' });

    expect(response.statusCode).toBe(401);
  });
});
