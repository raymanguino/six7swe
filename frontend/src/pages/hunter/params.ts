/** Helpers for reading route parameters in the job-hunter UI. */

/**
 * Parses a numeric route parameter.
 *
 * A hand-edited URL can carry anything (`abc`, `1.5`, `12abc`), and
 * `Number()` turns those into `NaN` rather than throwing. Returning null
 * lets the caller show a clear message instead of rendering "Profile #NaN"
 * and firing requests at `/profiles/NaN`.
 */
export function parseNumericParam(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
