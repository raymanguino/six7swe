import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import { resetAuthConfig } from '../../config/auth';
import { AuthError, verifyAccessToken } from '../../services/auth/supabaseAuth';

/**
 * Pins the token-verification behaviour of `verifyAccessToken`, the API's only
 * token-verification path, against real signed tokens.
 */

const AUTH_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_JWKS_URL',
  'SUPABASE_JWT_SECRET',
  'AUTH_DEV_BYPASS',
] as const;

const HS_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
const SUBJECT = '00000000-0000-4000-8000-000000000001';

const savedEnv: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function signHs256(
  claims: JWTPayload,
  { secret = HS_SECRET, audience = 'authenticated', expiresAt = nowSeconds() + 3600 } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(SUBJECT)
    .setAudience(audience)
    .setIssuedAt(expiresAt - 3600)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));
}

async function expectAuthError(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AuthError);
  await expect(promise).rejects.toMatchObject({
    statusCode: 401,
    message: 'Invalid or expired access token.',
  });
}

beforeEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetAuthConfig();
});

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAuthConfig();
  jest.restoreAllMocks();
});

describe('verifyAccessToken', () => {
  it('rejects every token when no auth provider is configured', async () => {
    const token = await signHs256({ email: 'user@example.com' });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      name: 'AuthError',
      message: 'Authentication is not configured on this server.',
    });
  });

  describe('HS256 shared secret', () => {
    beforeEach(() => {
      process.env.SUPABASE_JWT_SECRET = HS_SECRET;
    });

    it('accepts a valid token and returns its claims', async () => {
      const token = await signHs256({ email: 'user@example.com' });

      const claims = await verifyAccessToken(token);

      expect(claims.sub).toBe(SUBJECT);
      expect(claims.email).toBe('user@example.com');
      expect(claims.aud).toBe('authenticated');
    });

    it('rejects a token issued for another audience', async () => {
      const token = await signHs256({}, { audience: 'anon' });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects an expired token', async () => {
      const token = await signHs256({}, { expiresAt: nowSeconds() - 60 });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token signed with a different secret', async () => {
      const token = await signHs256({}, { secret: 'some-other-secret-that-is-also-long-enough' });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a malformed token', async () => {
      await expectAuthError(verifyAccessToken('not-a-jwt'));
    });
  });

  describe('RS256 against the project JWKS', () => {
    const JWKS_BASE_URL = 'https://project.supabase.test/auth/v1/.well-known/jwks.json';
    let jwksSequence = 0;

    async function setUpJwks(): Promise<{
      sign: (claims: JWTPayload, audience?: string) => Promise<string>;
      fetchSpy: jest.SpyInstance;
    }> {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
      // The service keeps one key set per URL and jose caches the fetched
      // keys, so each test uses its own URL to get a fresh key set.
      const jwksUrl = `${JWKS_BASE_URL}?test=${++jwksSequence}`;

      // jose 6 loads the JWKS with the global `fetch`, so the endpoint is
      // stubbed there instead of through a test-only seam in the service.
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        expect(String(input)).toBe(jwksUrl);
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      process.env.SUPABASE_JWKS_URL = jwksUrl;
      // Proves the asymmetric path wins when both are configured.
      process.env.SUPABASE_JWT_SECRET = HS_SECRET;

      const sign = (claims: JWTPayload, audience = 'authenticated'): Promise<string> =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
          .setSubject(SUBJECT)
          .setAudience(audience)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);

      return { sign, fetchSpy };
    }

    it('accepts a token signed by a key in the JWKS', async () => {
      const { sign, fetchSpy } = await setUpJwks();
      const token = await sign({ email: 'user@example.com' });

      const claims = await verifyAccessToken(token);

      expect(claims.sub).toBe(SUBJECT);
      expect(claims.email).toBe('user@example.com');
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('rejects a token issued for another audience', async () => {
      const { sign } = await setUpJwks();
      const token = await sign({}, 'anon');
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects an HS256 token signed with the shared secret', async () => {
      await setUpJwks();
      const token = await signHs256({ email: 'user@example.com' });
      await expectAuthError(verifyAccessToken(token));
    });
  });
});
