/**
 * A value computed from the knowledge corpus, cached under the corpus version
 * (`/version`) it was computed against.
 *
 * The version is the only invalidation: any upload, delete or primary-resume
 * change in the knowledge service moves it, so every process (every backend
 * replica, the CLI refresh runner) sees the change the next time it asks with
 * the new version. There is no in-process bust to forget and nothing to
 * broadcast between replicas. How stale a value can get is bounded by how
 * often the caller reads the version, which the caller states.
 *
 * Concurrent requests for the same version share one load. A load reports the
 * version it actually ran against (a `/retrieve` response carries it), and the
 * value is filed under that one, so a corpus change during the load never
 * labels the old value with the new version.
 */
export interface VersionKeyedCache<T> {
  /** The value for `version`: cached when the last load ran against it, loaded otherwise. */
  get(version: number): Promise<T>;
}

export function createVersionKeyedCache<T>(
  load: () => Promise<{ version: number; value: T }>,
): VersionKeyedCache<T> {
  let cached: { version: number; value: T } | null = null;
  const inflight = new Map<number, Promise<T>>();

  return {
    get(version) {
      if (cached && cached.version === version) return Promise.resolve(cached.value);
      let pending = inflight.get(version);
      if (!pending) {
        pending = load()
          .then((loaded) => {
            // A slow load must not replace a value computed at a newer version.
            if (!cached || loaded.version >= cached.version || loaded.version === version) {
              cached = loaded;
            }
            return loaded.value;
          })
          .finally(() => {
            inflight.delete(version);
          });
        inflight.set(version, pending);
      }
      return pending;
    },
  };
}
