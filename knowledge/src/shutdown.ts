import type { FastifyBaseLogger } from 'fastify';

/**
 * How long shutdown waits for the document being ingested. Railway sends
 * SIGKILL 30s after SIGTERM by default; this leaves room to close the pool.
 * A document cut off here stays `processing` and is re-queued on next boot.
 */
export const SHUTDOWN_TIMEOUT_MS = 20_000;

export interface ShutdownSteps {
  /** Stops the HTTP server, so no upload enqueues behind the queue stop. */
  closeApp: () => Promise<void>;
  /** Drops waiting work and resolves when the running item is done. */
  stopQueue: () => Promise<unknown>;
  closeDb: () => Promise<void>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** Resolves true if `promise` settles in time, false if the timeout wins. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the signal handler: close the app, then stop the queue (bounded by
 * the timeout), then close the database, then exit 0. Any failure is logged
 * and exits 1. A second signal while shutting down is ignored.
 */
export function createShutdown(steps: ShutdownSteps): (signal: string) => Promise<void> {
  const timeoutMs = steps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    steps.log.info({ signal }, 'Shutting down');
    try {
      await steps.closeApp();
      if (!(await settlesWithin(steps.stopQueue(), timeoutMs))) {
        steps.log.warn({ timeoutMs }, 'Ingestion did not finish in time; it resumes on next boot');
      }
      await steps.closeDb();
      steps.exit(0);
    } catch (error) {
      steps.log.error({ err: error }, 'Shutdown failed');
      steps.exit(1);
    }
  };
}
