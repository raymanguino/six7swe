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
        reject(signal.reason as Error);
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
});
