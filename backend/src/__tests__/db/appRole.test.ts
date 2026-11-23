/**
 * Guards the backend's runtime database role.
 *
 * `DATABASE_URL` names a role that can read and write the rows but owns no
 * table, so a process that leaks its environment does not leak the owner's
 * rights. These tests pin how that role is derived and created.
 */

import {
  buildAppRoleStatements,
  describeRoleProblems,
  resolveRuntimeRole,
  roleFromUrl,
  scramSha256Verifier,
} from '../../db/appRole';

const OWNER = 'postgres://postgres.abcd:ownerpw@pooler.example.com:5432/postgres';
const PASSWORD = 'a'.repeat(31) + '@';
const app = (user: string, password = encodeURIComponent(PASSWORD)): string =>
  `postgres://${user}.abcd:${password}@pooler.example.com:5432/postgres`;
const APP = app('six7swe_app');

describe('roleFromUrl', () => {
  it('drops the Supabase pooler project suffix from the user name', () => {
    expect(roleFromUrl(APP)).toEqual({ role: 'six7swe_app', password: PASSWORD });
  });

  it('rejects a role name that is not a plain identifier', () => {
    expect(() => roleFromUrl('postgres://App%22x:pw@host/db')).toThrow(/plain lower-case/);
  });

  it('rejects a malformed URL or escape without echoing it', () => {
    expect(() => roleFromUrl('not a url secret')).toThrow('not a valid connection string');
    expect(() => roleFromUrl('postgres://u:se%E0cret@host/db')).toThrow(
      /^The database URL is not a valid connection string\.$/,
    );
  });
});

describe('resolveRuntimeRole', () => {
  it('returns the runtime role when it differs from the owner', () => {
    expect(resolveRuntimeRole(OWNER, APP, 'postgres', true)).toEqual({
      role: 'six7swe_app',
      password: PASSWORD,
    });
  });

  it('allows running as the owner locally only', () => {
    expect(resolveRuntimeRole(OWNER, OWNER, 'postgres', false)).toBeNull();
    expect(() => resolveRuntimeRole(OWNER, OWNER, 'postgres', true)).toThrow(
      /other than the owner/,
    );
  });

  it('refuses a migration URL that does not connect as the owner', () => {
    expect(() => resolveRuntimeRole(APP, OWNER, 'postgres', true)).toThrow(
      /must connect as postgres/,
    );
  });

  it.each([
    'pg_monitor',
    'supabase_admin',
    'anon',
    'authenticated',
    'service_role',
    'authenticator',
    'dashboard_user',
  ])('refuses the reserved role %s', (role) => {
    expect(() => resolveRuntimeRole(OWNER, app(role), 'postgres', true)).toThrow(/reserved role/);
  });

  it('refuses a password shorter than 32 characters', () => {
    expect(() => resolveRuntimeRole(OWNER, app('six7swe_app', 'short'), 'postgres', true)).toThrow(
      /at least 32/,
    );
  });
});

describe('scramSha256Verifier', () => {
  it('matches the verifier Postgres accepts for the password', () => {
    // Checked by creating a role with this verifier on Postgres 17 and logging in with "pencil".
    expect(scramSha256Verifier('pencil', Buffer.alloc(16, 7))).toBe(
      'SCRAM-SHA-256$4096:BwcHBwcHBwcHBwcHBwcHBw==' +
        '$K97YndbwHX05fl7lN8Bcm3gG4nc43WvYj0OL1dbknsk=:tvU6S2vfOxKAzPZ5dC4h+cucyZ553rNC2MQ2ZJzmu3g=',
    );
  });

  it('salts each verifier differently', () => {
    expect(scramSha256Verifier('pencil')).not.toBe(scramSha256Verifier('pencil'));
  });

  it('rejects an empty or non-ASCII password, which SASLprep could change', () => {
    expect(() => scramSha256Verifier('')).toThrow(/printable ASCII/);
    expect(() => scramSha256Verifier('pässword')).toThrow(/printable ASCII/);
  });
});

describe('buildAppRoleStatements', () => {
  const verifier = scramSha256Verifier('pencil', Buffer.alloc(16, 7));
  const statements = buildAppRoleStatements('six7swe_app', verifier);
  const joined = statements.join('\n');

  it('creates the role only when it is missing', () => {
    expect(joined).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'six7swe_app')",
    );
    expect(joined).toContain('CREATE ROLE "six7swe_app" LOGIN;');
  });

  it('sets the password as a verifier, never in plain text', () => {
    expect(joined).toContain(`ALTER ROLE "six7swe_app" WITH LOGIN PASSWORD '${verifier}';`);
    expect(joined).not.toContain('pencil');
  });

  it('grants no attribute beyond LOGIN', () => {
    expect(joined).not.toMatch(/SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|IN ROLE/);
  });

  it('refuses an unsafe role name or a value that is not a verifier', () => {
    expect(() => buildAppRoleStatements('x"; DROP ROLE postgres; --', verifier)).toThrow(
      /Unsafe SQL identifier/,
    );
    expect(() => buildAppRoleStatements('six7swe_app', "pencil'; DROP ROLE postgres; --")).toThrow(
      /not a SCRAM-SHA-256 verifier/,
    );
  });
});

describe('describeRoleProblems', () => {
  const safe = {
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    owner_member: false,
    member_of_any: false,
    owns_objects: false,
    can_create: false,
  };

  it('accepts a role that only logs in', () => {
    expect(describeRoleProblems('six7swe_app', 'postgres', safe)).toEqual([]);
  });

  it('names every right that would put the owner back behind DATABASE_URL', () => {
    const all = Object.fromEntries(Object.keys(safe).map((key) => [key, true])) as typeof safe;
    const problems = describeRoleProblems('six7swe_app', 'postgres', all);
    expect(problems).toHaveLength(9);
    expect(problems).toContain('six7swe_app is a member of another role');
    expect(problems).toContain('six7swe_app can start replication');
    expect(problems).toContain('six7swe_app owns objects in the public schema');
    expect(problems).toContain('six7swe_app is a member of postgres');
    expect(problems).toContain('six7swe_app bypasses row level security');
  });
});
