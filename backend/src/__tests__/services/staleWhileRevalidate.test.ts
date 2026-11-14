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
