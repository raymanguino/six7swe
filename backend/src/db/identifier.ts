/**
 * The one way the database scripts put a name into SQL.
 *
 * Table, sequence, type and role names come from the catalog or the
 * environment, but they are still interpolated into statements, so anything
 * that is not a plain lower-case identifier is rejected rather than escaped.
 */

/** Matches an unquoted Postgres identifier. */
export const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** True when a name is a plain lower-case identifier. */
export function isSafeIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

/** Quotes an identifier for use in a statement; throws on anything else. */
export function quoteIdentifier(name: string): string {
  if (!isSafeIdentifier(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}
