import {
  ProfileNotFoundError,
  RefreshInProgressError,
} from '../../services/jobHunt/jobRefreshService';
import {
  createRefreshScheduler,
  type RefreshSchedulerDeps,
} from '../../services/jobHunt/refreshScheduler';
import type { RefreshStatus } from '../../db/schema/jobHunt';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 12);

function setup(options: {
  profileIds: number[];
  lastStarted?: Record<number, Date | null>;
  start?: (profileId: number) => Promise<{ refreshStatusId: number }>;
}) {
  const statuses = new Map<number, RefreshStatus['status']>();
  let nextId = 100;
  const start = jest.fn(
    options.start ??
      (async () => {
        const id = (nextId += 1);
        statuses.set(id, 'IN_PROGRESS');
        return { refreshStatusId: id };
      }),
  );
  const deps: RefreshSchedulerDeps = {
    service: { enqueue: ({ profileId }) => start(profileId) },
    getLatestRefreshStartedAt: async (id) => options.lastStarted?.[id] ?? null,
    getRefreshStatus: async (id) => {
      const status = statuses.get(id);
      return status === undefined ? null : { status };
    },
    logger: { info: jest.fn(), error: jest.fn() },
    now: () => NOW,
  };
  const scheduler = createRefreshScheduler(
    { profileIds: options.profileIds, intervalMs: 24 * HOUR },
    deps,
  );
  return { scheduler, start, statuses, deps };
}

describe('createRefreshScheduler', () => {
  it('does nothing without profiles', async () => {
    const { scheduler, start } = setup({ profileIds: [] });
    await expect(scheduler.tick()).resolves.toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('queues the first due profile, skipping one refreshed within the interval', async () => {
    const { scheduler, start } = setup({
      profileIds: [1, 2],
      lastStarted: { 1: new Date(NOW - 2 * HOUR), 2: new Date(NOW - 30 * HOUR) },
    });
    await expect(scheduler.tick()).resolves.toBe(101);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(2);
  });

  it('queues one refresh at a time and the next once it ends', async () => {
    const { scheduler, start, statuses } = setup({ profileIds: [1, 2] });
    await scheduler.tick();
    await expect(scheduler.tick()).resolves.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);

    statuses.set(101, 'COMPLETED');
    await expect(scheduler.tick()).resolves.toBe(102);
    expect(start).toHaveBeenLastCalledWith(1);
  });

  it('moves past a profile another process is refreshing', async () => {
    const { scheduler, start } = setup({
      profileIds: [1, 2],
      start: async (profileId) => {
        if (profileId === 1) throw new RefreshInProgressError(1);
        return { refreshStatusId: 7 };
      },
    });
    await expect(scheduler.tick()).resolves.toBe(7);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('waits out the interval after a permanent failure, retries a transient one', async () => {
    const { scheduler, start } = setup({
      profileIds: [1, 2],
      start: async (profileId) => {
        throw profileId === 1 ? new ProfileNotFoundError(1) : new Error('connection reset');
      },
    });
    await scheduler.tick();
    await scheduler.tick();
    expect(start.mock.calls.map(([id]) => id)).toEqual([1, 2, 2]);
  });
});
