import { isAuthError } from '@supabase/supabase-js';

/**
 * Human-readable messages for the Supabase auth errors a visitor can hit.
 *
 * The raw messages ("email rate limit exceeded") are written for developers,
 * so they are translated before they reach the UI.
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  over_email_send_rate_limit:
    'This app has reached its hourly confirmation-email limit. Please try again later.',
  over_request_rate_limit: 'Too many attempts. Please wait a moment and try again.',
  email_exists: 'An account with that email already exists.',
  user_already_exists: 'An account with that email already exists.',
  email_not_confirmed: 'Confirm your email address before signing in.',
  invalid_credentials: 'Incorrect email or password.',
  weak_password: 'Choose a stronger password.',
  signup_disabled: 'New sign-ups are currently disabled.',
  otp_expired: 'That confirmation link has expired. Please sign up again.',
  access_denied: 'That confirmation link is no longer valid. Please sign up again.',
};

/**
 * Turns a Supabase auth failure into a message safe to show a visitor.
 *
 * Falls back to the provider's own message when the code is unknown, and to
 * the supplied fallback when the failure is not an auth error at all.
 */
export function describeAuthError(error: unknown, fallback: string): string {
  if (isAuthError(error)) {
    const known = error.code ? AUTH_ERROR_MESSAGES[error.code] : undefined;
    if (known) return known;
    if (error.message) return error.message;
  }
  return fallback;
}

/**
 * Reads an error that Supabase put in the URL fragment.
 *
 * A confirmation link that is expired or already used redirects back with
 * `error`/`error_code` in the fragment. Without this the visitor would land
 * on a working page that silently looks like nothing happened.
 */
export function describeUrlAuthError(hash: string): string | null {
  if (!hash || hash.length < 2) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash.replace(/^#/, ''));
  } catch {
    return null;
  }

  const code = params.get('error_code') ?? params.get('error');
  if (!code) return null;

  return AUTH_ERROR_MESSAGES[code] ?? params.get('error_description') ?? null;
}
