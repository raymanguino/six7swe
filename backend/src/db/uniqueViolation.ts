/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** Bound on the `.cause` walk, so a cyclic chain cannot loop forever. */
const MAX_CAUSE_DEPTH = 10;

/**
 * True when the error, or anything in its `.cause` chain, is a Postgres
 * unique constraint violation.
 *
 * drizzle-orm wraps driver errors in `DrizzleQueryError`, so the Postgres
 * code lives on `error.cause` rather than on the error itself.
 */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current) &&
    seen.size < MAX_CAUSE_DEPTH
  ) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
