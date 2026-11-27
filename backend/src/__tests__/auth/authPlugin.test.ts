import Fastify, { FastifyInstance } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { UnauthenticatedUser } from '../../constants';
import { PRIVATE_ROUTE, PUBLIC_ROUTE } from '../../routes/access';

const mockResolveUserFromToken = jest.fn();
const mockFindOrCreateUserByAuthId = jest.fn();

jest.mock('../../config/auth', () => ({
  getAuthConfig: () => ({ devBypass: false }),
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

describe('auth plugin token verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockResolveUserFromToken.mockReset();
    mockFindOrCreateUserByAuthId.mockReset();
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
    app.get('/public-thing', PUBLIC_ROUTE, async () => ({ user: requestContext.get('user') }));
    app.get('/private-thing', PRIVATE_ROUTE, async () => ({ user: requestContext.get('user') }));
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
});
