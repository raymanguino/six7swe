/**
 * Runs the lockdown against a real Postgres.
 *
 * The statement tests pin the SQL; this one checks what Postgres makes of it:
 * provision and secure (twice, since `db:secure` runs on every deploy), then
 * connect as the runtime role and check it can write rows but not change the
 * schema, that no function is left executable by anon or PUBLIC, that a
 * failed role check keeps the lockdown, and that a renamed runtime role shuts
 * the old one out.
 *
 * It uses the local Supabase Postgres (`LOCKDOWN_TEST_DATABASE_URL` overrides
 * it) and works in a throwaway database, so the development data is never
 * touched. It is skipped when no Supabase Postgres answers, unless
 * `LOCKDOWN_TEST_REQUIRED=1`, which turns the skip into a failure.
 */

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { applyLockdown } from '../../../scripts/db-lockdown';

const ADMIN_URL =
  process.env.LOCKDOWN_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54322/postgres';

/**
 * Connects and checks the `anon` role exists, in a child process: Jest has to
 * decide synchronously whether to skip. Exit 0 ready, 2 not Supabase, else down.
 */
function probeDatabase(): string | null {
  const script = `
    const mod = require('postgres');
    const sql = (mod.default ?? mod)(process.env.PROBE_URL, { max: 1, connect_timeout: 3, onnotice() {} });
    sql\`select to_regrole('anon') is not null as anon\`
      .then(async ([row]) => { await sql.end({ timeout: 1 }); process.exit(row.anon ? 0 : 2); })
      .catch(() => process.exit(1));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, PROBE_URL: ADMIN_URL },
    timeout: 10_000,
  });
  if (result.status === 0) return null;
  return result.status === 2 ? 'the database has no anon role (not Supabase)' : 'unreachable';
}

const unavailable = probeDatabase();
const required = process.env.LOCKDOWN_TEST_REQUIRED === '1';
const describeWithDatabase = unavailable === null || required ? describe : describe.skip;

describeWithDatabase('the lockdown against a real database', () => {
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`;
  const database = `six7swe_lockdown_test_${suffix}`;
  const roleA = { role: `six7swe_lt_a_${suffix}`, password: randomBytes(32).toString('hex') };
  const roleB = { role: `six7swe_lt_b_${suffix}`, password: randomBytes(32).toString('hex') };
  const bystander = { role: `six7swe_lt_bi_${suffix}`, password: randomBytes(32).toString('hex') };
  const quiet = { max: 1, onnotice: () => undefined };

  const urlFor = (credentials?: { role: string; password: string }): string => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${database}`;
    if (credentials) {
      url.username = credentials.role;
      url.password = credentials.password;
    }
    return url.toString();
  };

  let admin: postgres.Sql | undefined;
  let owner: postgres.Sql;

  /** Runs `fn` connected as a role, always closing the connection. */
  async function asRole<T>(
    credentials: { role: string; password: string },
    fn: (sql: postgres.Sql) => Promise<T>,
  ): Promise<T> {
    const sql = postgres(urlFor(credentials), quiet);
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  beforeAll(async () => {
    if (unavailable !== null) {
      throw new Error(`LOCKDOWN_TEST_REQUIRED=1 but the database is ${unavailable}.`);
    }
    admin = postgres(ADMIN_URL, quiet);
    await admin.unsafe(`create database "${database}"`);
    await admin.unsafe(`create role "${bystander.role}" login password '${bystander.password}'`);
    owner = postgres(urlFor(), quiet);
    await owner.unsafe(`
      create table public.items (id serial primary key, name text not null);
      create function public.add_one(i integer) returns integer language sql as 'select i + 1';
      create function public.add_one(i bigint) returns bigint language sql as 'select i + 1';
      create function public.whoami() returns text language sql security definer
        as 'select current_user::text';
      alter default privileges in schema public grant select on tables to "${bystander.role}";
    `);
  }, 30_000);

  afterAll(async () => {
    try {
      await owner?.end();
    } finally {
      try {
        await admin?.unsafe(`drop database if exists "${database}" with (force)`);
      } finally {
        try {
          for (const role of [roleA.role, roleB.role, bystander.role]) {
            await admin?.unsafe(`drop role if exists "${role}"`);
          }
        } finally {
          await admin?.end();
        }
      }
    }
  }, 30_000);

  it('provisions and secures, and a second run changes nothing', async () => {
    const first = await applyLockdown(owner, roleA);
    const second = await applyLockdown(owner, roleA);
    expect(first.tables).toEqual(['items']);
    expect(second.statements).toBe(first.statements);
    expect(second.formerRoles).toEqual([]);
  }, 30_000);

  it('lets the runtime role write rows but not change the schema', async () => {
    await asRole(roleA, async (sql) => {
      await expect(
        sql`insert into public.items (name) values ('ok') returning id`,
      ).resolves.toHaveLength(1);
      await expect(sql`select name from public.items`).resolves.toEqual([{ name: 'ok' }]);
      await expect(sql.unsafe('create table public.sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql.unsafe('truncate public.items')).rejects.toThrow(/permission denied/);
      await expect(sql`select public.whoami()`).rejects.toThrow(/permission denied/);
    });
  }, 30_000);

  it('leaves no function in public executable by anon or PUBLIC', async () => {
    const open = await owner<{ signature: string }[]>`
      select p.oid::regprocedure::text as signature from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (
        has_function_privilege('anon', p.oid, 'EXECUTE') or exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    `;
    const [{ count }] = await owner<{ count: number }[]>`
      select count(*)::int as count from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    `;
    expect(count).toBe(3);
    expect(open).toEqual([]);
  });

  it('keeps the lockdown when the role check fails', async () => {
    await owner.unsafe(`
      alter table public.items disable row level security;
      grant all on table public.items to anon;
      grant execute on function public.whoami() to "${roleA.role}";
    `);
    await expect(applyLockdown(owner, roleA)).rejects.toThrow(/SECURITY DEFINER/);

    const [state] = await owner<{ anon: boolean; rls: boolean }[]>`
      select has_table_privilege('anon', 'public.items', 'SELECT') as anon,
        relrowsecurity as rls from pg_class where oid = 'public.items'::regclass
    `;
    expect(state).toEqual({ anon: false, rls: true });

    await owner.unsafe(`revoke execute on function public.whoami() from "${roleA.role}"`);
    await expect(applyLockdown(owner, roleA)).resolves.toMatchObject({ appRole: roleA.role });
  }, 30_000);

  it('shuts the old role out when the runtime role is renamed, and only it', async () => {
    const lingering = postgres(urlFor(roleA), quiet);
    try {
      await lingering`select 1`;
      const result = await applyLockdown(owner, roleB);
      expect(result.formerRoles).toEqual([roleA.role]);
      expect(result.endedSessions).toBe(1);
      await expect(lingering`select 1`).rejects.toThrow();
    } finally {
      await lingering.end({ timeout: 1 });
    }

    const roles = await owner<
      { rolname: string; login: boolean; insert: boolean; defaults: boolean }[]
    >`
      select r.rolname, r.rolcanlogin as login,
        has_table_privilege(r.oid, 'public.items', 'INSERT') as insert,
        exists (
          select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
          where a.grantee = r.oid
        ) as defaults
      from pg_roles r where r.rolname in (${roleA.role}, ${bystander.role}) order by 1
    `;
    expect(roles).toEqual([
      { rolname: roleA.role, login: false, insert: false, defaults: false },
      // Not marked as a runtime role, so left alone despite its default privileges.
      { rolname: bystander.role, login: true, insert: false, defaults: true },
    ]);

    await expect(asRole(roleA, (sql) => sql`select 1`)).rejects.toThrow(/not permitted to log in/);
    await asRole(roleB, async (sql) => {
      await expect(sql`insert into public.items (name) values ('new')`).resolves.toBeDefined();
    });
  }, 30_000);

  it('reports a routine the owner cannot revoke instead of failing on it', async () => {
    // The bystander creates it itself: granting the role to the owner instead
    // crashes the local Supabase Postgres (a segfault in `GRANT role TO current_user`).
    await owner.unsafe(`grant create on schema public to "${bystander.role}"`);
    await asRole(bystander, (sql) =>
      sql.unsafe(
        "create function public.foreign_definer() returns int language sql security definer as 'select 1'",
      ),
    );
    await owner.unsafe(`revoke create on schema public from "${bystander.role}"`);
    const result = await applyLockdown(owner, roleB);
    expect(result.skippedFunctions).toEqual([
      { signature: 'foreign_definer()', owner: bystander.role, extension: null, definer: true },
    ]);
  }, 30_000);
});
