import { CHAT_EXAMPLE_QUESTIONS } from '@six7swe/knowledge-types';
import Fastify, { FastifyInstance } from 'fastify';
import { chatHandler } from '../../routes/handlers/chatHandlers';
import { chatWithContext } from '../../services/ai';
import {
  countExampleClick,
  createExampleClickClient,
  getDefaultExampleClickClient,
} from '../../services/knowledge/exampleClicks';

jest.mock('../../services/ai', () => ({ chatWithContext: jest.fn() }));
jest.mock('../../services/knowledge/exampleClicks', () => {
  const actual: typeof import('../../services/knowledge/exampleClicks') = jest.requireActual(
    '../../services/knowledge/exampleClicks',
  );
  const recordClick = jest.fn().mockResolvedValue(true);
  return {
    ...actual,
    getDefaultExampleClickClient: () => ({ recordClick }),
    countExampleClick: jest.fn((message: string, log: { warn: () => void }) =>
      actual.countExampleClick(message, log, { recordClick }),
    ),
  };
});

const mockedChat = jest.mocked(chatWithContext);
const recordClick = jest.mocked(getDefaultExampleClickClient()?.recordClick);
const EXAMPLE = CHAT_EXAMPLE_QUESTIONS[0];
const SESSION = 'session-aaaa';

describe('POST /chat with a clicked example', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockedChat.mockReset();
    mockedChat.mockResolvedValue('ok');
    recordClick?.mockClear();
    jest.mocked(countExampleClick).mockClear();
    app = Fastify({ logger: false });
    app.post('/chat', chatHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/chat', payload });

  it('counts the click and does not record the question as typed', async () => {
    const res = await post({ message: EXAMPLE, sessionId: SESSION, example: true });
    expect(res.statusCode).toBe(200);
    expect(recordClick).toHaveBeenCalledWith(EXAMPLE);
    // No session id: the knowledge service does not record it as a typed question.
    expect(mockedChat.mock.calls[0]?.[0]).toMatchObject({ message: EXAMPLE });
    expect(mockedChat.mock.calls[0]?.[0].sessionId).toBeUndefined();
  });

  it('treats anything but an exact example as typed', async () => {
    for (const message of [`${EXAMPLE} please`, 'Tell me about Rust']) {
      await post({ message, sessionId: SESSION, example: true });
    }
    // Typed exactly like an example, but not clicked: a typed question.
    await post({ message: EXAMPLE, sessionId: SESSION });
    expect(recordClick).not.toHaveBeenCalled();
    expect(mockedChat.mock.calls.map((c) => c[0].sessionId)).toEqual([SESSION, SESSION, SESSION]);
  });

  it('answers even when counting the click fails', async () => {
    recordClick?.mockRejectedValueOnce(new Error('down'));
    const res = await post({ message: EXAMPLE, sessionId: SESSION, example: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ response: 'ok' });
  });

  it('ignores a malformed example flag', async () => {
    const res = await post({ message: EXAMPLE, sessionId: SESSION, example: 'yes' });
    expect(res.statusCode).toBe(200);
    expect(recordClick).not.toHaveBeenCalled();
    expect(mockedChat.mock.calls[0]?.[0].sessionId).toBe(SESSION);
  });
});

describe('createExampleClickClient', () => {
  it('posts the exact text to the service route with the service key', async () => {
    const fetchFn = jest.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ counted: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createExampleClickClient(
      { baseUrl: 'http://knowledge.test', key: 'service-key', timeoutMs: 1000 },
      fetchFn,
    );
    expect(await client.recordClick(EXAMPLE)).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://knowledge.test/eval/example-clicks');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ question: EXAMPLE });
    expect((init?.headers as Record<string, string>)['x-knowledge-key']).toBe('service-key');
  });

  it('does nothing for a message that is not an example', () => {
    const client = { recordClick: jest.fn().mockResolvedValue(true) };
    const log = { warn: jest.fn() };
    const actual: typeof import('../../services/knowledge/exampleClicks') = jest.requireActual(
      '../../services/knowledge/exampleClicks',
    );
    expect(actual.countExampleClick('Something typed', log, client)).toBe(false);
    expect(actual.countExampleClick(EXAMPLE, log, client)).toBe(true);
    expect(client.recordClick).toHaveBeenCalledTimes(1);
  });
});
