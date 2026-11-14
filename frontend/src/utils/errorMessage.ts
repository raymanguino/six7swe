/** A caught value's message, or `fallback` when it has none. */
export const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback;
