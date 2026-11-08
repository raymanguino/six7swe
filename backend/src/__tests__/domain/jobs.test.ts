import { buildJobSearchQuery, isValidGeoId } from '../../domain/jobHunt/jobs';

describe('isValidGeoId', () => {
  it('accepts a numeric region id', () => {
    expect(isValidGeoId('105149290')).toBe(true);
  });

  it('rejects a human readable location', () => {
    expect(isValidGeoId('Toronto, Ontario')).toBe(false);
  });

  it('rejects empty and missing values', () => {
    expect(isValidGeoId('')).toBe(false);
    expect(isValidGeoId(null)).toBe(false);
    expect(isValidGeoId(undefined)).toBe(false);
  });
});

describe('buildJobSearchQuery', () => {
  it('builds a query from keywords and a geoId', () => {
    const query = buildJobSearchQuery({
      keywords: ['Software Engineer', '  '],
      geoId: '105149290',
    });

    expect(query.keywords).toEqual(['Software Engineer']);
    expect(query.geoId).toBe('105149290');
    expect(query.postedWithin).toBe('24h');
  });

  it('throws rather than silently searching with a bad geoId', () => {
    expect(() =>
      buildJobSearchQuery({ keywords: ['Engineer'], geoId: 'Toronto' }),
    ).toThrow(/geoId/i);
  });

  it('throws when the geoId is missing', () => {
    expect(() => buildJobSearchQuery({ keywords: [], geoId: null })).toThrow(/geoId/i);
  });
});
