import Fastify, { FastifyInstance } from 'fastify';
import { chatHandler, MAX_CHAT_HISTORY_ITEMS } from '../../routes/handlers/chatHandlers';
import { chatWithContext } from '../../services/ai';

jest.mock('../../services/ai', () => ({ chatWithContext: jest.fn() }));
const mockedChat = jest.mocked(chatWithContext);

describe('POST /chat validation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockedChat.mockReset();
    mockedChat.mockResolvedValue('ok');
    app = Fastify({ logger: false });
    app.post('/chat', chatHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload?: unknown) =>
    app.inject({
      method: 'POST',
      url: '/chat',
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it.each([
    ['a missing body', undefined],
    ['no message', { history: [] }],
    ['a blank message', { message: '   ' }],
    ['a non-string message', { message: 42 }],
  ])('rejects %s', async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Message is required' });
    expect(mockedChat).not.toHaveBeenCalled();
  });

  it('rejects a message over the limit', async () => {
    const res = await post({ message: 'x'.repeat(2001) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Message must be at most 2000 characters' });
  });

  it.each([
    ['a non-array history', { message: 'hi', history: 'nope' }],
    ['an unknown role', { message: 'hi', history: [{ role: 'system', content: 'x' }] }],
    ['a non-string content', { message: 'hi', history: [{ role: 'user', content: 1 }] }],
  ])('rejects %s', async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid chat history' });
  });

  it('trims the message and bounds a long conversation instead of rejecting it', async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}:${'y'.repeat(3000)}`,
    }));

    const res = await post({ message: '  hello  ', history });

    expect(res.statusCode).toBe(200);
    const call = mockedChat.mock.calls[0]?.[0];
    expect(call?.message).toBe('hello');
    expect(call?.history).toHaveLength(MAX_CHAT_HISTORY_ITEMS);
    expect(call?.history?.[0]?.content.startsWith('10:')).toBe(true);
    expect(call?.history?.every((m) => m.content.length <= 2000)).toBe(true);
  });
});
