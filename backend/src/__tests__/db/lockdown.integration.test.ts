/**
 * Runs the lockdown against a real Postgres.
 *
 * The statement tests pin the SQL; this one checks what Postgres makes of it:
 * provision and secure (twice, since `db:secure` runs on every deploy), then
 * connect as the runtime role and check it can write rows but not change the
 * schema, that no function is left executable by PUBLIC, and that a renamed
 * runtime role shuts the old one out.
 *
 * It uses the local Supabase Postgres (`LOCKDOWN_TEST_DATABASE_URL` overrides
 * it) and works in a throwaway database, so the development data is never
 * touched. Without a reachable database it is skipped.
 */

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { applyLockdown } from '../../../scripts/db-lockdown';

const ADMIN_URL =
  process.env.LOCKDOWN_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54322/postgres';

/** A TCP probe in a child process, since Jest has to decide synchronously whether to skip. */
function databaseReachable(url: string): boolean {
  const { hostname, port } = new URL(url);
  const script =
    `const s = require('node:net').connect(${Number(port) || 5432}, ${JSON.stringify(hostname)});` +
    "s.setTimeout(1000); s.on('connect', () => process.exit(0));" +
    "s.on('error', () => process.exit(1)); s.on('timeout', () => process.exit(1));";
  return spawnSync(process.execPath, ['-e', script], { timeout: 3000 }).status === 0;
}

const describeWithDatabase = databaseReachable(ADMIN_URL) ? describe : describe.skip;

describeWithDatabase('the lockdown against a real database', () => {
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`;
  const database = `six7swe_lockdown_test_${suffix}`;
  const roleA = { role: `six7swe_lt_a_${suffix}`, password: randomBytes(32).toString('hex') };
  const roleB = { role: `six7swe_lt_b_${suffix}`, password: randomBytes(32).toString('hex') };
  const quiet = { max: 1, onnotice: () => undefined };

  const urlFor = (user: string | null, password: string | null): string => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${database}`;
    if (user !== null && password !== null) {
      url.username = user;
      url.password = password;
    }
    return url.toString();
  };

  let admin: postgres.Sql;
  let owner: postgres.Sql;

  /** Runs `fn` connected as a role, always closing the connection. */
  async function asRole<T>(
    credentials: { role: string; password: string },
    fn: (sql: postgres.Sql) => Promise<T>,
  ): Promise<T> {
    const sql = postgres(urlFor(credentials.role, credentials.password), quiet);
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, quiet);
    await admin.unsafe(`create database "${database}"`);
    owner = postgres(urlFor(null, null), quiet);
    await owner.unsafe(`
      create table public.items (id serial primary key, name text not null);
      create function public.add_one(i integer) returns integer language sql as 'select i + 1';
      create function public.whoami() returns text language sql security definer
        as 'select current_user::text';
    `);
  }, 30_000);

  afterAll(async () => {
    await owner?.end();
    await admin.unsafe(`drop database if exists "${database}" with (force)`);
    await admin.unsafe(`drop role if exists "${roleA.role}"`);
    await admin.unsafe(`drop role if exists "${roleB.role}"`);
    await admin.end();
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

  it('leaves no function with arguments executable by PUBLIC or anon', async () => {
    const [row] = await owner<{ anon: boolean; app: boolean }[]>`
      select
        has_function_privilege('anon', 'public.add_one(integer)', 'EXECUTE') as anon,
        has_function_privilege(${roleA.role}, 'public.add_one(integer)', 'EXECUTE') as app
    `;
    expect(row).toEqual({ anon: false, app: false });
  });

  it('shuts the old role out when the runtime role is renamed', async () => {
    const result = await applyLockdown(owner, roleB);
    expect(result.formerRoles).toEqual([roleA.role]);

    const [old] = await owner<
      { login: boolean; insert: boolean; usage: boolean; defaults: boolean }[]
    >`
      select
        r.rolcanlogin as login,
        has_table_privilege(r.oid, 'public.items', 'INSERT') as insert,
        has_sequence_privilege(r.oid, 'public.items_id_seq', 'USAGE') as usage,
        exists (
          select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
          where a.grantee = r.oid
        ) as defaults
      from pg_roles r where r.rolname = ${roleA.role}
    `;
    expect(old).toEqual({ login: false, insert: false, usage: false, defaults: false });

    await expect(asRole(roleA, (sql) => sql`select 1`)).rejects.toThrow(/not permitted to log in/);
    await asRole(roleB, async (sql) => {
      await expect(sql`insert into public.items (name) values ('new')`).resolves.toBeDefined();
    });
  }, 30_000);

  it('refuses a runtime role that can execute a SECURITY DEFINER function, and rolls back', async () => {
    await owner.unsafe(`grant execute on function public.whoami() to "${roleB.role}"`);
    await expect(applyLockdown(owner, roleB)).rejects.toThrow(/SECURITY DEFINER/);
    await owner.unsafe(`revoke execute on function public.whoami() from "${roleB.role}"`);
    await expect(applyLockdown(owner, roleB)).resolves.toMatchObject({ appRole: roleB.role });
  }, 30_000);
});
