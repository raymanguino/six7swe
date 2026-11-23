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
const APP = 'postgres://six7swe_app.abcd:app%40pw@pooler.example.com:5432/postgres';

describe('roleFromUrl', () => {
  it('drops the Supabase pooler project suffix from the user name', () => {
    expect(roleFromUrl(APP)).toEqual({ role: 'six7swe_app', password: 'app@pw' });
  });

  it('reads a plain local user', () => {
    expect(roleFromUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toEqual({
      role: 'postgres',
      password: 'postgres',
    });
  });

  it('rejects a role name that is not a plain identifier', () => {
    expect(() => roleFromUrl('postgres://App%22x:pw@host/db')).toThrow(/plain lower-case/);
  });

  it('rejects something that is not a URL without echoing it', () => {
    expect(() => roleFromUrl('not a url secret')).toThrow('not a valid connection string');
  });
});

describe('resolveRuntimeRole', () => {
  it('returns the runtime role when it differs from the owner', () => {
    expect(resolveRuntimeRole(OWNER, APP, 'postgres')).toEqual({
      role: 'six7swe_app',
      password: 'app@pw',
    });
  });

  it('returns null when the backend connects as the owner', () => {
    expect(resolveRuntimeRole(OWNER, OWNER, 'postgres')).toBeNull();
  });

  it('refuses a migration URL that does not connect as the owner', () => {
    expect(() => resolveRuntimeRole(APP, OWNER, 'postgres')).toThrow(/must connect as postgres/);
  });

  it('refuses a runtime URL without a password', () => {
    const noPassword = 'postgres://six7swe_app.abcd@pooler.example.com:5432/postgres';
    expect(() => resolveRuntimeRole(OWNER, noPassword, 'postgres')).toThrow(/no password/);
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
    owner_member: false,
    owns_tables: false,
    can_create: false,
  };

  it('accepts a role that only logs in', () => {
    expect(describeRoleProblems('six7swe_app', 'postgres', safe)).toEqual([]);
  });

  it('names every right that would put the owner back behind DATABASE_URL', () => {
    const problems = describeRoleProblems('six7swe_app', 'postgres', {
      rolsuper: true,
      rolbypassrls: true,
      rolcreaterole: true,
      rolcreatedb: true,
      owner_member: true,
      owns_tables: true,
      can_create: true,
    });
    expect(problems).toHaveLength(7);
    expect(problems).toContain('six7swe_app is a member of postgres');
    expect(problems).toContain('six7swe_app bypasses row level security');
  });
});
