/**
 * Guards the database access rules.
 *
 * Supabase grants the `anon` role full privileges on every table in the
 * `public` schema, and the anon key ships in the browser bundle. These tests
 * check that the lockdown the schema cannot express is actually applied, so
 * a future change to the statement list cannot quietly reopen the tables.
 */

import { buildAppAccessStatements, buildLockdownStatements } from '../../db/lockdownStatements';
import { APP_POLICY, OWNER_ROLE } from '../../db/security';

/** Both transactions' statements, for argument-less functions and no former role. */
function buildSecurityStatements(
  tables: string[],
  sequences: string[] = [],
  functions: string[] = [],
  appRole: string | null = null,
): string[] {
  const routines = functions.map((name) => ({ name, args: '' }));
  return [
    ...buildLockdownStatements({ tables, sequences, functions: routines }),
    ...buildAppAccessStatements({ tables, sequences }, appRole, []),
  ];
}

describe('the database lockdown', () => {
  const tables = ['profiles', 'users'];
  const statements = buildSecurityStatements(tables, ['users_id_seq'], ['search_jobs']);
  const joined = statements.join('\n');

  it('turns row level security on for every table', () => {
    for (const table of tables) {
      expect(joined).toContain(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`);
    }
  });

  it('revokes the public grants from every table', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public."profiles", public."users" FROM anon, authenticated;',
    );
  });

  it('revokes the grants from the sequences too', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public."users_id_seq" FROM anon, authenticated;',
    );
  });

  it('revokes the default privileges so a new table stays closed', () => {
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;',
    );
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;',
    );
  });

  it('revokes function execution from the browser roles and PUBLIC, which anon would inherit', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"() FROM anon, authenticated, PUBLIC;',
    );
  });

  it('revokes the default function privilege so a new function stays closed', () => {
    // The global form, not the schema-scoped one: the global default is what
    // supplies the built-in EXECUTE privilege for a new function, so the
    // schema-scoped revoke leaves it in place.
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
    );
  });

  it('creates no policy without a runtime role, so the default is to deny every row', () => {
    expect(joined).not.toContain('CREATE POLICY');
    expect(joined).not.toContain('GRANT ');
  });

  it('refuses to interpolate an identifier that is not a plain name', () => {
    expect(() => buildSecurityStatements(['users"; DROP TABLE users; --'])).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});

describe('the runtime role grants', () => {
  const tables = ['profiles', 'users'];
  const statements = buildSecurityStatements(tables, ['users_id_seq'], [], 'six7swe_app');
  const joined = statements.join('\n');

  it('grants row access and nothing else on every table', () => {
    expect(joined).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."profiles", public."users" TO "six7swe_app";',
    );
    expect(joined).not.toMatch(/GRANT ALL/);
    expect(joined).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER/);
  });

  it('revokes what was granted by hand before granting', () => {
    const revoke = statements.indexOf(
      'REVOKE ALL PRIVILEGES ON TABLE public."profiles", public."users" FROM "six7swe_app";',
    );
    const grant = statements.findIndex((statement) => statement.startsWith('GRANT SELECT'));
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
  });

  it('admits only the runtime role to the rows, so anon still sees nothing', () => {
    for (const table of tables) {
      expect(joined).toContain(
        `CREATE POLICY ${APP_POLICY} ON public."${table}" FOR ALL TO "six7swe_app" USING (true) WITH CHECK (true);`,
      );
      expect(joined).toContain(`DROP POLICY IF EXISTS ${APP_POLICY} ON public."${table}";`);
    }
    expect(joined).not.toMatch(/CREATE POLICY .* TO (anon|authenticated|PUBLIC)/);
  });

  it('keeps row level security on', () => {
    expect(joined).toContain('ALTER TABLE public."users" ENABLE ROW LEVEL SECURITY;');
    expect(joined).not.toContain('DISABLE ROW LEVEL SECURITY');
  });

  it('lets the role draw ids from the sequences', () => {
    expect(joined).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE public."users_id_seq" TO "six7swe_app";',
    );
  });

  it('grants the same on tables and sequences a later migration creates', () => {
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "six7swe_app";',
    );
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "six7swe_app";',
    );
  });

  it('runs after the lockdown, so a revoke never undoes a grant', () => {
    const lastRevokeFromPublicRoles = statements.reduce(
      (last, statement, index) =>
        /FROM (anon|authenticated|PUBLIC);$/.test(statement) ? index : last,
      -1,
    );
    const firstGrant = statements.findIndex((statement) => statement.startsWith('GRANT '));
    expect(firstGrant).toBeGreaterThan(lastRevokeFromPublicRoles);
  });

  it('refuses the owner as the runtime role', () => {
    expect(() => buildSecurityStatements(tables, [], [], OWNER_ROLE)).toThrow(/table owner/);
  });

  it('refuses a role name that is not a plain identifier', () => {
    expect(() => buildSecurityStatements(tables, [], [], 'app"; DROP TABLE users; --')).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});
