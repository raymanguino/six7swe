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
  buildAppAccessStatements,
  buildLockdownStatements,
  OWNER_ROLE,
} from '../../db/security';
import { selectFormerRoles } from '../../db/securityCatalog';

describe('the database lockdown', () => {
  const tables = ['profiles', 'users'];
  const statements = buildLockdownStatements({
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

  it('revokes the public grants from every table and sequence', () => {
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public."profiles", public."users" FROM anon, authenticated;',
    );
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

  it('revokes every routine by its full signature, from PUBLIC too', () => {
    // A public function is an RPC endpoint, and anon inherits PUBLIC's EXECUTE.
    expect(joined).toContain(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"(), public."search_jobs"(text, integer), ' +
        'public."tag_match"(character varying, text[]) FROM anon, authenticated, PUBLIC;',
    );
  });

  it('revokes the default function privilege so a new function stays closed', () => {
    // The global form: the schema-scoped revoke leaves the built-in EXECUTE in place.
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
    );
  });

  it('grants nothing and creates no policy', () => {
    expect(joined).not.toContain('CREATE POLICY');
    expect(joined).not.toContain('GRANT ');
  });

  it('issues no list statement for an empty list', () => {
    const empty = buildLockdownStatements({ tables: [], sequences: [], functions: [] });
    expect(empty.join('\n')).not.toMatch(/ON (TABLE|SEQUENCE|ROUTINE) /);
  });

  it('refuses an identifier or argument list that is not plain', () => {
    expect(() =>
      buildLockdownStatements({
        tables: ['users"; DROP TABLE users; --'],
        sequences: [],
        functions: [],
      }),
    ).toThrow(/Unsafe SQL identifier/);
    expect(() =>
      buildLockdownStatements({
        tables: [],
        sequences: [],
        functions: [{ name: 'f', args: 'text) FROM anon; DROP TABLE users; --' }],
      }),
    ).toThrow(/Unsafe SQL argument list/);
  });
});

describe('the runtime role grants', () => {
  const tables = ['profiles', 'users'];
  const objects = { tables, sequences: ['users_id_seq'] };
  const statements = buildAppAccessStatements(objects, 'six7swe_app', []);
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

  it('revokes nothing from the browser roles, which the lockdown already did', () => {
    expect(joined).not.toMatch(/FROM (anon|authenticated|PUBLIC)/);
  });

  it('refuses the owner or a role name that is not a plain identifier', () => {
    expect(() => buildAppAccessStatements(objects, OWNER_ROLE, [])).toThrow(/table owner/);
    expect(() => buildAppAccessStatements(objects, 'app"; DROP TABLE users; --', [])).toThrow(
      /Unsafe SQL identifier/,
    );
  });
});

describe('a renamed runtime role', () => {
  const statements = buildAppAccessStatements(
    { tables: ['users'], sequences: [] },
    'six7swe_app_v2',
    ['six7swe_app'],
  );
  const joined = statements.join('\n');

  it('revokes the former role grants, default privileges and login', () => {
    for (const kind of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
      expect(joined).toContain(
        `REVOKE ALL PRIVILEGES ON ALL ${kind} IN SCHEMA public FROM "six7swe_app";`,
      );
    }
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM "six7swe_app";',
    );
    expect(joined).toContain('ALTER ROLE "six7swe_app" NOLOGIN;');
  });

  it('shuts the former role out before the new one is granted', () => {
    const nologin = statements.indexOf('ALTER ROLE "six7swe_app" NOLOGIN;');
    const firstGrant = statements.findIndex((statement) => statement.startsWith('GRANT '));
    expect(nologin).toBeGreaterThan(-1);
    expect(firstGrant).toBeGreaterThan(nologin);
  });

  it('never shuts out the current runtime role or the owner', () => {
    const same = buildAppAccessStatements({ tables: [], sequences: [] }, 'six7swe_app', [
      'six7swe_app',
    ]);
    expect(same.join('\n')).not.toContain('NOLOGIN');
    expect(() =>
      buildAppAccessStatements({ tables: [], sequences: [] }, null, [OWNER_ROLE]),
    ).toThrow(/cannot be shut out/);
  });

  it('picks former roles only among marked roles db:secure could have provisioned', () => {
    const marked = [
      'anon',
      'postgres',
      'supabase_admin',
      'pgbouncer',
      'cli_login_postgres',
      'pgsodium_keyholder',
      'six7swe_app_v2',
      'six7swe_app',
      'Weird"Name',
      'six7swe_app',
    ];
    expect(selectFormerRoles(marked, 'six7swe_app_v2')).toEqual(['six7swe_app']);
    expect(selectFormerRoles(['six7swe_app'], null)).toEqual(['six7swe_app']);
  });
});
