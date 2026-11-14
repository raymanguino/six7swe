import { awaitKnowledgeReady } from '../../services/knowledge/awaitReady';

type Step = Error | number;

/** Plays `steps` in order, then repeats the last one; an Error is thrown, a number is a status. */
function setup(steps: Step[], baseUrl = 'http://127.0.0.1:3100/') {
  let clock = 0;
  let calls = 0;
  const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => {
    const step = steps[Math.min(calls, steps.length - 1)] ?? 200;
    calls += 1;
    if (step instanceof Error) throw step;
    return new Response('{}', { status: step });
  });
  const sleep = jest.fn(async (ms: number) => {
    clock += ms;
  });
  const onWaiting = jest.fn();
  const run = () =>
    awaitKnowledgeReady({
      baseUrl,
      serviceKey: 'k',
      fetchFn,
      now: () => clock,
      sleep,
      onWaiting,
    });
  return { fetchFn, sleep, onWaiting, run };
}

/** Node's undici shape: `TypeError: fetch failed` whose cause carries the errno code. */
function fetchFailed(message: string, code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(message), { code }),
  });
}

function refused(): Error {
  return fetchFailed('connect ECONNREFUSED 127.0.0.1:3100', 'ECONNREFUSED');
}

describe('awaitKnowledgeReady', () => {
  it('is ready at once when the service answers 200', async () => {
    const s = setup([200]);
    await expect(s.run()).resolves.toEqual({ ready: true });
    expect(s.sleep).not.toHaveBeenCalled();
    expect(s.onWaiting).not.toHaveBeenCalled();
    const [url, init] = s.fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:3100/version');
    expect((init?.headers as Record<string, string>)['x-knowledge-key']).toBe('k');
  });

  it('retries refused connections and warns once', async () => {
    const s = setup([refused(), refused(), refused(), 200]);
    await expect(s.run()).resolves.toEqual({ ready: true });
    expect(s.fetchFn).toHaveBeenCalledTimes(4);
    expect(s.sleep).toHaveBeenCalledTimes(3);
    expect(s.onWaiting).toHaveBeenCalledTimes(1);
  });

  it('retries resets and per-attempt timeouts', async () => {
    const reset = fetchFailed('read ECONNRESET', 'ECONNRESET');
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    const s = setup([reset, timeout, 200]);
    await expect(s.run()).resolves.toEqual({ ready: true });
    expect(s.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('gives up on repeated 503 at the timeout, keeping the last reason', async () => {
    const s = setup([503]);
    const result = await s.run();
    expect(result).toEqual({ ready: false, reason: 'HTTP 503 from /version', retryable: true });
    expect(s.onWaiting).toHaveBeenCalledTimes(1);
    expect(s.sleep.mock.calls.length).toBeGreaterThanOrEqual(59);
  });

  it('gives up when the service never accepts connections', async () => {
    const s = setup([refused()]);
    const result = await s.run();
    expect(result).toMatchObject({ ready: false, retryable: true });
    expect(result.ready === false && result.reason).toMatch(/ECONNREFUSED/);
  });

  it('stops after one attempt on 401 with a key hint', async () => {
    const s = setup([401]);
    const result = await s.run();
    expect(result).toMatchObject({ ready: false, retryable: false });
    expect(result.ready === false && result.reason).toMatch(/KNOWLEDGE_SERVICE_KEY/);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    expect(s.sleep).not.toHaveBeenCalled();
  });

  it('stops on 404 with a URL hint', async () => {
    const s = setup([404]);
    const result = await s.run();
    expect(result).toMatchObject({ ready: false, retryable: false });
    expect(result.ready === false && result.reason).toMatch(/KNOWLEDGE_SERVICE_URL/);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stops on an unexpected non-network error', async () => {
    const s = setup([new Error('boom')]);
    await expect(s.run()).resolves.toEqual({ ready: false, reason: 'boom', retryable: false });
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on an invalid URL without calling fetch', async () => {
    const s = setup([200], 'not a url');
    const result = await s.run();
    expect(result).toMatchObject({ ready: false, retryable: false });
    expect(result.ready === false && result.reason).toMatch(/KNOWLEDGE_SERVICE_URL/);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
});
