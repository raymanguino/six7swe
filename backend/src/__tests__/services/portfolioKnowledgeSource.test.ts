import type { PublishedProfileResponse } from '@six7swe/knowledge-types';
import type { KnowledgeProfileClient } from '../../services/knowledge/profileClient';
import type { PortfolioData } from '../../types/portfolio';

/**
 * `getPortfolioData()` with `PORTFOLIO_DATA_SOURCE=knowledge` (#86): the
 * published profile from the knowledge service, the seeded Postgres profile
 * until one is published, and the last good profile while the service is down.
 */

const seededRow = {
  id: 1,
  name: 'Seeded Name',
  title: 'Seeded Title',
  email: 'seeded@example.com',
  phone: null,
  location: null,
  linkedinUrl: null,
  githubUrl: null,
  summary: null,
  skills: [],
  experience: [],
  projects: [],
  fullResumeText: 'seeded resume',
  resumeFilename: 'seeded.pdf',
};

/** A stand-in for Drizzle's query builder: every chain resolves to the given rows. */
function chain(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy']) builder[method] = () => builder;
  builder.limit = () => Promise.resolve(rows);
  builder.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
  return builder;
}

const AT = '2026-11-14T10:00:00.000Z';
const published = (name: string): PublishedProfileResponse => ({
  profile: {
    stage: 'published',
    sourceDocumentId: null,
    createdAt: AT,
    updatedAt: AT,
    data: {
      name,
      title: 'Engineer',
      location: null,
      summary: '',
      skills: [],
      experience: [],
      projects: [],
      links: {
        email: 'jordan@example.com',
        phone: null,
        linkedin: null,
        github: null,
        website: null,
      },
    },
  },
  resume: null,
});

function load(getPublished: KnowledgeProfileClient['getPublished']) {
  let selects = 0;
  jest.doMock('../../db', () => ({
    db: {
      select: () => {
        selects += 1;
        // The profile query first, then the content sections.
        return chain(selects % 2 === 1 ? [seededRow] : []);
      },
    },
  }));
  jest.doMock('../../services/knowledge/profileClient', () => ({
    getDefaultProfileClient: () => ({ getPublished, getResumePdf: jest.fn() }),
  }));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  let service: typeof import('../../services/portfolioService') | undefined;
  jest.isolateModules(() => {
    service = jest.requireActual<typeof import('../../services/portfolioService')>(
      '../../services/portfolioService',
    );
  });
  if (!service) throw new Error('portfolioService did not load');
  return service;
}

const names = (data: PortfolioData) => data.profile?.name;

describe('portfolio data from the knowledge service', () => {
  beforeEach(() => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
  });

  afterEach(() => {
    delete process.env.PORTFOLIO_DATA_SOURCE;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('serves the published profile', async () => {
    const service = load(() => Promise.resolve(published('Jordan Example')));
    const data = await service.getPortfolioData();
    expect(names(data)).toBe('Jordan Example');
    expect(data.profile?.email).toBe('jordan@example.com');
  });

  it('serves the seeded profile until one is published', async () => {
    const service = load(() => Promise.resolve({ profile: null, resume: null }));
    const data = await service.getPortfolioData();
    expect(names(data)).toBe('Seeded Name');
    expect(data.knowledgeResume).toBeNull();
  });

  it('keeps serving the last good profile while the service is down', async () => {
    let up = true;
    const service = load(() =>
      up ? Promise.resolve(published('Jordan Example')) : Promise.reject(new Error('down')),
    );
    expect(names(await service.getPortfolioData())).toBe('Jordan Example');

    up = false;
    // A publish busts the cache; the refresh fails, so the last good profile stays.
    service.clearPortfolioCache();
    expect(names(await service.getPortfolioData())).toBe('Jordan Example');
  });

  it('shows a newly published profile on the next request after the cache is busted', async () => {
    let name = 'Before';
    const service = load(() => Promise.resolve(published(name)));
    expect(names(await service.getPortfolioData())).toBe('Before');
    name = 'After';
    expect(names(await service.getPortfolioData())).toBe('Before');
    service.clearPortfolioCache();
    expect(names(await service.getPortfolioData())).toBe('After');
  });

  it('falls back to the seeded profile on a cold start with the service down', async () => {
    const service = load(() => Promise.reject(new Error('down')));
    expect(names(await service.getPortfolioData())).toBe('Seeded Name');
  });
});
