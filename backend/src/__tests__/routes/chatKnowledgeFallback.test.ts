import Fastify, { FastifyInstance } from 'fastify';
import { UNAVAILABLE_NOTE } from '../../data/chatContext';
import { chatHandler } from '../../routes/handlers/chatHandlers';
import { fitcheckHandler } from '../../routes/handlers/fitcheckHandlers';
import { resetDefaultRetriever } from '../../services/knowledgeRetrieval';
import { chatCompletion, structuredCompletion } from '../../services/minimaxService';

jest.mock('../../services/minimaxService', () => ({
  ...jest.requireActual('../../services/minimaxService'),
  chatCompletion: jest.fn(),
  structuredCompletion: jest.fn(),
}));

const mockedChatCompletion = jest.mocked(chatCompletion);
const mockedStructuredCompletion = jest.mocked(structuredCompletion);

/**
 * Retrieval is the only background source. A knowledge service that cannot
 * be reached must not break chat: it answers, saying the background is
 * unavailable. Fitcheck refuses instead (503): a verdict with no background
 * would only be a guess. Neither touches a database.
 */
describe('chat and fitcheck with the knowledge service down', () => {
  const savedEnv = { ...process.env };
  let app: FastifyInstance;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    process.env.KNOWLEDGE_URL = 'http://knowledge.invalid:3100';
    process.env.KNOWLEDGE_SERVICE_KEY = 'service-key';
    delete process.env.DATABASE_URL;
    resetDefaultRetriever();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    mockedChatCompletion.mockResolvedValue('I build backends.');

    app = Fastify({ logger: false });
    app.post('/chat', chatHandler);
    app.post('/fitcheck', fitcheckHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fetchSpy.mockRestore();
    process.env = { ...savedEnv };
    resetDefaultRetriever();
    mockedChatCompletion.mockReset();
    mockedStructuredCompletion.mockReset();
  });

  it('chat answers, telling the model the background is unavailable', async () => {
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
    expect(userPrompt).toContain(UNAVAILABLE_NOTE);
    expect(userPrompt).toContain('Current user question: What do you work on?');
  });

  it('fitcheck retrieves with the job description and answers from the chunks', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/version')) return Response.json({ version: 4 });
      return Response.json({
        version: 4,
        chunks: [
          {
            chunkId: '00000000-0000-4000-8000-000000000001',
            documentId: '00000000-0000-4000-8000-000000000002',
            filename: 'resume.md',
            heading: 'Acme',
            content: 'Led the TypeScript platform team.',
            similarity: 0.9,
          },
        ],
      });
    });
    mockedStructuredCompletion.mockResolvedValue({
      snarky_preamble: null,
      verdict: 'strong',
      where_i_match: [],
      gaps_to_note: [],
      where_i_dont_fit: [],
      what_does_transfer: '',
      recommendation: 'Apply.',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/fitcheck',
      payload: { jobDescription: 'Senior TypeScript engineer' },
    });

    expect(res.statusCode).toBe(200);
    const retrieveCall = fetchSpy.mock.calls.find(([input]) => String(input).endsWith('/retrieve'));
    expect(JSON.parse(String(retrieveCall?.[1]?.body))).toMatchObject({
      query: 'Senior TypeScript engineer',
    });
    const [messages] = mockedStructuredCompletion.mock.calls[0] ?? [];
    const userPrompt = messages?.find((m) => m.role === 'user')?.content ?? '';
    expect(userPrompt).toContain('Led the TypeScript platform team.');
  });

  it('fitcheck answers 503 without calling the model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/fitcheck',
      payload: { jobDescription: 'Senior TypeScript engineer' },
    });

    expect(res.statusCode).toBe(503);
    expect(fetchSpy).toHaveBeenCalled();
    expect(mockedStructuredCompletion).not.toHaveBeenCalled();
  });
});
