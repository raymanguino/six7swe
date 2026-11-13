import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeKey } from '../lib/storageKeys.js';
import { createLocalFileStore } from '../services/storage/local.js';

describe('assertSafeKey', () => {
  it('accepts owner/sha.ext keys', () => {
    expect(() => assertSafeKey('owner-1/abc123.pdf')).not.toThrow();
  });

  it.each(['../x', 'a/../b', '/abs', 'a//b', 'a\\b', 'a/./b', ''])('rejects %j', (key) => {
    expect(() => assertSafeKey(key)).toThrow(/Unsafe storage key/);
  });
});

describe('local file store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-files-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips bytes and deletes idempotently', async () => {
    const store = createLocalFileStore(dir);
    await store.put('o/a.txt', new Uint8Array([1, 2, 3]), 'text/plain');
    expect(Array.from(await store.get('o/a.txt'))).toEqual([1, 2, 3]);
    await store.delete('o/a.txt');
    await store.delete('o/a.txt');
    await expect(store.get('o/a.txt')).rejects.toThrow();
  });
});
