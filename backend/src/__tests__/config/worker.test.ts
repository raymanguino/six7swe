import { loadWorkerConfig } from '../../config/worker';

const base = { DATABASE_URL: 'postgres://w:p@h/db', MINIMAX_API_KEY: 'key' };

describe('loadWorkerConfig', () => {
  it('defaults to no profiles and a daily interval', () => {
    expect(loadWorkerConfig(base)).toEqual({ profileIds: [], intervalMs: 24 * 3_600_000 });
  });

  it('reads the profiles and interval', () => {
    expect(
      loadWorkerConfig({
        ...base,
        JOB_REFRESH_PROFILE_IDS: ' 3, 1,3 ,',
        JOB_REFRESH_INTERVAL_HOURS: '6',
      }),
    ).toEqual({ profileIds: [3, 1], intervalMs: 6 * 3_600_000 });
  });

  it('names every problem at once, without values', () => {
    expect(() =>
      loadWorkerConfig({
        JOB_REFRESH_PROFILE_IDS: '1,abc',
        JOB_REFRESH_INTERVAL_HOURS: '0',
      }),
    ).toThrow(
      'Invalid worker configuration: DATABASE_URL is required; MINIMAX_API_KEY is required; ' +
        'JOB_REFRESH_PROFILE_IDS: "abc" is not a profile id; ' +
        'JOB_REFRESH_INTERVAL_HOURS must be a number of hours, at least 1',
    );
  });

  it('refuses the owner URL and the other backend secrets in production', () => {
    const env = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_MIGRATION_URL: 'postgres://postgres:secret@h/db',
      RESEND_API_KEY: 're_secret',
    };
    expect(() => loadWorkerConfig(env)).toThrow(
      'the worker must not receive DATABASE_MIGRATION_URL, RESEND_API_KEY',
    );
    expect(() => loadWorkerConfig(env)).not.toThrow(/secret/);
  });

  it('tolerates them outside production, where a local .env holds everything', () => {
    expect(() => loadWorkerConfig({ ...base, DATABASE_MIGRATION_URL: 'x' })).not.toThrow();
  });
});
