import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { RefreshStatusService } from '../../db/api/refreshStatus';
import type { RefreshStatus } from '../../db/schema/jobHunt';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';

/**
 * The refresh queue (#253) on `refresh_status`: enqueue, atomic claim and the
 * heartbeat a running refresh keeps up so stale-claim recovery
 * (`failStaleRefreshes`) never reaps it.
 */

/**
 * How often a running refresh heartbeats. Far below the stale threshold
 * (`JOB_REFRESH_STALE_MINUTES`, 30 by default), so a few missed beats (a
 * database blip) do not get a live run reaped.
 */
export const REFRESH_HEARTBEAT_MS = 60_000;

/** Thrown when a profile already has a refresh queued or running. */
export class RefreshInProgressError extends Error {
  constructor(profileId: number) {
    super(`A refresh is already running for profile ${profileId}`);
    this.name = 'RefreshInProgressError';
  }
}

/** Thrown when a run's row is no longer its claim (it was reaped): the run stops writing. */
export class ClaimLostError extends Error {
  constructor(refreshId: number) {
    super(`Refresh ${refreshId} is no longer claimed by this process`);
    this.name = 'ClaimLostError';
  }
}

let claimant: string | undefined;

/**
 * This process's claimant id, recorded in `refresh_status.claimed_by`: the
 * host, the pid and a random suffix, so a restarted process (same host, maybe
 * the same pid in a container) never passes for its predecessor.
 */
export function processClaimant(): string {
  claimant ??= `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`.slice(0, 128);
  return claimant;
}

type ActiveRefreshReader = Pick<RefreshStatusService, 'getActiveRefreshForProfile'>;

/**
 * Records a new active refresh for a profile through `insert`, keeping the
 * one-active-refresh-per-profile rule. Throws {@link RefreshInProgressError}
 * when the profile already has one.
 *
 * The read is only a fast path. The insert is the real gate: a partial unique
 * index makes the database reject a second active refresh for the same
 * profile, so two concurrent requests cannot both record one.
 */
export async function recordActiveRefresh(
  service: ActiveRefreshReader,
  profileId: number,
  insert: () => Promise<RefreshStatus>,
): Promise<RefreshStatus> {
  const active = await service.getActiveRefreshForProfile(profileId);
  if (active) {
    throw new RefreshInProgressError(profileId);
  }
  try {
    return await insert();
  } catch (error) {
    if (error instanceof ActiveRefreshExistsError) {
      // Another request inserted between the check above and this insert.
      throw new RefreshInProgressError(profileId);
    }
    throw error;
  }
}

export interface RefreshQueue {
  /** Queues a refresh for a worker to claim; throws {@link RefreshInProgressError}. */
  enqueue(profileId: number): Promise<RefreshStatus>;
  /** Claims the oldest queued refresh for this process, or null when none is queued. */
  claimNext(): Promise<RefreshStatus | null>;
}

export function createRefreshQueue(
  service: Pick<
    RefreshStatusService,
    'getActiveRefreshForProfile' | 'enqueueRefresh' | 'claimNextRefresh'
  >,
  claimedBy: string = processClaimant(),
): RefreshQueue {
  return {
    enqueue: (profileId) =>
      recordActiveRefresh(service, profileId, () => service.enqueueRefresh(profileId)),
    claimNext: () => service.claimNextRefresh(claimedBy),
  };
}

interface HeartbeatLogger {
  warn(obj: object, msg: string): void;
}

export interface HeartbeatOptions {
  logger: HeartbeatLogger;
  /**
   * Called once when a beat finds the row is no longer this claimant's
   * active claim (it was reaped). The run must stop: its work would overlap
   * the replacement refresh.
   */
  onLost: () => void;
  intervalMs?: number;
}

/**
 * Heartbeats refresh `id` every `intervalMs` until the returned stop function
 * is called, or until the row is no longer this claimant's active claim, when
 * it stops and calls `onLost`. A failed beat is only logged and the next one
 * tries again. The timer is unref'd, so it never keeps a process alive on its
 * own.
 */
export function startHeartbeat(
  service: Pick<RefreshStatusService, 'heartbeatRefresh'>,
  id: number,
  claimedBy: string,
  options: HeartbeatOptions,
): () => void {
  const { logger, onLost, intervalMs = REFRESH_HEARTBEAT_MS } = options;
  let stopped = false;
  let inFlight = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  const beat = async (): Promise<void> => {
    // A slow beat is not overlapped by the next one.
    if (inFlight) return;
    inFlight = true;
    let lost = false;
    try {
      lost = !(await service.heartbeatRefresh(id, claimedBy)) && !stopped;
    } catch (error) {
      if (!stopped) logger.warn({ err: error, refreshId: id }, 'Refresh heartbeat failed');
    } finally {
      inFlight = false;
    }
    if (lost) {
      stop();
      onLost();
    }
  };
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();
  return stop;
}
