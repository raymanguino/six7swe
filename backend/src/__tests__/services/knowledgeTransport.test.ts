import { SERVICE_KEY_HEADER } from '@six7swe/knowledge-types';
import {
  isTimeoutError,
  KnowledgeTransportError,
  parseJsonBody,
  sendKnowledgeRequest,
  type FetchLike,
} from '../../services/knowledge/transport';

const base = { baseUrl: 'http://knowledge:3100', key: 'k', path: '/x', timeoutMs: 500 };

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function capture(response?: Response) {
  return jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(
    async () => response ?? new Response('{}', { status: 200 }),
  );
}

async function failure(fetch: FetchLike): Promise<KnowledgeTransportError> {
  try {
    await sendKnowledgeRequest({ ...base, method: 'GET', fetch });
  } catch (error) {
    if (error instanceof KnowledgeTransportError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('sendKnowledgeRequest', () => {
  it('sends the key header, refuses redirects and sets a timeout signal', async () => {
    const fetch = capture();
    const reply = await sendKnowledgeRequest({ ...base, method: 'GET', fetch });
    expect(reply).toEqual({ status: 200, text: '{}' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://knowledge:3100/x');
    expect(init?.headers).toEqual({ [SERVICE_KEY_HEADER]: 'k' });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeUndefined();
  });

  it('passes a string body as is and copies a Buffer, with content-type only when set', async () => {
    const fetch = capture();
    await sendKnowledgeRequest({
      ...base,
      method: 'POST',
      body: '{"a":1}',
      contentType: 'application/json',
      fetch,
    });
    await sendKnowledgeRequest({ ...base, method: 'POST', body: Buffer.from('abc'), fetch });
    const [, withString] = fetch.mock.calls[0] ?? [];
    const [, withBuffer] = fetch.mock.calls[1] ?? [];
    expect(withString?.body).toBe('{"a":1}');
    expect(withString?.headers).toEqual({
      [SERVICE_KEY_HEADER]: 'k',
      'content-type': 'application/json',
    });
    expect(withBuffer?.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(withBuffer?.body as Uint8Array).toString()).toBe('abc');
    expect(withBuffer?.headers).toEqual({ [SERVICE_KEY_HEADER]: 'k' });
  });

  it.each(['TimeoutError', 'AbortError'])('maps a %s from fetch to kind timeout', async (name) => {
    const error = await failure(async () => {
      throw named(name);
    });
    expect(error.kind).toBe('timeout');
    expect(error.message).toBe('timed out after 500 ms');
  });

  it('maps any other failure to unreachable and keeps the original', async () => {
    const original = new TypeError('fetch failed');
    const error = await failure(async () => {
      throw original;
    });
    expect(error.kind).toBe('unreachable');
    expect(error.original).toBe(original);
    expect(error.message).toBe('unreachable: fetch failed');
  });

  it('maps a failure while the body is read', async () => {
    const slow = new Response('x');
    jest.spyOn(slow, 'text').mockRejectedValue(named('TimeoutError'));
    expect((await failure(capture(slow))).kind).toBe('timeout');

    const dropped = new Response('x');
    jest.spyOn(dropped, 'text').mockRejectedValue(new Error('socket hang up'));
    expect((await failure(capture(dropped))).kind).toBe('unreachable');
  });
});

describe('parseJsonBody', () => {
  it('returns undefined for empty and invalid text, and null for "null"', () => {
    expect(parseJsonBody('')).toBeUndefined();
    expect(parseJsonBody('{oops')).toBeUndefined();
    expect(parseJsonBody('null')).toBeNull();
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('isTimeoutError', () => {
  it('matches by name and tolerates non-objects', () => {
    expect(isTimeoutError(named('TimeoutError'))).toBe(true);
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true);
    expect(isTimeoutError(new Error('x'))).toBe(false);
    for (const value of [null, undefined, 'TimeoutError', 42]) {
      expect(isTimeoutError(value)).toBe(false);
    }
  });
});
