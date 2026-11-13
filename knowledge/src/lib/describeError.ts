/**
 * An error's message plus its cause, which is where postgres.js and Drizzle
 * put the underlying database error. For CLI output, not for API responses.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.cause instanceof Error) return `${error.message}\n  cause: ${error.cause.message}`;
  return error.message;
}
