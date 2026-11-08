import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getAuthConfig } from '../../config/auth';
import { UnauthenticatedUser } from '../../constants';
import type { ContextUser } from '../../types';

/** Thrown when a token is missing, malformed or fails verification. */
export class AuthError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

interface SupabaseClaims extends JWTPayload {
  email?: string;
  sub?: string;
}

let remoteKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;
let remoteKeySetUrl: string | null = null;

function getKeySet(url: string): ReturnType<typeof createRemoteJWKSet> {
  if (!remoteKeySet || remoteKeySetUrl !== url) {
    remoteKeySet = createRemoteJWKSet(new URL(url));
    remoteKeySetUrl = url;
  }
  return remoteKeySet;
}

/**
 * Verifies a Supabase access token and returns its claims.
 *
 * The asymmetric (RS256) path is preferred because the signing key can be
 * rotated without redeploying the API.
 */
export async function verifyAccessToken(token: string): Promise<SupabaseClaims> {
  const config = getAuthConfig();

  if (!config.supabaseJwksUrl && !config.supabaseJwtSecret) {
    throw new AuthError('Authentication is not configured on this server.');
  }

  try {
    if (config.supabaseJwksUrl) {
      const { payload } = await jwtVerify(token, getKeySet(config.supabaseJwksUrl), {
        audience: 'authenticated',
      });
      return payload as SupabaseClaims;
    }

    const secret = config.supabaseJwtSecret!;
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      audience: 'authenticated',
    });
    return payload as SupabaseClaims;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('Invalid or expired access token.');
  }
}

/**
 * Resolves a verified token into the request user.
 *
 * Returns the unauthenticated placeholder when no token was supplied, so the
 * caller can decide whether the route requires a real user.
 */
export async function resolveUserFromToken(token: string | undefined): Promise<ContextUser> {
  if (!token) {
    return UnauthenticatedUser;
  }

  const claims = await verifyAccessToken(token);

  const authId = claims.sub;
  const email = claims.email;

  if (!authId) {
    throw new AuthError('Access token is missing a subject claim.');
  }

  return {
    id: authId,
    email: email ?? '',
    authId,
  };
}

/** Extracts a bearer token from an Authorization header value. */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}
