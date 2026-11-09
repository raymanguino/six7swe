/**
 * Match scoring bands.
 *
 * Pure domain logic: no IO, no framework imports. The canonical matcher
 * returns a 0-100 score; the band is always derived from that score rather
 * than asked of the model, so the classification can never disagree with the
 * number it was derived from.
 */

export type MatchBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'TOP';

/** Lower bound (inclusive) of each band. */
export const MATCH_BAND_THRESHOLDS = {
  MEDIUM: 40,
  HIGH: 65,
  TOP: 85,
} as const;

export const MATCH_BANDS: readonly MatchBand[] = ['LOW', 'MEDIUM', 'HIGH', 'TOP'];

/** Derives the band for a 0-100 match score. */
export function scoreBand(score: number): MatchBand {
  if (score >= MATCH_BAND_THRESHOLDS.TOP) return 'TOP';
  if (score >= MATCH_BAND_THRESHOLDS.HIGH) return 'HIGH';
  if (score >= MATCH_BAND_THRESHOLDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}
