import { chatCompletion, MiniMaxApiError } from '../services/minimaxService';

jest.mock('../data/chatContext', () => ({ getChatContext: jest.fn() }));

describe('chatCompletion key fallback', () => {
  const originalPrimaryKey = process.env.MINIMAX_API_KEY;
  const originalSecondaryKey = process.env.MINIMAX_API_KEY_SECONDARY;
  const messages = [{ role: 'user', content: 'Hello' }];
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  function successResponse(): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello back' } }] }), {
      status: 200,
    });
  }

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'primary-test-key';
    process.env.MINIMAX_API_KEY_SECONDARY = 'secondary-test-key';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (originalPrimaryKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalPrimaryKey;
    if (originalSecondaryKey === undefined) delete process.env.MINIMAX_API_KEY_SECONDARY;
    else process.env.MINIMAX_API_KEY_SECONDARY = originalSecondaryKey;
  });

  it('uses only the primary key when the request succeeds', async () => {
    fetchMock.mockResolvedValueOnce(successResponse());

    await expect(chatCompletion(messages)).resolves.toBe('Hello back');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer primary-test-key',
    });
  });

  it('retries an HTTP 429 with the secondary key and the same payload', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(successResponse());

    await expect(chatCompletion(messages, { max_tokens: 100 })).resolves.toBe('Hello back');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const primaryRequest = fetchMock.mock.calls[0][1];
    const secondaryRequest = fetchMock.mock.calls[1][1];
    expect(primaryRequest?.headers).toMatchObject({ Authorization: 'Bearer primary-test-key' });
    expect(secondaryRequest?.headers).toMatchObject({ Authorization: 'Bearer secondary-test-key' });
    expect(secondaryRequest?.body).toBe(primaryRequest?.body);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
  });

  it.each([undefined, ''])('preserves the 429 without a secondary key (%s)', async (key) => {
    if (key === undefined) delete process.env.MINIMAX_API_KEY_SECONDARY;
    else process.env.MINIMAX_API_KEY_SECONDARY = key;
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    await expect(chatCompletion(messages)).rejects.toMatchObject({
      name: 'MiniMaxApiError',
      code: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry other HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    await expect(chatCompletion(messages)).rejects.toMatchObject({ code: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry network errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));

    await expect(chatCompletion(messages)).rejects.toThrow('network error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry errors in a successful HTTP response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ base_resp: { status_code: 429, status_msg: 'limited' } })),
    );

    await expect(chatCompletion(messages)).rejects.toMatchObject({ code: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the secondary failure without a third request', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    await expect(chatCompletion(messages)).rejects.toMatchObject({
      name: MiniMaxApiError.name,
      code: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('starts each completion with the primary key', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(successResponse());

    await chatCompletion(messages);
    await chatCompletion(messages);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer primary-test-key',
    });
  });

  it('requires the primary key even when a secondary key is configured', async () => {
    delete process.env.MINIMAX_API_KEY;

    await expect(chatCompletion(messages)).rejects.toThrow('MINIMAX_API_KEY is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chatCompletion request timeout', () => {
  const originalPrimaryKey = process.env.MINIMAX_API_KEY;
  const messages = [{ role: 'user', content: 'Hello' }];
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  /**
   * A request that never answers.
   *
   * It rejects when the signal aborts, the way a real fetch does, so the
   * timeout is exercised rather than bypassed. A mock that simply never
   * settles would pass no matter what the code did with the signal.
   */
  function neverAnswers(init: RequestInit | undefined): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => {
        // The reason is whatever the signal aborted with; do not assume its type.
        const reason: unknown = signal.reason;
        reject(reason);
      });
    });
  }

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'primary-test-key';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (originalPrimaryKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalPrimaryKey;
  });

  it('bounds the request so a call that never answers cannot wait forever', async () => {
    // A request that never gets an answer would otherwise hold the
    // connection open until the caller is killed. In a CI job that is the
    // difference between a review that reports a timeout and a run that
    // burns its whole budget and says nothing.
    fetchMock.mockImplementation((_url, init) => neverAnswers(init));

    await expect(chatCompletion(messages, { timeoutMs: 20 })).rejects.toThrow(
      'MiniMax did not respond within 0.02 seconds',
    );
  });

  it('reports the timeout as a MiniMax error', async () => {
    fetchMock.mockImplementation((_url, init) => neverAnswers(init));

    await expect(chatCompletion(messages, { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'MiniMaxApiError',
    });
  });

  it('passes a timeout signal to the request', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );

    await chatCompletion(messages, { timeoutMs: 5_000 });

    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout that fires while the response body is being read', async () => {
    // Headers arrive at once, then the body never finishes. The deadline
    // fires during `response.json()`, outside the request itself.
    fetchMock.mockImplementation((_url, init) => {
      const signal = init?.signal as AbortSignal;
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason;
            controller.error(reason);
          });
        },
      });
      return Promise.resolve(new Response(stalled, { status: 200 }));
    });

    await expect(chatCompletion(messages, { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'MiniMaxApiError',
      message: 'MiniMax did not respond within 0.02 seconds',
    });
  });

  it('shares one deadline between the primary and the fallback request', async () => {
    process.env.MINIMAX_API_KEY_SECONDARY = 'secondary-test-key';
    try {
      fetchMock
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockImplementationOnce((_url, init) => neverAnswers(init));

      await expect(chatCompletion(messages, { timeoutMs: 20 })).rejects.toThrow(
        'MiniMax did not respond within 0.02 seconds',
      );

      const primarySignal = fetchMock.mock.calls[0][1]?.signal;
      const fallbackSignal = fetchMock.mock.calls[1][1]?.signal;
      expect(fallbackSignal).toBe(primarySignal);
    } finally {
      delete process.env.MINIMAX_API_KEY_SECONDARY;
    }
  });

  it('does not report an unrelated failure as a timeout', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(chatCompletion(messages, { timeoutMs: 5_000 })).rejects.toThrow('fetch failed');
  });
});

describe('chatCompletion at the token limit', () => {
  const originalPrimaryKey = process.env.MINIMAX_API_KEY;
  const messages = [{ role: 'user', content: 'Hello' }];
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  function lengthResponse(usage?: unknown): Response {
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage }),
      { status: 200 },
    );
  }

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'primary-test-key';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (originalPrimaryKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalPrimaryKey;
  });

  it('reports how the budget was spent, including the reasoning share', async () => {
    fetchMock.mockResolvedValueOnce(
      lengthResponse({
        prompt_tokens: 7000,
        completion_tokens: 8192,
        total_tokens: 15192,
        completion_tokens_details: { reasoning_tokens: 8192 },
      }),
    );

    await expect(chatCompletion(messages, { max_tokens: 8192 })).rejects.toThrow(
      new MiniMaxApiError(
        'MiniMax response hit the token limit before producing an answer (8192 of 8192 completion tokens used, 8192 of them reasoning; prompt 7000 tokens)',
      ),
    );
  });

  it('omits the reasoning share when the response does not report it', async () => {
    fetchMock.mockResolvedValueOnce(
      lengthResponse({ prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 }),
    );

    await expect(chatCompletion(messages, { max_tokens: 100 })).rejects.toThrow(
      'MiniMax response hit the token limit before producing an answer (100 of 100 completion tokens used; prompt 10 tokens)',
    );
  });

  it('still reports the limit when the response carries no usage', async () => {
    fetchMock.mockResolvedValueOnce(lengthResponse());

    await expect(chatCompletion(messages, { max_tokens: 100 })).rejects.toThrow(
      'MiniMax response hit the token limit before producing an answer (limit 100 tokens; no usage reported)',
    );
  });
});

describe('chatCompletion token usage', () => {
  const originalPrimaryKey = process.env.MINIMAX_API_KEY;
  const messages = [{ role: 'user', content: 'Hello' }];
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  function respond(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'primary-test-key';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (originalPrimaryKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalPrimaryKey;
  });

  it('reports the usage, with the reasoning share', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        choices: [{ message: { content: 'hi' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      }),
    );
    const onUsage = jest.fn();

    await chatCompletion(messages, { onUsage });

    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 10,
      completionTokens: 20,
      reasoningTokens: 15,
    });
  });

  it('reports the usage of a response that ran out of tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        choices: [{ finish_reason: 'length', message: { content: '' } }],
        usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
      }),
    );
    const onUsage = jest.fn();

    await expect(chatCompletion(messages, { max_tokens: 100, onUsage })).rejects.toThrow(
      MiniMaxApiError,
    );
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 10,
      completionTokens: 100,
      reasoningTokens: null,
    });
  });

  it('does not call back when the response reports no usage', async () => {
    fetchMock.mockResolvedValueOnce(respond({ choices: [{ message: { content: 'hi' } }] }));
    const onUsage = jest.fn();

    await chatCompletion(messages, { onUsage });

    expect(onUsage).not.toHaveBeenCalled();
  });
});
