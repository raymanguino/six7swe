/**
 * Job search query construction.
 *
 * Pure domain logic. LinkedIn's `geoId` is a numeric region identifier, not a
 * human-readable location; passing a city name produces a broken search URL
 * that silently returns nothing. Validating it up front turns a silent
 * empty result into an explicit error.
 */

export const LINKEDIN_GEO_ID_PATTERN = /^\d+$/;

export type PostedWithin = '24h' | 'week' | 'month' | 'any';

export const POSTED_WITHIN_VALUES: readonly PostedWithin[] = ['24h', 'week', 'month', 'any'];

export interface JobSearchQuery {
  keywords: string[];
  geoId: string;
  postedWithin: PostedWithin;
  experience: string[];
  workTypes: string[];
}

/** True when the value is a usable LinkedIn geoId. */
export function isValidGeoId(value: string | null | undefined): boolean {
  return typeof value === 'string' && LINKEDIN_GEO_ID_PATTERN.test(value.trim());
}

/**
 * Builds a search query from a search profile.
 *
 * Throws when the geoId is missing or malformed: an invalid geoId would
 * otherwise produce a search that returns zero results with no explanation.
 */
export function buildJobSearchQuery(input: {
  keywords: readonly string[] | null | undefined;
  geoId: string | null | undefined;
  postedWithin?: PostedWithin;
  experience?: readonly string[];
  workTypes?: readonly string[];
}): JobSearchQuery {
  if (!isValidGeoId(input.geoId)) {
    throw new Error(
      `Invalid LinkedIn geoId: ${JSON.stringify(input.geoId ?? null)}. Expected a numeric region id.`,
    );
  }

  return {
    keywords: (input.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0),
    geoId: input.geoId!.trim(),
    postedWithin: input.postedWithin ?? '24h',
    experience: [...(input.experience ?? [])],
    workTypes: [...(input.workTypes ?? [])],
  };
}
