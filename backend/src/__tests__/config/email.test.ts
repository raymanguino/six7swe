import { EmailConfigError, getEmailConfig, resetEmailConfig } from '../../config/email';

/**
 * The contact form refuses to send without an explicit sender address.
 *
 * The Resend shared sender only delivers to the account owner, so a missing
 * address would silently drop every message.
 */
describe('email config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetEmailConfig();
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'no-reply@auth.example.dev';
    delete process.env.RESEND_FROM_NAME;
  });

  afterEach(() => {
    resetEmailConfig();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('reads the sender address from the environment', () => {
    const config = getEmailConfig();
    expect(config.fromEmail).toBe('no-reply@auth.example.dev');
    expect(config.apiKey).toBe('re_test_key');
  });

  it('falls back to a default display name', () => {
    expect(getEmailConfig().fromName).toBe('Ray Manguino');
  });

  it('uses the configured display name when present', () => {
    process.env.RESEND_FROM_NAME = 'Job Hunter';
    resetEmailConfig();
    expect(getEmailConfig().fromName).toBe('Job Hunter');
  });

  it('fails when the API key is missing', () => {
    delete process.env.RESEND_API_KEY;
    resetEmailConfig();
    expect(() => getEmailConfig()).toThrow(EmailConfigError);
  });

  it('fails when the sender address is missing', () => {
    delete process.env.RESEND_FROM_EMAIL;
    resetEmailConfig();
    expect(() => getEmailConfig()).toThrow(EmailConfigError);
  });

  it('fails when the sender address is not an email', () => {
    process.env.RESEND_FROM_EMAIL = 'not-an-address';
    resetEmailConfig();
    expect(() => getEmailConfig()).toThrow(EmailConfigError);
  });
});
