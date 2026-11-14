import Fastify, { FastifyInstance } from 'fastify';
import { chatHandler } from '../../routes/handlers/chatHandlers';
import { resetDefaultRetriever } from '../../services/knowledgeRetrieval';
import { chatCompletion } from '../../services/minimaxService';
import { getPortfolioData } from '../../services/portfolioService';
import type { PortfolioData } from '../../types/portfolio';

jest.mock('../../services/portfolioService', () => ({ getPortfolioData: jest.fn() }));
jest.mock('../../services/minimaxService', () => ({
  ...jest.requireActual('../../services/minimaxService'),
  chatCompletion: jest.fn(),
}));

const mockedGetPortfolioData = jest.mocked(getPortfolioData);
const mockedChatCompletion = jest.mocked(chatCompletion);

const portfolio: PortfolioData = {
  profile: {
    id: 1,
    name: 'Ray Manguino',
    title: 'Software Engineer',
    email: 'ray@example.com',
    phone: null,
    location: null,
    linkedinUrl: null,
    githubUrl: null,
    summary: 'Backend engineer.',
    skills: ['TypeScript'],
    experience: [],
    projects: [],
    fullResumeText: 'FULL RESUME TEXT',
    resumeFilename: null,
  },
  contentSections: [],
};

/**
 * With PORTFOLIO_DATA_SOURCE=knowledge, a knowledge service that cannot be
 * reached must not break chat: the answer is grounded in the profile summary.
 */
describe('POST /chat with the knowledge service down', () => {
  const savedEnv = { ...process.env };
  let app: FastifyInstance;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    process.env.PORTFOLIO_DATA_SOURCE = 'knowledge';
    process.env.KNOWLEDGE_URL = 'http://knowledge.invalid:3100';
    process.env.KNOWLEDGE_SERVICE_KEY = 'service-key';
    resetDefaultRetriever();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    mockedGetPortfolioData.mockResolvedValue(portfolio);
    mockedChatCompletion.mockResolvedValue('I build backends.');

    app = Fastify({ logger: false });
    app.post('/chat', chatHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
    process.env = { ...savedEnv };
    resetDefaultRetriever();
  });

  it('answers from the profile-only context', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { message: 'What do you work on?' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ response: 'I build backends.' });
    expect(fetchSpy).toHaveBeenCalled();

    const [messages] = mockedChatCompletion.mock.calls[0] ?? [];
    const userPrompt = messages?.find((m) => m.role === 'user')?.content ?? '';
    expect(userPrompt).toContain('Profile summary:');
    expect(userPrompt).toContain('Detailed background documents are unavailable right now.');
    expect(userPrompt).toContain('Current user question: What do you work on?');
    expect(userPrompt).not.toContain('FULL RESUME TEXT');
  });
});
