import Fastify, { FastifyInstance } from 'fastify';
import { contactHandler } from '../../routes/handlers/contactHandlers';
import { sendEmail } from '../../services/emailService';
import { getPortfolioData } from '../../services/portfolioService';
import type { PortfolioData } from '../../types/portfolio';

jest.mock('../../services/portfolioService', () => ({ getPortfolioData: jest.fn() }));
jest.mock('../../services/emailService', () => ({
  ...jest.requireActual('../../services/emailService'),
  sendEmail: jest.fn(),
}));

const mockedGetPortfolioData = jest.mocked(getPortfolioData);
const mockedSendEmail = jest.mocked(sendEmail);

function portfolioWithEmail(email: string): PortfolioData {
  return {
    knowledgeResume: null,
    profile: {
      name: 'Ray',
      title: 'Engineer',
      email,
      phone: null,
      location: null,
      linkedinUrl: null,
      githubUrl: null,
      summary: null,
      skills: [],
      experience: [],
      projects: [],
      fullResumeText: '',
      resumeFilename: null,
    },
  };
}

const submission = { name: 'Sam', email: 'sam@example.com', message: 'Hello' };

/**
 * A published profile may leave out the email address (#86). The contact form
 * is then unavailable: it answers 503 and sends nothing.
 */
describe('contact form recipient', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockedSendEmail.mockReset();
    app = Fastify();
    app.post('/contact', contactHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers 503 without sending when the profile has no email', async () => {
    mockedGetPortfolioData.mockResolvedValue(portfolioWithEmail(''));
    const res = await app.inject({ method: 'POST', url: '/contact', payload: submission });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'The contact form is not available right now' });
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it('sends to the profile email when there is one', async () => {
    mockedGetPortfolioData.mockResolvedValue(portfolioWithEmail('ray@example.com'));
    mockedSendEmail.mockResolvedValue(undefined);
    const res = await app.inject({ method: 'POST', url: '/contact', payload: submission });
    expect(res.statusCode).toBe(200);
    expect(mockedSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ray@example.com', replyTo: 'sam@example.com' }),
    );
  });
});
