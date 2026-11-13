import { describe, expect, it, vi } from 'vitest';
import { createShutdown, type ShutdownSteps } from '../shutdown.js';

function steps(overrides: Partial<ShutdownSteps> = {}) {
  const order: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const exit = vi.fn((code: number) => {
    order.push(`exit ${code}`);
  });
  const all: ShutdownSteps = {
    closeApp: async () => {
      order.push('closeApp');
    },
    stopQueue: async () => {
      order.push('stopQueue');
    },
    closeDb: async () => {
      order.push('closeDb');
    },
    log,
    exit,
    timeoutMs: 50,
    ...overrides,
  };
  return { all, order, log, exit };
}

describe('createShutdown', () => {
  it('closes the app, then stops the queue, then closes the database, then exits 0', async () => {
    const { all, order } = steps();
    await createShutdown(all)('SIGTERM');
    expect(order).toEqual(['closeApp', 'stopQueue', 'closeDb', 'exit 0']);
  });

  it('stops waiting for the queue after the timeout and still exits 0', async () => {
    const { all, order, log } = steps({ stopQueue: () => new Promise(() => {}) });
    const started = Date.now();
    await createShutdown(all)('SIGTERM');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(order).toEqual(['closeApp', 'closeDb', 'exit 0']);
    expect(log.warn).toHaveBeenCalledWith({ timeoutMs: 50 }, expect.stringMatching(/in time/));
  });

  it('logs a failing step and exits 1', async () => {
    const failure = new Error('pool already closed');
    const { all, order, log } = steps({ closeDb: () => Promise.reject(failure) });
    await createShutdown(all)('SIGINT');
    expect(order).toEqual(['closeApp', 'stopQueue', 'exit 1']);
    expect(log.error).toHaveBeenCalledWith({ err: failure }, 'Shutdown failed');
  });

  it('ignores a second signal while shutting down', async () => {
    const { all, exit } = steps();
    const shutdown = createShutdown(all);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
