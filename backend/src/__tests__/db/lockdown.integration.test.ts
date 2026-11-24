/**
 * Runs the lockdown against a real Postgres (see `lockdownDatabase.ts`) to
 * check what Postgres makes of the SQL the statement tests pin.
 */

import { applyLockdown } from '../../../scripts/db-lockdown';
import { credentials, describeWithDatabase, runSuffix, useTestDatabase } from './lockdownDatabase';

describeWithDatabase('the lockdown against a real database', () => {
  const suffix = runSuffix();
  const roleA = credentials(`six7swe_lt_a_${suffix}`);
  const roleB = credentials(`six7swe_lt_b_${suffix}`);
  const bystander = credentials(`six7swe_lt_bi_${suffix}`);
  const db = useTestDatabase(
    `six7swe_lockdown_test_${suffix}`,
    `create table public.items (id serial primary key, name text not null);
    create function public.add_one(i integer) returns integer language sql as 'select i + 1';
    create function public.add_one(i bigint) returns bigint language sql as 'select i + 1';
    create function public.whoami() returns text language sql security definer
      as 'select current_user::text';
    alter default privileges in schema public grant select on tables to "${bystander.role}";`,
    [bystander],
    [roleA, roleB, bystander],
  );
  const asRole = db.asRole;

  it('provisions and secures, and a second run changes nothing', async () => {
    const first = await applyLockdown(db.owner, roleA);
    const second = await applyLockdown(db.owner, roleA);
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
    const open = await db.owner<{ signature: string }[]>`
      select p.oid::regprocedure::text as signature from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (
        has_function_privilege('anon', p.oid, 'EXECUTE') or exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    `;
    const [{ count }] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    `;
    expect(count).toBe(3);
    expect(open).toEqual([]);
  });

  it('keeps the lockdown when the role check fails', async () => {
    await db.owner.unsafe(`
      alter table public.items disable row level security;
      grant all on table public.items to anon;
      grant execute on function public.whoami() to "${roleA.role}";
    `);
    await expect(applyLockdown(db.owner, roleA)).rejects.toThrow(/SECURITY DEFINER/);

    const [state] = await db.owner<{ anon: boolean; rls: boolean }[]>`
      select has_table_privilege('anon', 'public.items', 'SELECT') as anon,
        relrowsecurity as rls from pg_class where oid = 'public.items'::regclass
    `;
    expect(state).toEqual({ anon: false, rls: true });

    await db.owner.unsafe(`revoke execute on function public.whoami() from "${roleA.role}"`);
    await expect(applyLockdown(db.owner, roleA)).resolves.toMatchObject({ appRole: roleA.role });
  }, 30_000);

  it('shuts the old role out when the runtime role is renamed, and only it', async () => {
    // Another database's runtime role in the same cluster must be left alone.
    await db.admin.unsafe(`comment on role "${bystander.role}" is 'six7swe-runtime:other_db'`);
    const lingering = db.connect(roleA);
    try {
      await lingering`select 1`;
      const result = await applyLockdown(db.owner, roleB);
      expect(result.formerRoles).toEqual([roleA.role]);
      expect(result.endedSessions).toBe(1);
      await expect(lingering`select 1`).rejects.toThrow();
    } finally {
      await lingering.end({ timeout: 1 });
    }

    const roles = await db.owner<
      { rolname: string; login: boolean; insert: boolean; defaults: boolean; mark: string | null }[]
    >`
      select r.rolname, r.rolcanlogin as login, shobj_description(r.oid, 'pg_authid') as mark,
        has_table_privilege(r.oid, 'public.items', 'INSERT') as insert,
        exists (
          select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
          where a.grantee = r.oid
        ) as defaults
      from pg_roles r where r.rolname in (${roleA.role}, ${bystander.role}) order by 1
    `;
    expect(roles).toEqual([
      { rolname: roleA.role, login: false, insert: false, defaults: false, mark: null },
      // Not marked for this database, so left alone despite its default privileges.
      {
        rolname: bystander.role,
        login: true,
        insert: false,
        defaults: true,
        mark: expect.any(String),
      },
    ]);
    // A role marked for something else is never adopted as the runtime role.
    await expect(applyLockdown(db.owner, bystander)).rejects.toThrow(/refusing to adopt/);

    await expect(asRole(roleA, (sql) => sql`select 1`)).rejects.toThrow(/not permitted to log in/);
    await asRole(roleB, async (sql) => {
      await expect(sql`insert into public.items (name) values ('new')`).resolves.toBeDefined();
    });
  }, 30_000);
});
