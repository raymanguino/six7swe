/**
 * Runs the worker role's part of the lockdown (#243) against a real Postgres
 * (see `lockdownDatabase.ts`): the worker reaches only the refresh's tables.
 */

import { applyLockdown } from '../../../scripts/db-lockdown';
import { credentials, describeWithDatabase, runSuffix, useTestDatabase } from './lockdownDatabase';

describeWithDatabase('the worker role against a real database', () => {
  const suffix = runSuffix();
  const app = credentials(`six7swe_wt_app_${suffix}`);
  const worker = credentials(`six7swe_wt_w_${suffix}`);
  const nextWorker = credentials(`six7swe_wt_w2_${suffix}`);
  const db = useTestDatabase(
    `six7swe_worker_test_${suffix}`,
    `create table public.users (id serial primary key, email text, auth_id text);
    create table public.profiles (id serial primary key, user_id integer not null);
    create table public.jobs (id serial primary key, position text not null);
    create table public.profile_jobs (id serial primary key, job_id integer not null);
    create table public.refresh_status (id serial primary key, status text);
    create table public.secrets (id serial primary key, value text);
    insert into public.users (email, auth_id) values ('owner@example.test', 'sub-1');`,
    [],
    [app, worker, nextWorker],
  );

  it('provisions the worker next to the runtime role, idempotently', async () => {
    const first = await applyLockdown(db.owner, app, worker);
    const second = await applyLockdown(db.owner, app, worker);
    expect(first).toMatchObject({ appRole: app.role, workerRole: worker.role });
    expect(second.statements).toBe(first.statements);
    expect(second.formerRoles).toEqual([]);
  }, 30_000);

  it('lets the worker write the refresh tables and read only the user columns it needs', async () => {
    await db.asRole(worker, async (sql) => {
      await expect(
        sql`insert into public.jobs (position) values ('dev') returning id`,
      ).resolves.toHaveLength(1);
      await expect(sql`update public.refresh_status set status = 'x'`).resolves.toBeDefined();
      await expect(sql`select id, auth_id from public.users`).resolves.toEqual([
        { id: 1, auth_id: 'sub-1' },
      ]);
      await expect(sql`select email from public.users`).rejects.toThrow(/permission denied/);
      await expect(sql`delete from public.jobs`).rejects.toThrow(/permission denied/);
      await expect(sql`insert into public.profiles (user_id) values (1)`).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`select * from public.secrets`).rejects.toThrow(/permission denied/);
    });
  }, 30_000);

  it('shuts the former worker out when the worker role changes', async () => {
    const result = await applyLockdown(db.owner, app, nextWorker);
    expect(result.formerRoles).toEqual([worker.role]);
    await expect(db.asRole(worker, (sql) => sql`select 1`)).rejects.toThrow(
      /not permitted to log in/,
    );
  }, 30_000);

  it('refuses the runtime role as the worker', async () => {
    await expect(applyLockdown(db.owner, app, app)).rejects.toThrow(/refusing to adopt/);
  }, 30_000);
});
