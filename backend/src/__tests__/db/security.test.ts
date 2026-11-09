/**
 * Guards the database access rules.
 *
 * Supabase grants the `anon` role full privileges on every table in the
 * `public` schema, and the anon key ships in the browser bundle. These tests
 * check that the lockdown the schema cannot express is actually applied, so
 * a future change to the statement list cannot quietly reopen the tables.
 */

import { buildSecurityStatements } from '../../db/security';

describe('the database lockdown', () => {
  const tables = ['portfolio_profile', 'users'];
  const statements = buildSecurityStatements(tables, ['users_id_seq'], ['search_jobs']);
  const joined = statements.join('\n');

  it('turns row level security on for every table', () => {
    for (const table of tables) {
      expect(joined).toContain(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`);
    }
  });

  it('revokes the public grants from every table', () => {
    for (const table of tables) {
      expect(joined).toContain(`REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM anon;`);
      expect(joined).toContain(
        `REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM authenticated;`,
      );
    }
  });

  it('revokes the grants from the sequences too', () => {
    expect(joined).toContain('REVOKE ALL PRIVILEGES ON SEQUENCE public."users_id_seq" FROM anon;');
  });

  it('revokes the default privileges so a new table stays closed', () => {
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;',
    );
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;',
    );
  });

  it('revokes function execution, because a public function is an RPC endpoint', () => {
    expect(joined).toContain('REVOKE ALL PRIVILEGES ON FUNCTION public."search_jobs" FROM anon;');
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION public."search_jobs" FROM authenticated;',
    );
  });

  it('revokes function execution from PUBLIC, which anon would inherit', () => {
    expect(joined).toContain('REVOKE ALL PRIVILEGES ON FUNCTION public."search_jobs" FROM PUBLIC;');
  });

  it('revokes the default function privilege so a new function stays closed', () => {
    // The global form, not the schema-scoped one: the global default is what
    // supplies the built-in EXECUTE privilege for a new function, so the
    // schema-scoped revoke leaves it in place.
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
    );
  });

  it('creates no policy, so the default is to deny every row', () => {
    expect(joined).not.toContain('CREATE POLICY');
  });

  it('refuses to interpolate an identifier that is not a plain name', () => {
    expect(() => buildSecurityStatements(['users"; DROP TABLE users; --'])).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});
