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

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const explicitJwks = process.env.SUPABASE_JWKS_URL?.trim();
  const devBypass = readBoolean(process.env.AUTH_DEV_BYPASS);

  if (devBypass && process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_DEV_BYPASS must not be enabled in production.');
  }

  cached = authConfigSchema.parse({
    supabaseUrl,
    supabaseJwksUrl: explicitJwks ?? (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json` : undefined),
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET?.trim(),
    devBypass,
  });

  return cached;
}

/** True when a real auth provider is configured. */
export function isAuthConfigured(): boolean {
  const config = getAuthConfig();
  return Boolean(config.supabaseJwksUrl || config.supabaseJwtSecret);
}

/** Clears the cached config. Used by tests. */
export function resetAuthConfig(): void {
  cached = null;
}
