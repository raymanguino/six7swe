import { z } from 'zod';

/**
 * Outbound email configuration.
 *
 * `RESEND_FROM_EMAIL` must be an address on a domain verified in Resend.
 * The Supabase Auth SMTP sender uses the same address, so both stay
 * consistent and only one domain needs DNS records.
 */

const emailConfigSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.email(),
  fromName: z.string().min(1),
});

export type EmailConfig = z.infer<typeof emailConfigSchema>;

/** Display name used when `RESEND_FROM_NAME` is not set. */
const DEFAULT_FROM_NAME = 'Ray Manguino';

/** Thrown when the server has no usable outbound email configuration. */
export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

let cached: EmailConfig | null = null;

/**
 * Reads the outbound email configuration from the environment.
 *
 * Throws `EmailConfigError` when a variable is missing or malformed, so the
 * caller can turn it into an HTTP-safe response without leaking the value.
 */
export function getEmailConfig(): EmailConfig {
  if (cached) return cached;

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailConfigError('RESEND_API_KEY is not configured.');
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim();
  if (!fromEmail) {
    throw new EmailConfigError('RESEND_FROM_EMAIL is not configured.');
  }

  const parsed = emailConfigSchema.safeParse({
    apiKey,
    fromEmail,
    fromName: process.env.RESEND_FROM_NAME?.trim() || DEFAULT_FROM_NAME,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'RESEND_FROM_EMAIL';
    const reason = issue?.message ?? 'is invalid';
    throw new EmailConfigError(`Outbound email configuration is invalid: ${field} ${reason}`);
  }

  cached = parsed.data;
  return cached;
}

/** Clears the cached config. Used by tests. */
export function resetEmailConfig(): void {
  cached = null;
}
