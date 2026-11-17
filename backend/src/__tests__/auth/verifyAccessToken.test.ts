import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWTPayload } from 'jose';
import { resetAuthConfig } from '../../config/auth';
import {
  AuthError,
  resolveUserFromToken,
  verifyAccessToken,
} from '../../services/auth/supabaseAuth';

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
const KID = 'test-key';
const JWKS_BASE_URL = 'https://project.supabase.test/auth/v1/.well-known/jwks.json';

const savedEnv: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {};

interface TokenOptions {
  audience?: string;
  /** Seconds since the epoch; `null` leaves the claim out. */
  expiresAt?: number | null;
  notBefore?: number;
  subject?: string | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Builds a token with the default Supabase-like claims, ready to sign. */
function buildToken(
  claims: JWTPayload,
  {
    audience = 'authenticated',
    expiresAt = nowSeconds() + 3600,
    notBefore,
    subject = SUBJECT,
  }: TokenOptions,
): SignJWT {
  const jwt = new SignJWT(claims).setAudience(audience).setIssuedAt();
  if (subject !== null) jwt.setSubject(subject);
  if (expiresAt !== null) jwt.setExpirationTime(expiresAt);
  if (notBefore !== undefined) jwt.setNotBefore(notBefore);
  return jwt;
}

function signHs256(
  claims: JWTPayload,
  { secret = HS_SECRET, ...options }: TokenOptions & { secret?: string } = {},
): Promise<string> {
  return buildToken(claims, options)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(secret));
}

function signAsymmetric(
  claims: JWTPayload,
  key: CryptoKey,
  { alg = 'RS256', kid = KID, ...options }: TokenOptions & { alg?: string; kid?: string } = {},
): Promise<string> {
  return buildToken(claims, options).setProtectedHeader({ alg, kid, typ: 'JWT' }).sign(key);
}

/** An unsigned token (`alg: none`), which no verifier may accept. */
function unsignedToken(): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'none', typ: 'JWT' });
  const payload = encode({
    sub: SUBJECT,
    aud: 'authenticated',
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
  });
  return `${header}.${payload}.`;
}

/** Settles the promise once and checks it rejected with the generic 401. */
async function expectAuthError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect(error).toMatchObject({ statusCode: 401, message: 'Invalid or expired access token.' });
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

    it('rejects a token that is not valid yet', async () => {
      const token = await signHs256({}, { notBefore: nowSeconds() + 3600 });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token signed with a different secret', async () => {
      const token = await signHs256({}, { secret: 'some-other-secret-that-is-also-long-enough' });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects an unsigned (alg: none) token', async () => {
      await expectAuthError(verifyAccessToken(unsignedToken()));
    });

    it('rejects an RS256 token', async () => {
      const { privateKey } = await generateKeyPair('RS256');
      const token = await signAsymmetric({}, privateKey);
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a malformed token', async () => {
      await expectAuthError(verifyAccessToken('not-a-jwt'));
    });

    // Pinned as current behaviour: jose does not require `exp` unless asked
    // to, and the service does not ask, so a token without one is accepted.
    it('accepts a token without an exp claim (current behaviour)', async () => {
      const token = await signHs256({}, { expiresAt: null });

      const claims = await verifyAccessToken(token);

      expect(claims.sub).toBe(SUBJECT);
      expect(claims.exp).toBeUndefined();
    });

    // Pinned as current behaviour: `verifyAccessToken` accepts a token
    // without `sub`, and `resolveUserFromToken` is what rejects it.
    it('accepts a token without a sub claim, which resolveUserFromToken rejects', async () => {
      const token = await signHs256({}, { subject: null });

      await expect(verifyAccessToken(token)).resolves.not.toHaveProperty('sub');
      await expect(resolveUserFromToken(token)).rejects.toMatchObject({
        name: 'AuthError',
        statusCode: 401,
        message: 'Access token is missing a subject claim.',
      });
    });
  });

  describe('JWKS (asymmetric keys)', () => {
    // The service keeps one remote key set per URL, and jose caches the keys
    // it fetched for that set. Each test therefore configures its own JWKS
    // URL, so no test sees keys fetched by another.
    let jwksSequence = 0;
    let jwksUrl: string;
    let fetchSpy: jest.SpiedFunction<typeof fetch>;

    /** Serves `keys` from the JWKS endpoint through the global `fetch`. */
    async function serveJwks(...keys: CryptoKey[]): Promise<void> {
      const jwks = {
        keys: await Promise.all(
          keys.map(async (key) => ({ ...(await exportJWK(key)), kid: KID, use: 'sig' })),
        ),
      };
      // jose 6 loads the JWKS with the global `fetch`, so the endpoint is
      // stubbed there instead of through a test-only seam in the service.
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    function expectOneJwksFetch(): void {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(jwksUrl, expect.any(Object));
    }

    beforeEach(() => {
      jwksUrl = `${JWKS_BASE_URL}?test=${++jwksSequence}`;
      process.env.SUPABASE_JWKS_URL = jwksUrl;
      // The JWKS path must win when both are configured.
      process.env.SUPABASE_JWT_SECRET = HS_SECRET;
      fetchSpy = jest.spyOn(globalThis, 'fetch');
    });

    it('accepts an RS256 token signed by a key in the JWKS', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({ email: 'user@example.com' }, privateKey);

      const claims = await verifyAccessToken(token);

      expect(claims.sub).toBe(SUBJECT);
      expect(claims.email).toBe('user@example.com');
      expectOneJwksFetch();
    });

    it('accepts an ES256 token signed by a key in the JWKS', async () => {
      const { privateKey, publicKey } = await generateKeyPair('ES256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { alg: 'ES256' });

      const claims = await verifyAccessToken(token);

      expect(claims.sub).toBe(SUBJECT);
      expectOneJwksFetch();
    });

    it('rejects a token issued for another audience', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { audience: 'anon' });

      await expectAuthError(verifyAccessToken(token));
      expectOneJwksFetch();
    });

    it('rejects a token that is not valid yet', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { notBefore: nowSeconds() + 3600 });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token with a known kid signed by a different key', async () => {
      const { publicKey } = await generateKeyPair('RS256');
      const { privateKey: otherPrivateKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, otherPrivateKey);

      await expectAuthError(verifyAccessToken(token));
      expectOneJwksFetch();
    });

    it('rejects a token whose kid is not in the JWKS', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { kid: 'unknown-key' });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects an HS256 token signed with the shared secret', async () => {
      const { publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signHs256({ email: 'user@example.com' });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects an unsigned (alg: none) token', async () => {
      const { publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);

      await expectAuthError(verifyAccessToken(unsignedToken()));
    });

    it('rejects every token when the JWKS endpoint answers with an error', async () => {
      const { privateKey } = await generateKeyPair('RS256');
      fetchSpy.mockResolvedValue(new Response('unavailable', { status: 503 }));
      const token = await signAsymmetric({}, privateKey);

      await expectAuthError(verifyAccessToken(token));
      expectOneJwksFetch();
    });

    it('rejects every token when the JWKS endpoint cannot be reached', async () => {
      const { privateKey } = await generateKeyPair('RS256');
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      const token = await signAsymmetric({}, privateKey);

      await expectAuthError(verifyAccessToken(token));
      expectOneJwksFetch();
    });
  });
});
