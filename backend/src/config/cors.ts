import { z } from 'zod';

/**
 * CORS origin policy.
 *
 * Outside production every origin is reflected (`true`), so local development needs no
 * configuration. In production `CORS_ORIGINS` is required: a comma-separated list of the exact
 * origins (scheme + host + optional port, no path) allowed to call the API from a browser.
 * Leaving it unset, empty, or malformed throws, so the server fails fast at startup instead of
 * silently allowing every origin.
 */
const originSchema = z.string().transform((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid origin` });
    return z.NEVER;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: `"${value}" must use http or https` });
    return z.NEVER;
  }
  // `origin` drops any path, so require the value to already be one (a trailing slash is fine).
  if (value.replace(/\/+$/, '') !== parsed.origin) {
    ctx.addIssue({ code: 'custom', message: `"${value}" must be an origin without a path` });
    return z.NEVER;
  }
  return parsed.origin;
});

const originListSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(originSchema).min(1, 'at least one origin is required'));

export function getCorsOrigin(
  env: Record<string, string | undefined> = process.env,
): true | string[] {
  if (env.NODE_ENV !== 'production') return true;

  const result = originListSchema.safeParse(env.CORS_ORIGINS ?? '');
  if (!result.success) {
    const detail = result.error.issues.map((i) => i.message).join('; ');
    throw new Error(
      `CORS_ORIGINS must be a comma-separated list of allowed origins when NODE_ENV=production: ${detail}`,
    );
  }
  return [...new Set(result.data)];
}
