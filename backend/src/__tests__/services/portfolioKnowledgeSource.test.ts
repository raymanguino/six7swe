import type { PublishedProfileResponse } from '@six7swe/knowledge-types';
import type { KnowledgeProfileClient } from '../../services/knowledge/profileClient';
import type { PortfolioData } from '../../types/portfolio';

/**
 * `getPortfolioData()` (#86, #88): the profile published in the knowledge
 * service, the only source (no database), and the last good profile while the
 * service is down.
 */

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

function load(getPublished: KnowledgeProfileClient['getPublished'] | null) {
  jest.doMock('../../services/knowledge/profileClient', () => ({
    getDefaultProfileClient: () =>
      getPublished ? { getPublished, getResumePdf: jest.fn() } : null,
  }));
  let service: typeof import('../../services/portfolioService') | undefined;
  jest.isolateModules(() => {
    service = jest.requireActual<typeof import('../../services/portfolioService')>(
      '../../services/portfolioService',
    );
  });
  if (!service) throw new Error('portfolioService did not load');
  const warn = jest.fn();
  service.setPortfolioLogger({ warn });
  return Object.assign(service, { warn });
}

const names = (data: PortfolioData) => data.profile?.name;

describe('portfolio data from the knowledge service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('serves the published profile', async () => {
    const service = load(() => Promise.resolve(published('Jordan Example')));
    const data = await service.getPortfolioData();
    expect(names(data)).toBe('Jordan Example');
    expect(data.profile?.email).toBe('jordan@example.com');
  });

  it('has no profile until one is published', async () => {
    const service = load(() => Promise.resolve({ profile: null, resume: null }));
    const data = await service.getPortfolioData();
    expect(data.profile).toBeNull();
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
    expect(service.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Portfolio refresh failed; serving the last good profile',
    );
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

  it('fails on a cold start with the service down, without asking it again at once', async () => {
    const getPublished = jest.fn(() => Promise.reject(new Error('down')));
    const service = load(getPublished);
    await expect(service.getPortfolioData()).rejects.toThrow('down');
    // An outage costs one timeout, not one per request.
    await expect(service.getPortfolioData()).rejects.toThrow('down');
    expect(getPublished).toHaveBeenCalledTimes(1);
  });

  it('fails when the knowledge service is not configured', async () => {
    const service = load(null);
    await expect(service.getPortfolioData()).rejects.toThrow(/KNOWLEDGE_URL/);
  });
});
