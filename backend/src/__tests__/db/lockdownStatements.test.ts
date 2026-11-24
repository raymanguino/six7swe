/**
 * Pins what #248 added to the lockdown: routines revoked by full signature,
 * list statements that skip empty lists, and former runtime roles shut out.
 */

import { buildAppAccessStatements, buildLockdownStatements } from '../../db/lockdownStatements';
import { OWNER_ROLE } from '../../db/security';
import { selectFormerRoles } from '../../db/securityCatalog';

describe('routine revokes', () => {
  it('revokes every overload and function with arguments by its full signature', () => {
    const [statement] = buildLockdownStatements({
      tables: [],
      sequences: [],
      functions: [
        { name: 'search_jobs', args: 'text, integer' },
        { name: 'tag_match', args: 'character varying, text[]' },
      ],
    });
    expect(statement).toBe(
      'REVOKE ALL PRIVILEGES ON ROUTINE public."search_jobs"(text, integer), ' +
        'public."tag_match"(character varying, text[]) FROM anon, authenticated, PUBLIC;',
    );
  });

  it('refuses an argument list that could close the signature', () => {
    const functions = [{ name: 'f', args: 'text) FROM anon; DROP TABLE users; --' }];
    expect(() => buildLockdownStatements({ tables: [], sequences: [], functions })).toThrow(
      /Unsafe SQL argument list/,
    );
  });

  it('issues no list statement for an empty list', () => {
    const statements = buildLockdownStatements({ tables: [], sequences: [], functions: [] });
    expect(statements.join('\n')).not.toMatch(/ON (TABLE|SEQUENCE|ROUTINE) /);
    const access = buildAppAccessStatements({ tables: [], sequences: [] }, 'six7swe_app', []);
    expect(access.join('\n')).not.toMatch(/ON (TABLE|SEQUENCE) /);
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
    expect(joined).toContain('REVOKE ALL PRIVILEGES ON SCHEMA public FROM "six7swe_app";');
    expect(joined).toContain('ALTER ROLE "six7swe_app" NOLOGIN;');
  });

  it('shuts the former role out before the new one is granted', () => {
    const nologin = statements.indexOf('ALTER ROLE "six7swe_app" NOLOGIN;');
    const firstGrant = statements.findIndex((statement) => statement.startsWith('GRANT '));
    expect(nologin).toBeGreaterThan(-1);
    expect(firstGrant).toBeGreaterThan(nologin);
  });

  it('never shuts out the current runtime role or the owner', () => {
    const none = { tables: [], sequences: [] };
    const same = buildAppAccessStatements(none, 'six7swe_app', ['six7swe_app']);
    expect(same.join('\n')).not.toContain('NOLOGIN');
    expect(() => buildAppAccessStatements(none, null, [OWNER_ROLE])).toThrow(/cannot be shut out/);
  });

  it('picks former roles only among marked roles db:secure could have provisioned', () => {
    const marked = ['anon', 'postgres', 'supabase_admin', 'pgbouncer', 'cli_login_postgres'];
    marked.push('pgsodium_keyholder', 'six7swe_app_v2', 'six7swe_app', 'Weird"Name', 'six7swe_app');
    expect(selectFormerRoles(marked, 'six7swe_app_v2')).toEqual(['six7swe_app']);
    expect(selectFormerRoles(['six7swe_app'], null)).toEqual(['six7swe_app']);
  });
});
