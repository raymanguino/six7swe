/**
 * The refresh queue on `refresh_status` (#253) against a real Postgres (see
 * `lockdownDatabase.ts`): a throwaway database migrated from `migrations/`,
 * queried through `db/api/refreshStatus.ts` itself.
 */

import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';
import { databaseUrl, describeWithDatabase, runSuffix, useTestDatabase } from './lockdownDatabase';

type RefreshApi = typeof import('../../db/api/refreshStatus');

describeWithDatabase('the refresh queue against a real database', () => {
  const database = `six7swe_queue_test_${runSuffix()}`;
  const db = useTestDatabase(database, 'select 1', [], []);
  let api: RefreshApi;
  let closeClient: () => Promise<void>;
  let nextProfile = 0;

  beforeAll(async () => {
    await migrate(drizzle(db.owner), {
      migrationsFolder: path.resolve(__dirname, '../../../migrations'),
    });
    // The database client reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = databaseUrl(database);
    const client = await import('../../db/index');
    closeClient = () => client.db.$client.end();
    api = await import('../../db/api/refreshStatus');
    await db.owner`insert into users (name, email) values ('Owner', null)`;
  }, 60_000);

  afterAll(async () => {
    await closeClient?.();
  });

  /** A new profile, so each test starts with no active refresh. */
  async function newProfile(): Promise<number> {
    nextProfile += 1;
    const [row] = await db.owner<{ id: number }[]>`
      insert into profiles (user_id, name, keywords, location)
      values (1, ${`p${nextProfile}`}, '{}', '105149290') returning id`;
    if (!row) throw new Error('no profile');
    return row.id;
  }

  /** Moves a row's timestamps into the past, as if it had been left there. */
  async function age(id: number, minutes: number): Promise<void> {
    const past = new Date(Date.now() - minutes * 60_000);
    await db.owner`
      update refresh_status
      set heartbeat_at = case when heartbeat_at is null then null else ${past.toISOString()}::timestamp end,
          updated_at = ${past.toISOString()}::timestamp, created_at = ${past.toISOString()}::timestamp
      where id = ${id}`;
  }

  /** Ends a row as its runner would, whoever claimed it. */
  const finish = (id: number) =>
    db.owner`update refresh_status set status = 'COMPLETED' where id = ${id}`;

  it('queues a refresh unclaimed and keeps one active refresh per profile', async () => {
    const profileId = await newProfile();
    const queued = await api.enqueueRefresh(profileId);
    expect(queued).toMatchObject({
      status: 'PENDING',
      claimedBy: null,
      heartbeatAt: null,
      description: api.QUEUED_DESCRIPTION,
    });

    await expect(api.enqueueRefresh(profileId)).rejects.toBeInstanceOf(ActiveRefreshExistsError);
    await expect(api.newProfileRefreshStatus(profileId, 'api')).rejects.toBeInstanceOf(
      ActiveRefreshExistsError,
    );
    expect(await api.getActiveRefreshForProfile(profileId)).toMatchObject({ id: queued.id });

    await finish(queued.id);
    await expect(api.enqueueRefresh(profileId)).resolves.toMatchObject({ status: 'PENDING' });
  }, 30_000);

  it('inserts an in-process refresh already claimed, so no worker claims it', async () => {
    const profileId = await newProfile();
    const row = await api.newProfileRefreshStatus(profileId, 'api-1');
    expect(row).toMatchObject({ claimedBy: 'api-1' });
    expect(row.heartbeatAt).toBeInstanceOf(Date);

    const claimed = await api.claimNextRefresh('worker');
    expect(claimed?.id).not.toBe(row.id);
    if (claimed) await finish(claimed.id);
    await finish(row.id);
  }, 30_000);

  it('claims the oldest queued refresh, and concurrent claims never share a row', async () => {
    // Drain anything earlier tests left queued.
    while (await api.claimNextRefresh('drain')) {
      /* claimed */
    }
    const queued: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      queued.push((await api.enqueueRefresh(await newProfile())).id);
    }

    const first = await api.claimNextRefresh('w-0');
    expect(first?.id).toBe(queued[0]);

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) => api.claimNextRefresh(`w-${i + 1}`)),
    );
    const won = claims.flatMap((row) => (row ? [row] : []));
    const ids = won.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => queued.slice(1).includes(id))).toBe(true);

    // A row a lost race skipped is still queued; nothing is claimed twice.
    const rest: number[] = [];
    for (
      let row = await api.claimNextRefresh('late');
      row;
      row = await api.claimNextRefresh('late')
    ) {
      rest.push(row.id);
    }
    expect([...ids, ...rest].sort()).toEqual(queued.slice(1).sort());

    const rows = await db.owner<{ id: number; claimed_by: string }[]>`
      select id, claimed_by from refresh_status where id in ${db.owner(queued)}`;
    expect(rows.every((row) => row.claimed_by !== null)).toBe(true);
    await expect(api.claimNextRefresh('none-left')).resolves.toBeNull();
  }, 30_000);

  it('heartbeats only the claimant’s active claim', async () => {
    const profileId = await newProfile();
    const row = await api.newProfileRefreshStatus(profileId, 'owner-proc');
    const beatAt = async () => (await api.getRefreshStatus(row.id))?.heartbeatAt?.getTime();
    // A status write is a heartbeat too.
    await age(row.id, 10);
    await api.updateRefreshStatus(row.id, 'owner-proc', { description: 'scoring' });
    expect(await beatAt()).toBeGreaterThan(Date.now() - 60_000);
    await age(row.id, 10);

    await expect(api.heartbeatRefresh(row.id, 'someone-else')).resolves.toBe(false);
    await expect(api.heartbeatRefresh(row.id, 'owner-proc')).resolves.toBe(true);
    expect(await beatAt()).toBeGreaterThan(Date.now() - 60_000);

    await expect(api.endSuccess(row.id, 'someone-else')).resolves.toBe(false);
    await expect(api.endSuccess(row.id, 'owner-proc')).resolves.toBe(true);
    await expect(api.heartbeatRefresh(row.id, 'owner-proc')).resolves.toBe(false);
  }, 30_000);

  it('fails stale claims and old unclaimed rows, never a live run or a finished one', async () => {
    const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
    const inProgress = { status: 'IN_PROGRESS', step: 'FETCHING_JOBS' } as const;

    // Claimed, heartbeat stale: the runner died.
    const dead = await api.newProfileRefreshStatus(await newProfile(), 'dead');
    await api.updateRefreshStatus(dead.id, 'dead', inProgress);
    await age(dead.id, 60);

    // Claimed, no status write for an hour, but still heartbeating: a long scoring phase.
    const live = await api.newProfileRefreshStatus(await newProfile(), 'live');
    await api.updateRefreshStatus(live.id, 'live', inProgress);
    await age(live.id, 60);
    await api.heartbeatRefresh(live.id, 'live');

    // Claimed an hour ago, never heartbeaten: the claim time stands in.
    const unbeaten = await api.newProfileRefreshStatus(await newProfile(), 'u');
    await db.owner`update refresh_status set heartbeat_at = null,
      claimed_at = ${minutesAgo(60).toISOString()}::timestamp where id = ${unbeaten.id}`;

    // Queued for an hour: left for a worker. Queued for 8 hours: no worker came.
    const queued = await api.enqueueRefresh(await newProfile());
    await age(queued.id, 60);
    const abandoned = await api.enqueueRefresh(await newProfile());
    await age(abandoned.id, 480);

    // From before the queue (no claim): its last write stands in for the heartbeat.
    const legacy = await api.enqueueRefresh(await newProfile());
    await db.owner`update refresh_status set status = 'IN_PROGRESS' where id = ${legacy.id}`;
    await age(legacy.id, 60);

    const done = await api.newProfileRefreshStatus(await newProfile(), 'done');
    await api.endSuccess(done.id, 'done');
    await age(done.id, 60);

    await expect(api.failStaleRefreshes(minutesAgo(30), minutesAgo(360))).resolves.toBe(4);

    const status = async (id: number) => (await api.getRefreshStatus(id))?.status;
    for (const row of [dead, unbeaten, abandoned, legacy]) {
      expect(await status(row.id)).toBe('FAILED');
    }
    // A row no worker claimed says so; a dead run says its process stopped.
    expect((await api.getRefreshStatus(abandoned.id))?.description).toMatch(/No job worker/);
    expect((await api.getRefreshStatus(dead.id))?.description).toMatch(/process running it/);
    expect(await status(live.id)).toBe('IN_PROGRESS');
    expect(await status(queued.id)).toBe('PENDING');
    expect(await status(done.id)).toBe('COMPLETED');

    // A reaped run can no longer write its row, and the profile is free again.
    await expect(api.heartbeatRefresh(dead.id, 'dead')).resolves.toBe(false);
    await expect(api.updateRefreshStatus(dead.id, 'dead', inProgress)).resolves.toBe(false);
    await expect(api.endSuccess(dead.id, 'dead')).resolves.toBe(false);
    expect(await status(dead.id)).toBe('FAILED');
    await expect(api.enqueueRefresh(dead.profileId)).resolves.toMatchObject({ status: 'PENDING' });
  }, 30_000);
});
