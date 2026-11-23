import { chromeEnv } from '../../services/jobFetchers/browser';

describe('chromeEnv', () => {
  it('passes only what Chrome needs, never a backend secret', () => {
    const env = chromeEnv({
      PATH: '/usr/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      DATABASE_URL: 'postgres://app:pw@host/db',
      DATABASE_MIGRATION_URL: 'postgres://postgres:pw@host/db',
      KNOWLEDGE_SERVICE_KEY: 'k',
      KNOWLEDGE_OWNER_KEY: 'k',
      RESEND_API_KEY: 're_x',
      MINIMAX_API_KEY: 'sk',
      SUPABASE_URL: 'https://x.supabase.co',
      UNSET: undefined,
    });

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/node', LANG: 'C.UTF-8' });
  });
});
