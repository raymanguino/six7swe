import Fastify, { FastifyInstance } from 'fastify';
import { chatClientKey, CHAT_RATE_LIMIT, registerChatRoute } from '../../routes/chatRateLimit';

describe('chatClientKey', () => {
  it('uses the last X-Forwarded-For entry, the one the proxy appended', () => {
    expect(
      chatClientKey({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, ip: '10.0.0.1' }),
    ).toBe('1.2.3.4');
    expect(
      chatClientKey({ headers: { 'x-forwarded-for': ['6.6.6.6', '1.2.3.4 '] }, ip: 'x' }),
    ).toBe('1.2.3.4');
  });

  it('falls back to the socket address', () => {
    expect(chatClientKey({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
    expect(chatClientKey({ headers: { 'x-forwarded-for': ' , ' }, ip: '10.0.0.1' })).toBe(
      '10.0.0.1',
    );
  });
});

describe('POST /chat rate limit', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await registerChatRoute(
      app,
      async (req) => ({ response: 'ok', public: req.routeOptions.config.public }),
      { max: 3 },
    );
    // A route outside the chat scope is not limited.
    app.get('/other', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const chat = (client: string) =>
    app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-forwarded-for': client },
      payload: { message: 'hi' },
    });

  it('answers 429 once a client spends its budget, per client', async () => {
    for (let i = 0; i < 3; i++) expect((await chat('1.1.1.1')).statusCode).toBe(200);
    const limited = await chat('1.1.1.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toMatchObject({
      error: expect.stringContaining("You're sending messages too quickly"),
    });

    // Another client has its own budget, and a forged first entry does not reset it.
    expect((await chat('2.2.2.2')).statusCode).toBe(200);
    expect((await chat('9.9.9.9, 1.1.1.1')).statusCode).toBe(429);
  });

  it('leaves other routes alone', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/other' })).statusCode).toBe(200);
    }
  });

  it('keeps the chat route public', async () => {
    expect(CHAT_RATE_LIMIT.max).toBeGreaterThan(0);
    expect((await chat('3.3.3.3')).json()).toEqual({ response: 'ok', public: true });
  });
});
