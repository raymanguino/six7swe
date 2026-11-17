import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWTPayload } from 'jose';
import { getAuthConfig, isAuthConfigured, resetAuthConfig } from '../../config/auth';
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
  'SUPABASE_JWT_ISSUER',
  'SUPABASE_JWT_SECRET',
  'AUTH_DEV_BYPASS',
] as const;

const HS_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
const SUBJECT = '00000000-0000-4000-8000-000000000001';
const KID = 'test-key';
const SUPABASE_URL = 'https://project.supabase.test';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const JWKS_BASE_URL = 'https://project.supabase.test/auth/v1/.well-known/jwks.json';

const savedEnv: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {};

interface TokenOptions {
  audience?: string;
  /** `null` leaves the claim out. */
  issuer?: string | null;
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
    issuer = ISSUER,
    expiresAt = nowSeconds() + 3600,
    notBefore,
    subject = SUBJECT,
  }: TokenOptions,
): SignJWT {
  const jwt = new SignJWT(claims).setAudience(audience).setIssuedAt();
  if (issuer !== null) jwt.setIssuer(issuer);
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
    iss: ISSUER,
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
  process.env.SUPABASE_URL = SUPABASE_URL;
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
    delete process.env.SUPABASE_URL;
    resetAuthConfig();
    const token = await signHs256({ email: 'user@example.com' });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      name: 'AuthError',
      message: 'Authentication is not configured on this server.',
    });
  });

  describe('HS256 shared secret', () => {
    beforeEach(() => {
      // The JWKS endpoint wins whenever SUPABASE_URL is set, so the shared
      // secret is only used without it, with the issuer given explicitly.
      delete process.env.SUPABASE_URL;
      process.env.SUPABASE_JWT_ISSUER = ISSUER;
      process.env.SUPABASE_JWT_SECRET = HS_SECRET;
      resetAuthConfig();
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

    it('rejects a token without an exp claim', async () => {
      const token = await signHs256({}, { expiresAt: null });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token without a sub claim', async () => {
      const token = await signHs256({}, { subject: null });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token from another issuer', async () => {
      const token = await signHs256({}, { issuer: 'https://other.supabase.test/auth/v1' });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token without an iss claim', async () => {
      const token = await signHs256({}, { issuer: null });
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a validly signed token using an unlisted algorithm', async () => {
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
        .setAudience('authenticated')
        .setIssuer(ISSUER)
        .setSubject(SUBJECT)
        .setExpirationTime(nowSeconds() + 3600)
        .sign(new TextEncoder().encode(HS_SECRET));
      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects every token when no issuer is configured', async () => {
      delete process.env.SUPABASE_JWT_ISSUER;
      resetAuthConfig();
      const token = await signHs256({});
      await expect(verifyAccessToken(token)).rejects.toMatchObject({
        name: 'AuthError',
        message: 'Authentication is not configured on this server.',
      });
    });

    it('resolveUserFromToken rejects a token without a sub claim with a 401', async () => {
      const token = await signHs256({}, { subject: null });
      await expect(resolveUserFromToken(token)).rejects.toMatchObject({
        name: 'AuthError',
        statusCode: 401,
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
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const token = await signAsymmetric({}, privateKey, { audience: 'anon' });

      await expectAuthError(verifyAccessToken(token));
      // A bad token is not an outage, so nothing is logged.
      expect(errorSpy).not.toHaveBeenCalled();
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

    it('rejects a token without an exp claim', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { expiresAt: null });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token without a sub claim', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { subject: null });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token from another issuer', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, {
        issuer: 'https://other.supabase.test/auth/v1',
      });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a token without an iss claim', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { issuer: null });

      await expectAuthError(verifyAccessToken(token));
    });

    it('rejects a validly signed token using an unlisted algorithm', async () => {
      const { privateKey, publicKey } = await generateKeyPair('PS256');
      await serveJwks(publicKey);
      const token = await signAsymmetric({}, privateKey, { alg: 'PS256' });

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
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const token = await signAsymmetric({}, privateKey);

      await expectAuthError(verifyAccessToken(token));
      // An outage is logged, so it is not mistaken for a bad token.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expectOneJwksFetch();
    });

    it('rejects every token when the JWKS endpoint cannot be reached', async () => {
      const { privateKey } = await generateKeyPair('RS256');
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const token = await signAsymmetric({}, privateKey);

      await expectAuthError(verifyAccessToken(token));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expectOneJwksFetch();
    });
  });
});

describe('auth configuration', () => {
  function issuerFor(url: string): string | undefined {
    process.env.SUPABASE_URL = url;
    resetAuthConfig();
    return getAuthConfig().supabaseIssuer;
  }

  it.each([
    ['https://project.supabase.test', 'https://project.supabase.test/auth/v1'],
    ['https://project.supabase.test/', 'https://project.supabase.test/auth/v1'],
    ['https://project.supabase.test//', 'https://project.supabase.test/auth/v1'],
  ])('derives the issuer from SUPABASE_URL %s', (url, expected) => {
    expect(issuerFor(url)).toBe(expected);
  });

  it('derives the JWKS URL from the same base', () => {
    process.env.SUPABASE_URL = 'https://project.supabase.test//';
    resetAuthConfig();
    expect(getAuthConfig().supabaseJwksUrl).toBe(
      'https://project.supabase.test/auth/v1/.well-known/jwks.json',
    );
  });

  it('prefers an explicit SUPABASE_JWT_ISSUER', () => {
    process.env.SUPABASE_JWT_ISSUER = 'https://issuer.example.test/auth/v1';
    resetAuthConfig();
    expect(getAuthConfig().supabaseIssuer).toBe('https://issuer.example.test/auth/v1');
  });

  it('treats blank variables as unset', () => {
    process.env.SUPABASE_JWT_ISSUER = '  ';
    process.env.SUPABASE_JWKS_URL = '';
    process.env.SUPABASE_JWT_SECRET = ' ';
    resetAuthConfig();

    const config = getAuthConfig();

    expect(config.supabaseIssuer).toBe(ISSUER);
    expect(config.supabaseJwksUrl).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(config.supabaseJwtSecret).toBeUndefined();
  });

  it('reports auth as not configured when the issuer is missing', () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = HS_SECRET;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    resetAuthConfig();

    expect(isAuthConfigured()).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('reports auth as configured with a key source and an issuer', () => {
    expect(isAuthConfigured()).toBe(true);
  });

  it('fails closed on the JWKS path without an issuer, without fetching keys', async () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWKS_URL = 'https://project.supabase.test/jwks-only.json';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    resetAuthConfig();
    const token = await signHs256({});

    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      name: 'AuthError',
      statusCode: 401,
      message: 'Authentication is not configured on this server.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not log a crafted crit header as an outage', async () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_ISSUER = ISSUER;
    process.env.SUPABASE_JWT_SECRET = HS_SECRET;
    resetAuthConfig();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'HS256', crit: ['x'], x: 1 })}.${encode({ sub: SUBJECT })}.c2ln`;

    await expectAuthError(verifyAccessToken(token));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
