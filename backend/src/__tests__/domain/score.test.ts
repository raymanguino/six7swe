import { scoreBand, MATCH_BAND_THRESHOLDS } from '../../domain/jobHunt/score';

describe('scoreBand', () => {
  it('maps a score at the top of a band to that band', () => {
    expect(scoreBand(100)).toBe('TOP');
    expect(scoreBand(MATCH_BAND_THRESHOLDS.TOP)).toBe('TOP');
    expect(scoreBand(MATCH_BAND_THRESHOLDS.HIGH)).toBe('HIGH');
    expect(scoreBand(MATCH_BAND_THRESHOLDS.MEDIUM)).toBe('MEDIUM');
    expect(scoreBand(0)).toBe('LOW');
  });

  it('maps a score just below a band threshold to the lower band', () => {
    expect(scoreBand(MATCH_BAND_THRESHOLDS.TOP - 1)).toBe('HIGH');
    expect(scoreBand(MATCH_BAND_THRESHOLDS.HIGH - 1)).toBe('MEDIUM');
    expect(scoreBand(MATCH_BAND_THRESHOLDS.MEDIUM - 1)).toBe('LOW');
  });

  it('classifies representative scores', () => {
    expect(scoreBand(90)).toBe('TOP');
    expect(scoreBand(70)).toBe('HIGH');
    expect(scoreBand(50)).toBe('MEDIUM');
    expect(scoreBand(10)).toBe('LOW');
  });
});
