import {
  createRefreshQueue,
  processClaimant,
  RefreshInProgressError,
  startHeartbeat,
} from '../../services/jobHunt/refreshQueue';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';

/**
 * The queue's service side (#253): enqueue keeps one active refresh per
 * profile, claims carry this process's claimant, and the heartbeat runs
 * until stopped or until the row is no longer the claimant's. The SQL itself
 * is covered by `db/refreshQueue.integration.test.ts`.
 */

function makeService(overrides: Record<string, jest.Mock> = {}) {
  return {
    getActiveRefreshForProfile: jest.fn().mockResolvedValue(null),
    enqueueRefresh: jest.fn().mockResolvedValue({ id: 9, status: 'PENDING' }),
    claimNextRefresh: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('refresh queue', () => {
  it('enqueues when the profile has no active refresh', async () => {
    const service = makeService();
    await expect(createRefreshQueue(service, 'me').enqueue(3)).resolves.toMatchObject({ id: 9 });
    expect(service.enqueueRefresh).toHaveBeenCalledWith(3);
  });

  it('refuses a second active refresh, on the fast path and on a lost insert race', async () => {
    const active = makeService({
      getActiveRefreshForProfile: jest.fn().mockResolvedValue({ id: 1, status: 'IN_PROGRESS' }),
    });
    await expect(createRefreshQueue(active, 'me').enqueue(3)).rejects.toBeInstanceOf(
      RefreshInProgressError,
    );
    expect(active.enqueueRefresh).not.toHaveBeenCalled();

    const raced = makeService({
      enqueueRefresh: jest.fn().mockRejectedValue(new ActiveRefreshExistsError(3)),
    });
    await expect(createRefreshQueue(raced, 'me').enqueue(3)).rejects.toBeInstanceOf(
      RefreshInProgressError,
    );
  });

  it('does not swallow unrelated insert failures', async () => {
    const service = makeService({
      enqueueRefresh: jest.fn().mockRejectedValue(new Error('connection lost')),
    });
    await expect(createRefreshQueue(service, 'me').enqueue(3)).rejects.toThrow('connection lost');
  });

  it('claims as this process', async () => {
    const service = makeService();
    await createRefreshQueue(service, 'worker-a').claimNext();
    expect(service.claimNextRefresh).toHaveBeenCalledWith('worker-a');

    await createRefreshQueue(service).claimNext();
    expect(service.claimNextRefresh).toHaveBeenLastCalledWith(processClaimant());
  });

  it('has one claimant id per process', () => {
    expect(processClaimant()).toBe(processClaimant());
    expect(processClaimant()).toContain(`:${process.pid}:`);
  });
});

describe('refresh heartbeat', () => {
  const logger = { warn: jest.fn() };
  const onLost = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    logger.warn.mockReset();
    onLost.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('beats every interval until stopped', async () => {
    const service = { heartbeatRefresh: jest.fn().mockResolvedValue(true) };
    const stop = startHeartbeat(service, 5, 'me', { logger, onLost, intervalMs: 1_000 });

    await jest.advanceTimersByTimeAsync(3_000);
    expect(service.heartbeatRefresh).toHaveBeenCalledTimes(3);
    expect(service.heartbeatRefresh).toHaveBeenCalledWith(5, 'me');

    stop();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(service.heartbeatRefresh).toHaveBeenCalledTimes(3);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('stops and reports the loss once the row is no longer its claim', async () => {
    const service = { heartbeatRefresh: jest.fn().mockResolvedValue(false) };
    startHeartbeat(service, 5, 'me', { logger, onLost, intervalMs: 1_000 });

    await jest.advanceTimersByTimeAsync(5_000);
    expect(service.heartbeatRefresh).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('does not report a loss found after it was stopped', async () => {
    let answer: (held: boolean) => void = () => undefined;
    const service = {
      heartbeatRefresh: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      ),
    };
    const stop = startHeartbeat(service, 5, 'me', { logger, onLost, intervalMs: 1_000 });

    await jest.advanceTimersByTimeAsync(1_000);
    stop();
    answer(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('skips a tick while a beat is still in flight', async () => {
    const service = { heartbeatRefresh: jest.fn(() => new Promise<boolean>(() => undefined)) };
    const stop = startHeartbeat(service, 5, 'me', { logger, onLost, intervalMs: 1_000 });

    await jest.advanceTimersByTimeAsync(3_000);
    expect(service.heartbeatRefresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it('logs a failed beat and keeps beating', async () => {
    const service = {
      heartbeatRefresh: jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(true),
    };
    const stop = startHeartbeat(service, 5, 'me', { logger, onLost, intervalMs: 1_000 });

    await jest.advanceTimersByTimeAsync(2_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(service.heartbeatRefresh).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    stop();
  });
});
