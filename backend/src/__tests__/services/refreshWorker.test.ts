import type { RefreshStatus } from '../../db/schema/jobHunt';
import {
  ABANDONED_ON_SHUTDOWN,
  createRefreshWorker,
  runWorkerLoop,
  type RefreshWorker,
  type RefreshWorkerDeps,
} from '../../services/jobHunt/refreshWorker';

const MINUTE = 60_000;

function row(id: number): RefreshStatus {
  return {
    id,
    profileId: id,
    status: 'PENDING',
    step: 'PENDING',
    description: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    claimedBy: 'worker',
    claimedAt: new Date(),
    heartbeatAt: new Date(),
  };
}

function setup(queued: RefreshStatus[], overrides: Partial<RefreshWorkerDeps> = {}) {
  let clock = 0;
  const pending = [...queued];
  const claimNext = jest.fn(async () => pending.shift() ?? null);
  const runQueued = jest.fn(async (_refresh: RefreshStatus) => undefined);
  const schedulerTick = jest.fn(async () => null);
  const logger = { info: jest.fn(), error: jest.fn() };
  const failRun = jest.fn(async (_refresh: RefreshStatus, _reason: string) => true);
  const worker = createRefreshWorker({
    queue: { claimNext },
    runner: { runQueued },
    scheduler: { tick: schedulerTick },
    failRun,
    scheduleEveryMs: 5 * MINUTE,
    logger,
    now: () => clock,
    ...overrides,
  });
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { worker, claimNext, runQueued, schedulerTick, logger, advance, failRun };
}

/** A run that lasts until `finish` is called. */
function hold(runQueued: jest.Mock): { finish: () => void } {
  const control = { finish: (): void => undefined };
  runQueued.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        control.finish = () => resolve(undefined);
      }),
  );
  return control;
}

const tickSoon = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('createRefreshWorker', () => {
  it('claims the next queued refresh and runs that row', async () => {
    const { worker, runQueued } = setup([row(7), row(8)]);

    await expect(worker.tick()).resolves.toBe(7);
    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(runQueued).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
    await expect(worker.tick()).resolves.toBe(8);
    await expect(worker.tick()).resolves.toBeNull();
    expect(runQueued).toHaveBeenCalledTimes(2);
  });

  it('runs one refresh at a time: a tick ends only once its run has ended', async () => {
    const { worker, claimNext, runQueued } = setup([row(1), row(2)]);
    const run = hold(runQueued);

    let ended = false;
    const tick = worker.tick().then(() => {
      ended = true;
    });
    await tickSoon();
    expect(ended).toBe(false);
    expect(claimNext).toHaveBeenCalledTimes(1);

    run.finish();
    await tick;
    expect(ended).toBe(true);
  });

  it('claims nothing once stopping, and abandon fails only the run in progress', async () => {
    const { worker, claimNext, runQueued, failRun } = setup([row(1)]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(worker.tick(stopped.signal)).resolves.toBeNull();
    expect(claimNext).not.toHaveBeenCalled();

    await worker.abandon('stopping');
    expect(failRun).not.toHaveBeenCalled();

    const run = hold(runQueued);
    const tick = worker.tick();
    await tickSoon();
    await worker.abandon('stopping');
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'stopping');
    run.finish();
    await tick;
  });

  it('asks the scheduler first, then at most every scheduleEveryMs', async () => {
    const { worker, schedulerTick, claimNext, advance } = setup([]);

    await worker.tick();
    expect(schedulerTick).toHaveBeenCalledTimes(1);
    expect(schedulerTick.mock.invocationCallOrder[0]).toBeLessThan(
      claimNext.mock.invocationCallOrder[0] ?? 0,
    );

    advance(MINUTE);
    await worker.tick();
    expect(schedulerTick).toHaveBeenCalledTimes(1);

    advance(4 * MINUTE);
    await worker.tick();
    expect(schedulerTick).toHaveBeenCalledTimes(2);
  });

  it('logs a failing scheduler, claim or run and keeps going', async () => {
    const { worker, logger, runQueued, schedulerTick, claimNext } = setup([row(3)]);
    schedulerTick.mockRejectedValueOnce(new Error('db blip'));
    runQueued.mockRejectedValueOnce(new Error('crashed'));

    await expect(worker.tick()).resolves.toBe(3);

    claimNext.mockRejectedValueOnce(new Error('connection reset'));
    await expect(worker.tick()).resolves.toBeNull();
    expect(logger.error.mock.calls.map(([, msg]) => msg)).toEqual([
      'Scheduled refresh tick failed',
      'Queued refresh crashed',
      'Could not claim a queued refresh',
    ]);
  });
});

describe('runWorkerLoop', () => {
  function loop(worker: RefreshWorker, graceMs = 1_000) {
    const shutdown = new AbortController();
    const logger = { info: jest.fn(), error: jest.fn() };
    const done = runWorkerLoop({ worker, pollMs: 1, signal: shutdown.signal, graceMs, logger });
    return { shutdown, logger, done };
  }

  it('keeps ticking after a tick throws, and starts none once stopped', async () => {
    let ticks = 0;
    const worker: RefreshWorker = {
      tick: jest.fn(async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('unexpected');
        return null;
      }),
      abandon: jest.fn(async () => undefined),
    };
    const { shutdown, logger, done } = loop(worker);

    await tickSoon();
    expect(ticks).toBeGreaterThan(1);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Worker tick failed');

    shutdown.abort();
    await done;
    const atStop = ticks;
    await tickSoon();
    expect(ticks).toBe(atStop);
    expect(worker.abandon).not.toHaveBeenCalled();
  });

  it('lets the run in progress finish within the grace period', async () => {
    const { worker, runQueued, failRun } = setup([row(1)]);
    const run = hold(runQueued);
    const { shutdown, done } = loop(worker);
    await tickSoon();

    shutdown.abort();
    run.finish();
    await done;
    expect(failRun).not.toHaveBeenCalled();
  });

  it('fails the run in progress under its claim when the grace period runs out', async () => {
    const { worker, runQueued, failRun } = setup([row(1), row(2)]);
    hold(runQueued);
    const { shutdown, done } = loop(worker, 5);
    await tickSoon();

    shutdown.abort();
    await done;
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(failRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, claimedBy: 'worker' }),
      ABANDONED_ON_SHUTDOWN,
    );
    // Row 2 is never claimed: it stays queued for the next worker.
    expect(runQueued).toHaveBeenCalledTimes(1);
  });
});
