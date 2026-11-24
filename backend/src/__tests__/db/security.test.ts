/**
 * Guards the database access rules.
 *
 * Supabase grants the `anon` role full privileges on every table in the
 * `public` schema, and the anon key ships in the browser bundle. These tests
 * check that the lockdown the schema cannot express is actually applied, so
 * a future change to the statement list cannot quietly reopen the tables.
 */

import {
  APP_POLICY,
  buildSecurityStatements,
  OWNER_ROLE,
  selectFormerRoles,
} from '../../db/security';

describe('the database lockdown', () => {
  const tables = ['profiles', 'users'];
  const statements = buildSecurityStatements({
    tables,
    sequences: ['users_id_seq'],
    functions: [
      { name: 'search_jobs', args: '' },
      { name: 'search_jobs', args: 'text, integer' },
      { name: 'tag_match', args: 'character varying, text[]' },
    ],
  });
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
    expect(joined).toContain('REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"() FROM anon;');
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"() FROM authenticated;',
    );
  });

  it('revokes function execution from PUBLIC, which anon would inherit', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"() FROM PUBLIC;',
    );
  });

  it('revokes every overload and function with arguments by its full signature', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"(text, integer) FROM PUBLIC;',
    );
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."tag_match"(character varying, text[]) FROM anon;',
    );
  });

  it('refuses an argument list that could close the signature', () => {
    expect(() =>
      buildSecurityStatements({
        tables: [],
        functions: [{ name: 'f', args: 'text) FROM anon; DROP TABLE users; --' }],
      }),
    ).toThrow(/Unsafe SQL argument list/);
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
    expect(() => buildSecurityStatements({ tables: ['users"; DROP TABLE users; --'] })).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});

describe('the runtime role grants', () => {
  const tables = ['profiles', 'users'];
  const statements = buildSecurityStatements({
    tables,
    sequences: ['users_id_seq'],
    appRole: 'six7swe_app',
  });
  const joined = statements.join('\n');

  it('grants row access and nothing else on every table', () => {
    for (const table of tables) {
      expect(joined).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."${table}" TO "six7swe_app";`,
      );
    }
    expect(joined).not.toMatch(/GRANT ALL/);
    expect(joined).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER/);
  });

  it('revokes what was granted by hand before granting', () => {
    const revoke = statements.indexOf(
      'REVOKE ALL PRIVILEGES ON TABLE public."users" FROM "six7swe_app";',
    );
    const grant = statements.indexOf(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."users" TO "six7swe_app";',
    );
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
    expect(() => buildSecurityStatements({ tables, appRole: OWNER_ROLE })).toThrow(/table owner/);
  });

  it('refuses a role name that is not a plain identifier', () => {
    expect(() =>
      buildSecurityStatements({ tables, appRole: 'app"; DROP TABLE users; --' }),
    ).toThrow(/Unsafe SQL identifier/);
  });
});

describe('a renamed runtime role', () => {
  const statements = buildSecurityStatements({
    tables: ['users'],
    appRole: 'six7swe_app_v2',
    formerRoles: ['six7swe_app'],
  });
  const joined = statements.join('\n');

  it('revokes the former role grants, default privileges and login', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "six7swe_app";',
    );
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "six7swe_app";',
    );
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM "six7swe_app";',
    );
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "six7swe_app";',
    );
    expect(joined).toContain('ALTER ROLE "six7swe_app" NOLOGIN;');
  });

  it('shuts the former role out before the new one is granted', () => {
    const nologin = statements.indexOf('ALTER ROLE "six7swe_app" NOLOGIN;');
    const firstGrant = statements.findIndex((statement) => statement.startsWith('GRANT '));
    expect(nologin).toBeGreaterThan(-1);
    expect(firstGrant).toBeGreaterThan(nologin);
  });

  it('never shuts out the current runtime role', () => {
    const same = buildSecurityStatements({
      tables: ['users'],
      appRole: 'six7swe_app',
      formerRoles: ['six7swe_app'],
    }).join('\n');
    expect(same).not.toContain('NOLOGIN');
  });

  it('picks former roles only from roles db:secure could have provisioned', () => {
    expect(
      selectFormerRoles(
        [
          'anon',
          'authenticated',
          'service_role',
          'postgres',
          'supabase_admin',
          'pg_read_all_data',
          'six7swe_app_v2',
          'six7swe_app',
          'Weird"Name',
          'six7swe_app',
        ],
        'six7swe_app_v2',
      ),
    ).toEqual(['six7swe_app']);
  });

  it('treats every non-reserved grantee as former when the backend runs as the owner', () => {
    expect(selectFormerRoles(['six7swe_app', 'anon'], null)).toEqual(['six7swe_app']);
  });
});
