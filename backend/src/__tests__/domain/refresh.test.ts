import {
  INITIAL_REFRESH_STATE,
  isTerminalRefreshState,
  nextRefreshState,
  type RefreshState,
} from '../../domain/jobHunt/refresh';

describe('nextRefreshState', () => {
  it('moves to IN_PROGRESS/FETCHING_JOBS when the refresh starts', () => {
    expect(nextRefreshState(INITIAL_REFRESH_STATE, { type: 'STARTED' })).toEqual({
      status: 'IN_PROGRESS',
      step: 'FETCHING_JOBS',
    });
  });

  it('moves to the FILTERING_JOBS step once jobs have been fetched', () => {
    const started = nextRefreshState(INITIAL_REFRESH_STATE, { type: 'STARTED' });

    expect(nextRefreshState(started, { type: 'JOBS_FETCHED' })).toEqual({
      status: 'IN_PROGRESS',
      step: 'FILTERING_JOBS',
    });
  });

  it('completes from any non-terminal state', () => {
    const started = nextRefreshState(INITIAL_REFRESH_STATE, { type: 'STARTED' });

    expect(nextRefreshState(started, { type: 'COMPLETED' })).toEqual({
      status: 'COMPLETED',
      step: 'PENDING',
    });
  });

  it('fails from any non-terminal state', () => {
    const started = nextRefreshState(INITIAL_REFRESH_STATE, { type: 'STARTED' });

    expect(nextRefreshState(started, { type: 'FAILED' })).toEqual({
      status: 'FAILED',
      step: 'PENDING',
    });
  });

  it('keeps a failed refresh failed', () => {
    const failed: RefreshState = { status: 'FAILED', step: 'PENDING' };

    expect(nextRefreshState(failed, { type: 'COMPLETED' })).toEqual(failed);
    expect(nextRefreshState(failed, { type: 'STARTED' })).toEqual(failed);
  });

  it('keeps a completed refresh completed', () => {
    const completed: RefreshState = { status: 'COMPLETED', step: 'PENDING' };

    expect(nextRefreshState(completed, { type: 'FAILED' })).toEqual(completed);
  });

  it('recognises terminal states', () => {
    expect(isTerminalRefreshState({ status: 'COMPLETED', step: 'PENDING' })).toBe(true);
    expect(isTerminalRefreshState({ status: 'FAILED', step: 'PENDING' })).toBe(true);
    expect(isTerminalRefreshState({ status: 'IN_PROGRESS', step: 'FETCHING_JOBS' })).toBe(false);
  });
});
