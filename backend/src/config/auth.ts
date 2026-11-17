import { z } from 'zod';

/**
 * Authentication configuration.
 *
 * Supabase issues asymmetric (RS256) JWTs for signed-in users, verified
 * against the project's JWKS endpoint. The legacy shared-secret (HS256) mode
 * is still supported for older projects.
 */

const authConfigSchema = z.object({
  supabaseUrl: z.string().url().optional(),
  /** Expected `iss` claim: `${SUPABASE_URL}/auth/v1`. Overridable with SUPABASE_JWT_ISSUER. */
  supabaseIssuer: z.string().url().optional(),
  supabaseJwksUrl: z.string().url().optional(),
  supabaseJwtSecret: z.string().min(1).optional(),
  /** Development-only escape hatch. Refused when NODE_ENV is production. */
  devBypass: z.boolean().default(false),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

let cached: AuthConfig | null = null;

function readBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function getAuthConfig(): AuthConfig {
  if (cached) return cached;

  // Blank values count as unset, so an empty variable falls back to the default.
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || undefined;
  const explicitIssuer = process.env.SUPABASE_JWT_ISSUER?.trim() || undefined;
  const explicitJwks = process.env.SUPABASE_JWKS_URL?.trim() || undefined;
  const authBase = supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/auth/v1` : undefined;
  const devBypass = readBoolean(process.env.AUTH_DEV_BYPASS);

  if (devBypass && process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_DEV_BYPASS must not be enabled in production.');
  }

  cached = authConfigSchema.parse({
    supabaseUrl,
    supabaseIssuer: explicitIssuer ?? authBase,
    supabaseJwksUrl: explicitJwks ?? (authBase ? `${authBase}/.well-known/jwks.json` : undefined),
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET?.trim() || undefined,
    devBypass,
  });

  if ((cached.supabaseJwksUrl || cached.supabaseJwtSecret) && !cached.supabaseIssuer) {
    console.error(
      'Auth has a key source but no token issuer, so every token is rejected. ' +
        'Set SUPABASE_URL or SUPABASE_JWT_ISSUER.',
    );
  }

  return cached;
}

/** True when a real auth provider is configured. */
export function isAuthConfigured(): boolean {
  const config = getAuthConfig();
  return Boolean((config.supabaseJwksUrl || config.supabaseJwtSecret) && config.supabaseIssuer);
}

/** Clears the cached config. Used by tests. */
export function resetAuthConfig(): void {
  cached = null;
}
