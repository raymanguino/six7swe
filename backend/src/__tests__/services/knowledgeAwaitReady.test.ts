import { awaitKnowledgeReady } from '../../services/knowledge/awaitReady';

function setup(failures: number, status = 200) {
  let clock = 0;
  let calls = 0;
  const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => {
    calls += 1;
    if (calls <= failures) throw new Error('fetch failed');
    return new Response('{}', { status });
  });
  const sleep = jest.fn(async (ms: number) => {
    clock += ms;
  });
  const onWaiting = jest.fn();
  const run = () =>
    awaitKnowledgeReady({
      baseUrl: 'http://127.0.0.1:3100/',
      serviceKey: 'k',
      fetchFn,
      now: () => clock,
      sleep,
      onWaiting,
    });
  return { fetchFn, sleep, onWaiting, run };
}

describe('awaitKnowledgeReady', () => {
  it('returns true at once when the service answers 200', async () => {
    const s = setup(0);
    await expect(s.run()).resolves.toBe(true);
    expect(s.sleep).not.toHaveBeenCalled();
    expect(s.onWaiting).not.toHaveBeenCalled();
    const [url, init] = s.fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:3100/version');
    expect((init?.headers as Record<string, string>)['x-knowledge-key']).toBe('k');
  });

  it('retries after failures and warns once', async () => {
    const s = setup(3);
    await expect(s.run()).resolves.toBe(true);
    expect(s.fetchFn).toHaveBeenCalledTimes(4);
    expect(s.sleep).toHaveBeenCalledTimes(3);
    expect(s.onWaiting).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting on non-200 answers and gives up at the timeout', async () => {
    const s = setup(0, 503);
    await expect(s.run()).resolves.toBe(false);
    expect(s.onWaiting).toHaveBeenCalledTimes(1);
    expect(s.sleep.mock.calls.length).toBeGreaterThanOrEqual(59);
  });

  it('gives up when the service never accepts connections', async () => {
    const s = setup(Number.MAX_SAFE_INTEGER);
    await expect(s.run()).resolves.toBe(false);
  });
});
