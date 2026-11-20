import { describe, expect, it, vi } from 'vitest';
import {
  completeWithMiniMax,
  completeWithMiniMaxDetailed,
  ModelError,
  stripThinking,
} from '../services/llm/minimax.js';

/**
 * The shared MiniMax client the risk scan (#212) and the eval answerer (#85)
 * call. Every failure is a `ModelError` with a fixed message; MiniMax's own
 * text goes to `detail`, redacted.
 */
describe('MiniMax client', () => {
  const URL = 'https://api.minimax.io/v1/chat/completions';
  const MESSAGES = [
    { role: 'system' as const, content: 'You answer briefly.' },
    { role: 'user' as const, content: 'Where did Jordan work?' },
  ];

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const answer = (content: string, finishReason = 'stop') =>
    reply({
      choices: [{ finish_reason: finishReason, message: { content, role: 'assistant' } }],
      base_resp: { status_code: 0, status_msg: 'success' },
    });

  const complete = (fetchImpl: typeof fetch, secondaryApiKey?: string, timeoutMs?: number) =>
    completeWithMiniMax(
      {
        url: URL,
        apiKey: 'mm-primary',
        secondaryApiKey,
        model: 'MiniMax-M3',
        fetchImpl,
        timeoutMs,
      },
      MESSAGES,
    );

  /** The ModelError a call fails with. */
  const failure = async (promise: Promise<unknown>): Promise<ModelError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ModelError) return error;
      throw error;
    }
    throw new Error('expected the call to fail');
  };

  /** A fetch that never answers on its own, only rejects when the request's signal aborts. */
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('calls MiniMax the way the backend does, and returns the answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(answer('Acme Corp')));
    expect(await complete(fetchImpl)).toBe('Acme Corp');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(URL);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mm-primary');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body).toMatchObject({
      model: 'MiniMax-M3',
      max_completion_tokens: 8192,
      reasoning_effort: 'medium',
    });
    expect(body.messages).toEqual(MESSAGES);
  });

  it('lets the caller set the completion budget', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(answer('ok')));
    await completeWithMiniMax(
      { url: URL, apiKey: 'mm-primary', model: 'MiniMax-M3', fetchImpl, maxCompletionTokens: 4096 },
      MESSAGES,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(4096);
  });

  it('strips a leading think block', async () => {
    expect(await complete(() => Promise.resolve(answer('<think>Hmm...</think>\nAcme')))).toBe(
      'Acme',
    );
    expect(stripThinking('  <think>a\nb</think> {"a":1}')).toBe('{"a":1}');
    expect(stripThinking('<think>never closes')).toBe('');
  });

  it('reports the finish reason, so a cut-off answer can be told apart', async () => {
    const completion = await completeWithMiniMaxDetailed(
      {
        url: URL,
        apiKey: 'mm-primary',
        model: 'MiniMax-M3',
        fetchImpl: () => Promise.resolve(answer('{"partial":', 'length')),
      },
      MESSAGES,
    );
    expect(completion).toEqual({ content: '{"partial":', finishReason: 'length' });
  });

  it('reports an error MiniMax returns inside a 200 body', async () => {
    const error = await failure(
      complete(() =>
        Promise.resolve(
          reply({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
        ),
      ),
    );
    expect(error.message).toBe('MiniMax returned an error (code 1008).');
    expect(error.detail).toBe('insufficient balance');
  });

  it('says so when the token limit was hit before an answer', async () => {
    await expect(complete(() => Promise.resolve(answer('', 'length')))).rejects.toThrow(
      'MiniMax hit its token limit before answering.',
    );
    await expect(
      complete(() => Promise.resolve(answer('<think>never closes', 'length'))),
    ).rejects.toThrow('MiniMax hit its token limit before answering.');
    await expect(complete(() => Promise.resolve(answer('')))).rejects.toThrow(
      'MiniMax sent an empty answer.',
    );
  });

  it('retries a 429 once with the secondary key', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        new Headers(init?.headers).get('authorization') === 'Bearer mm-primary'
          ? reply({ error: 'rate limited' }, 429)
          : answer('ok'),
      ),
    );
    expect(await complete(fetchImpl, 'mm-secondary')).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer mm-secondary',
    );

    // Without a secondary key, the 429 is the answer.
    const once = vi.fn<typeof fetch>(() => Promise.resolve(reply({}, 429)));
    await expect(complete(once)).rejects.toThrow('MiniMax returned an error (status 429).');
    expect(once).toHaveBeenCalledOnce();
  });

  it('cancels the rate-limited body before retrying', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const limited = reply({ error: 'rate limited' }, 429);
    Object.defineProperty(limited, 'body', { value: { cancel } });
    const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        new Headers(init?.headers).get('authorization') === 'Bearer mm-primary'
          ? limited
          : answer('ok'),
      ),
    );
    expect(await complete(fetchImpl, 'mm-secondary')).toBe('ok');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports the secondary key’s failure when it fails too', async () => {
    for (const second of [429, 503]) {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
        Promise.resolve(
          new Headers(init?.headers).get('authorization') === 'Bearer mm-primary'
            ? reply({}, 429)
            : reply({}, second),
        ),
      );
      await expect(complete(fetchImpl, 'mm-secondary')).rejects.toThrow(
        `MiniMax returned an error (status ${second}).`,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('turns other failures into fixed messages', async () => {
    await expect(
      complete(() => Promise.resolve(new Response('overloaded', { status: 503 }))),
    ).rejects.toThrow('MiniMax returned an error (status 503).');
    await expect(complete(() => Promise.reject(new TypeError('fetch failed')))).rejects.toThrow(
      'MiniMax could not be reached.',
    );
    await expect(
      complete(() => Promise.resolve(new Response('<html>gateway</html>'))),
    ).rejects.toThrow('MiniMax sent a response that was not JSON.');
  });

  it('reports a timeout, whether while connecting or reading the body', async () => {
    await expect(complete(hangingFetch, undefined, 20)).rejects.toThrow(
      'MiniMax did not answer in time.',
    );

    // The deadline strikes during res.json().
    const slowBody: typeof fetch = (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      } as unknown as Response);
    await expect(complete(slowBody, undefined, 20)).rejects.toThrow(
      'MiniMax did not answer in time.',
    );

    // ...or while an error body is read.
    const slowError: typeof fetch = (_url, init) =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      } as unknown as Response);
    await expect(complete(slowError, undefined, 20)).rejects.toThrow(
      'MiniMax did not answer in time.',
    );
  });

  it('never puts a key in an error message or detail', async () => {
    const leaky = [
      reply({ error: 'bad key mm-primary', echo: 'Bearer mm-primary-long-token-value' }, 401),
      reply({ base_resp: { status_code: 1004, status_msg: 'invalid key mm-secondary' } }),
    ];
    for (const res of leaky) {
      const error = await failure(complete(() => Promise.resolve(res), 'mm-secondary'));
      for (const text of [error.message, error.detail ?? '']) {
        expect(text).not.toContain('mm-primary');
        expect(text).not.toContain('mm-secondary');
      }
      expect(error.detail).toContain('[redacted]');
    }
  });
});
