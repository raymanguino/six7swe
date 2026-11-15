import Fastify, { FastifyInstance } from 'fastify';
import { getPortfolioHandler } from '../../routes/handlers/portfolioHandlers';
import { resumeHandler } from '../../routes/handlers/resumeHandlers';
import {
  getDefaultProfileClient,
  type KnowledgeProfileClient,
} from '../../services/knowledge/profileClient';
import { getPortfolioData } from '../../services/portfolioService';
import { findLocalResume, isResumeAvailable } from '../../services/resumeService';
import type { PortfolioData } from '../../types/portfolio';

jest.mock('../../services/portfolioService', () => ({ getPortfolioData: jest.fn() }));
jest.mock('../../services/knowledge/profileClient', () => ({ getDefaultProfileClient: jest.fn() }));
jest.mock('../../services/resumeService', () => ({
  ...jest.requireActual('../../services/resumeService'),
  findLocalResume: jest.fn(),
  isResumeAvailable: jest.fn(),
}));

const mockedGetPortfolioData = jest.mocked(getPortfolioData);
const mockedGetClient = jest.mocked(getDefaultProfileClient);
const mockedFindLocalResume = jest.mocked(findLocalResume);
const mockedIsResumeAvailable = jest.mocked(isResumeAvailable);

const PDF = Buffer.from('%PDF-1.4 resume');

const portfolio: PortfolioData = {
  profile: {
    id: 1,
    name: 'Jordan Example',
    title: 'Engineer',
    email: 'jordan@example.com',
    phone: null,
    location: null,
    linkedinUrl: null,
    githubUrl: null,
    summary: null,
    skills: [],
    experience: [],
    projects: [],
    fullResumeText: '',
    resumeFilename: 'jordan.pdf',
  },
  knowledgeResume: { filename: 'jordan.pdf', isPdf: true },
};

function clientReturning(getResumePdf: KnowledgeProfileClient['getResumePdf']) {
  const client: KnowledgeProfileClient = { getPublished: jest.fn(), getResumePdf };
  mockedGetClient.mockReturnValue(client);
}

/**
 * `/resume` serves the knowledge
 * service's primary resume (#86), which fixes #104: production no longer
 * needs a PDF on the backend's disk.
 */
describe('resume from the knowledge service', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockedGetPortfolioData.mockResolvedValue(portfolio);
    app = Fastify({ logger: false });
    app.get('/portfolio', getPortfolioHandler);
    app.get('/resume', resumeHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    jest.resetAllMocks();
  });

  it('serves the primary resume PDF under its uploaded name', async () => {
    clientReturning(() => Promise.resolve(PDF));

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="jordan.pdf"; filename*=UTF-8''jordan.pdf`,
    );
    expect(res.rawPayload).toEqual(PDF);
    expect(mockedFindLocalResume).not.toHaveBeenCalled();
  });

  it('serves a resume whose name is not Latin-1', async () => {
    clientReturning(() => Promise.resolve(PDF));
    mockedGetPortfolioData.mockResolvedValue({
      ...portfolio,
      knowledgeResume: { filename: '履歴書 (2026).pdf', isPdf: true },
    });

    const res = await app.inject({ method: 'GET', url: '/resume' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="___ (2026).pdf"; filename*=UTF-8''${encodeURIComponent('履歴書')}%20%282026%29.pdf`,
    );
  });

  it('falls back to a local file, then 404, when the service has none or is down', async () => {
    clientReturning(() => Promise.reject(new Error('unreachable')));
    mockedFindLocalResume.mockReturnValue(null);
    expect((await app.inject({ method: 'GET', url: '/resume' })).statusCode).toBe(404);

    clientReturning(() => Promise.resolve(null));
    expect((await app.inject({ method: 'GET', url: '/resume' })).statusCode).toBe(404);
    expect(mockedFindLocalResume).toHaveBeenCalledTimes(2);
  });

  it('advertises the download when the service has a PDF resume', async () => {
    mockedIsResumeAvailable.mockReturnValue(false);
    const res = await app.inject({ method: 'GET', url: '/portfolio' });
    expect(res.json()).toMatchObject({ resumeAvailable: true, resumeFilename: 'jordan.pdf' });

    mockedGetPortfolioData.mockResolvedValue({
      ...portfolio,
      knowledgeResume: { filename: 'resume.md', isPdf: false },
    });
    const none = await app.inject({ method: 'GET', url: '/portfolio' });
    expect(none.json()).toMatchObject({ resumeAvailable: false });
  });
});
