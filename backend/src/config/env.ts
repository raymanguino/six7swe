/**
 * Explicit allowlist of environment values that are safe to expose over HTTP.
 *
 * Secrets must never be added here. Keep this list minimal and reviewable.
 */
export const SAFE_ENV_KEYS = ['NODE_ENV', 'PORT', 'HOST'] as const;

export type SafeEnvKey = (typeof SAFE_ENV_KEYS)[number];
export type SafeEnv = Partial<Record<SafeEnvKey, string>>;

export function getSafeEnv(): SafeEnv {
  const env: SafeEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
