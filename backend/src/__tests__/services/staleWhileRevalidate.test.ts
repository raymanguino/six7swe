import { createSwrCache } from '../../services/staleWhileRevalidate';

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  let clock = 0;
  let next: () => Promise<string> = () => Promise.resolve('v1');
  const load = jest.fn(() => next());
  const errors: unknown[] = [];
  const cache = createSwrCache(load, {
    ttlMs: 100,
    retryAfterFailureMs: 30,
    now: () => clock,
    onBackgroundError: (error) => errors.push(error),
  });
  return {
    cache,
    load,
    errors,
    advance: (ms: number) => {
      clock += ms;
    },
    willLoad: (fn: () => Promise<string>) => {
      next = fn;
    },
  };
}

describe('createSwrCache', () => {
  it('loads once and serves from memory while fresh', async () => {
    const { cache, load } = setup();
    expect(await cache.get()).toBe('v1');
    expect(await cache.get()).toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one load between concurrent first callers', async () => {
    const { cache, load } = setup();
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value at once and refreshes in the background', async () => {
    const { cache, load, advance, willLoad } = setup();
    await cache.get();
    advance(100);
    willLoad(() => Promise.resolve('v2'));

    expect(await cache.get()).toBe('v1');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(await cache.get()).toBe('v2');
  });

  it('keeps the last good value when the source is down, and retries after a pause', async () => {
    const { cache, load, errors, advance, willLoad } = setup();
    await cache.get();
    advance(100);
    willLoad(() => Promise.reject(new Error('knowledge service down')));

    expect(await cache.get()).toBe('v1');
    await flush();
    expect(errors).toHaveLength(1);
    // Within the pause, the source is not asked again.
    advance(10);
    expect(await cache.get()).toBe('v1');
    expect(load).toHaveBeenCalledTimes(2);

    advance(30);
    willLoad(() => Promise.resolve('v2'));
    expect(await cache.get()).toBe('v1');
    await flush();
    expect(await cache.get()).toBe('v2');
  });

  it('waits for fresh data after invalidate, falling back to the last good value', async () => {
    const { cache, errors, willLoad } = setup();
    await cache.get();

    willLoad(() => Promise.resolve('published'));
    cache.invalidate();
    expect(await cache.get()).toBe('published');

    willLoad(() => Promise.reject(new Error('down')));
    cache.invalidate();
    expect(await cache.get()).toBe('published');
    expect(errors).toHaveLength(1);
  });

  it('throws when there is nothing to fall back on, without asking again during the pause', async () => {
    const { cache, load, advance, willLoad } = setup();
    willLoad(() => Promise.reject(new Error('down')));
    await expect(cache.get()).rejects.toThrow('down');
    await expect(cache.get()).rejects.toThrow('down');
    expect(load).toHaveBeenCalledTimes(1);

    advance(30);
    willLoad(() => Promise.resolve('back'));
    expect(await cache.get()).toBe('back');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('asks the source again right after invalidate(), even during a failure pause', async () => {
    const { cache, load, willLoad } = setup();
    willLoad(() => Promise.reject(new Error('down')));
    await expect(cache.get()).rejects.toThrow('down');

    // The service is back and the owner publishes within the pause.
    willLoad(() => Promise.resolve('published'));
    cache.invalidate();
    expect(await cache.get()).toBe('published');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('treats a load that throws synchronously like one that rejects', async () => {
    const { cache, load, errors, advance, willLoad } = setup();
    willLoad(() => {
      throw new Error('sync boom');
    });
    await expect(cache.get()).rejects.toThrow('sync boom');
    // Remembered like any failure: no second call within the pause.
    await expect(cache.get()).rejects.toThrow('sync boom');
    expect(load).toHaveBeenCalledTimes(1);

    advance(30);
    willLoad(() => Promise.resolve('v1'));
    expect(await cache.get()).toBe('v1');

    // As a background refresh, it is reported and the value is kept.
    advance(100);
    willLoad(() => {
      throw new Error('sync boom');
    });
    expect(await cache.get()).toBe('v1');
    await flush();
    expect(errors).toHaveLength(1);
  });

  it('never lets a load started before invalidate() stand in for fresh data', async () => {
    const { cache, advance, willLoad } = setup();
    await cache.get();
    advance(100);

    // A background refresh starts with pre-publish data and is still in flight...
    let finishOld: (value: string) => void = () => {};
    willLoad(() => new Promise<string>((resolve) => (finishOld = resolve)));
    expect(await cache.get()).toBe('v1');

    // ...when the owner publishes.
    cache.invalidate();
    willLoad(() => Promise.resolve('published'));
    const next = cache.get();
    finishOld('pre-publish');
    expect(await next).toBe('published');
    await flush();
    expect(await cache.get()).toBe('published');
  });

  it('never lets a load started before clear() fill the cache back in', async () => {
    const { cache, load, willLoad } = setup();
    let finishOld: (value: string) => void = () => {};
    willLoad(() => new Promise<string>((resolve) => (finishOld = resolve)));
    const first = cache.get();
    await flush();

    cache.clear();
    finishOld('before-clear');
    expect(await first).toBe('before-clear');

    willLoad(() => Promise.resolve('after-clear'));
    expect(await cache.get()).toBe('after-clear');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps the invalidation when a load from before it fails', async () => {
    const { cache, load, advance, willLoad } = setup();
    await cache.get();
    advance(100);
    let failOld: (error: Error) => void = () => {};
    willLoad(() => new Promise<string>((_, reject) => (failOld = reject)));
    expect(await cache.get()).toBe('v1');

    cache.invalidate();
    failOld(new Error('old load failed'));
    await flush();

    willLoad(() => Promise.resolve('published'));
    expect(await cache.get()).toBe('published');
    expect(load).toHaveBeenCalledTimes(3);
  });
});
