/**
 * A positive integer from an env value, capped at `max`; `fallback` when it is unset,
 * not an integer or below 1.
 */
export function positiveInt(
  raw: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}
