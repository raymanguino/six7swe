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
 *   to fall back on sees the error.
 *
 * Concurrent refreshes share one call to the source.
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
  let inFlight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (!inFlight) {
      inFlight = load()
        .then((value) => {
          entry = { value, expiresAt: now() + options.ttlMs };
          invalidated = false;
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /** Keeps serving the last good value for a while before trying the source again. */
  function backOff(): void {
    if (entry) entry = { value: entry.value, expiresAt: now() + options.retryAfterFailureMs };
    invalidated = false;
  }

  return {
    async get() {
      if (entry && !invalidated) {
        if (now() >= entry.expiresAt && !inFlight) {
          refresh().catch((error: unknown) => {
            backOff();
            options.onBackgroundError?.(error);
          });
        }
        return entry.value;
      }
      try {
        return await refresh();
      } catch (error) {
        if (!entry) throw error;
        backOff();
        options.onBackgroundError?.(error);
        return entry.value;
      }
    },
    invalidate() {
      invalidated = true;
    },
    clear() {
      entry = null;
      invalidated = false;
    },
  };
}
