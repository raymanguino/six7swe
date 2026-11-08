import { createHash } from 'node:crypto';

/**
 * Content fingerprint used for change detection.
 *
 * SHA-256 rather than a 32-bit rolling hash: these values are stored in
 * `varchar(64)` columns and are compared across refreshes to decide whether a
 * posting changed, so collisions have to be practically impossible.
 */
export function hashData(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}