/**
 * Storage key rules, shared by every file store and by the config (the owner
 * id becomes the first key segment). A leaf module, so the store adapters do
 * not import the store factory that imports them.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** One path segment: letters, digits, `.`, `_` and `-`, and never `.` or `..`. */
export function isSafeKeySegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..';
}

/** Rejects keys that could escape a directory or a bucket prefix. */
export function assertSafeKey(key: string): void {
  if (!key.split('/').every(isSafeKeySegment)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
