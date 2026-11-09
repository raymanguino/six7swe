/**
 * Refresh lifecycle state machine.
 *
 * Pure domain logic. Every status transition in the refresh pipeline goes
 * through here so the legal transitions are stated once and testable in
 * isolation, rather than being scattered across status-update calls.
 */

export type RefreshStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export type RefreshStep = 'PENDING' | 'FETCHING_JOBS' | 'FILTERING_JOBS';

export interface RefreshState {
  status: RefreshStatus;
  step: RefreshStep;
}

export type RefreshEvent =
  | { type: 'STARTED' }
  | { type: 'JOBS_FETCHED' }
  | { type: 'FILTERING_STARTED' }
  | { type: 'COMPLETED' }
  | { type: 'FAILED' };

export const INITIAL_REFRESH_STATE: RefreshState = { status: 'PENDING', step: 'PENDING' };

/** COMPLETED and FAILED are terminal: later events cannot revive a finished refresh. */
export function isTerminalRefreshState(state: RefreshState): boolean {
  return state.status === 'COMPLETED' || state.status === 'FAILED';
}

/**
 * Returns the next state for `event`, or the current state when the event is
 * not legal (for example any event after the refresh already failed).
 */
export function nextRefreshState(current: RefreshState, event: RefreshEvent): RefreshState {
  if (isTerminalRefreshState(current)) {
    return current;
  }

  switch (event.type) {
    case 'STARTED':
      return { status: 'IN_PROGRESS', step: 'FETCHING_JOBS' };
    case 'JOBS_FETCHED':
    case 'FILTERING_STARTED':
      return { status: 'IN_PROGRESS', step: 'FILTERING_JOBS' };
    case 'COMPLETED':
      return { status: 'COMPLETED', step: 'PENDING' };
    case 'FAILED':
      return { status: 'FAILED', step: 'PENDING' };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Thrown when a refresh could not start because the profile already has one
 * in flight.
 *
 * At most one refresh may be active per profile: two would score the same
 * jobs twice and race on the status row. The database enforces this with a
 * partial unique index, and this error carries that enforcement up into the
 * service and route layers.
 */
export class ActiveRefreshExistsError extends Error {
  readonly profileId: number;

  constructor(profileId: number) {
    super(`A refresh is already active for profile ${profileId}`);
    this.name = 'ActiveRefreshExistsError';
    this.profileId = profileId;
  }
}
