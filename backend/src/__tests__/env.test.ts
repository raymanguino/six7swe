import { getSafeEnv, SAFE_ENV_KEYS } from '../config/env';

describe('getSafeEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'sk-test-secret-value-000';
    process.env.MINIMAX_API_KEY_SECONDARY = 'sk-test-secondary-secret-000';
    process.env.RESEND_API_KEY = 're_test_secret_value';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_value';
    process.env.DATABASE_URL = 'postgresql://user:password@host:5432/db';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('never exposes secret values', () => {
    const env = getSafeEnv();
    expect(env).not.toHaveProperty('MINIMAX_API_KEY');
    expect(env).not.toHaveProperty('MINIMAX_API_KEY_SECONDARY');
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(env).not.toHaveProperty('SUPABASE_SECRET_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('only contains allowlisted keys', () => {
    const allowed: readonly string[] = SAFE_ENV_KEYS;
    const keys = Object.keys(getSafeEnv());
    expect(keys.every((key) => allowed.includes(key))).toBe(true);
  });
});
