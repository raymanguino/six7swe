/**
 * A single cached value with stale-while-revalidate and stale-if-error.
 *
 * - Fresh (within `ttlMs`): served from memory.
 * - Stale: served from memory at once, and refreshed in the background, so no
 *   caller waits on the source once a value has been loaded.
 * - Invalidated (`invalidate()`, e.g. after a publish): the next caller waits
 *   for a refresh, so the change shows on the next request.
 * - Refresh failed: the last good value keeps being served, and the source is
 *   tried again after `retryAfterFailureMs`. Only a caller with no value at all
 *   to fall back on sees the error, and within that window it sees it at once,
 *   without the source being asked again (an outage costs one timeout, not one
 *   per request).
 *
 * Concurrent refreshes of the same generation share one call to the source; a
 * refresh started before `invalidate()` is never joined after it.
 */
export interface SwrCacheOptions {
  ttlMs: number;
  retryAfterFailureMs: number;
  now?: () => number;
  /** Receives a failed background refresh, which no caller sees. */
  onBackgroundError?: (error: unknown) => void;
}

export interface SwrCache<T> {
  get(): Promise<T>;
  /** Makes the next `get` wait for fresh data, keeping the old value as a fallback. */
  invalidate(): void;
  /** Forgets everything, the fallback included. For tests. */
  clear(): void;
}

export function createSwrCache<T>(load: () => Promise<T>, options: SwrCacheOptions): SwrCache<T> {
  const now = options.now ?? Date.now;
  let entry: { value: T; expiresAt: number } | null = null;
  let invalidated = false;
  /**
   * Bumped by `invalidate()` and `clear()`. A load started before an invalidation may carry
   * data from before it (a publish), so it is never joined by a later caller,
   * and its result neither replaces the value nor ends the invalidation.
   */
  let generation = 0;
  let inFlight: { promise: Promise<T>; generation: number } | null = null;
  /** With no value to fall back on, a failure is remembered until then, so callers fail fast. */
  let failure: { error: unknown; until: number } | null = null;

  function refresh(): Promise<T> {
    if (inFlight && inFlight.generation === generation) return inFlight.promise;
    const started = generation;
    // Called inside a promise, so a load that throws synchronously takes the
    // same failure path as one that rejects.
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (started === generation) {
          entry = { value, expiresAt: now() + options.ttlMs };
          invalidated = false;
          failure = null;
        }
        return value;
      })
      .catch((error: unknown) => {
        if (started === generation) backOff(error);
        throw error;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { promise, generation: started };
    return promise;
  }

  /**
   * After a current load failed: keep serving the last good value for a while
   * before trying the source again, or, with none, fail fast for that long.
   */
  function backOff(error: unknown): void {
    const until = now() + options.retryAfterFailureMs;
    if (entry) {
      entry = { value: entry.value, expiresAt: until };
      invalidated = false;
    } else {
      failure = { error, until };
    }
  }

  return {
    async get() {
      if (entry && !invalidated) {
        if (now() >= entry.expiresAt && !inFlight) {
          refresh().catch((error: unknown) => options.onBackgroundError?.(error));
        }
        return entry.value;
      }
      if (!entry && failure && now() < failure.until) throw failure.error;
      try {
        return await refresh();
      } catch (error) {
        if (!entry) throw error;
        options.onBackgroundError?.(error);
        return entry.value;
      }
    },
    invalidate() {
      generation += 1;
      invalidated = true;
      // A remembered failure predates the change; try the source again now.
      failure = null;
    },
    clear() {
      // A load already running must not fill the cache back in afterwards.
      generation += 1;
      entry = null;
      invalidated = false;
      failure = null;
    },
  };
}
