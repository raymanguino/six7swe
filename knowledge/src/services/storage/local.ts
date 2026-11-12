import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeKey, type FileStore } from './index.js';

/** Keeps files on the local disk. For development only: Railway disks are ephemeral. */
export function createLocalFileStore(rootDir: string): FileStore {
  const root = path.resolve(rootDir);
  const resolve = (key: string) => {
    assertSafeKey(key);
    return path.join(root, ...key.split('/'));
  };

  return {
    name: `local:${root}`,
    async put(key, bytes) {
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    async get(key) {
      return new Uint8Array(await readFile(resolve(key)));
    },
    async delete(key) {
      await rm(resolve(key), { force: true });
    },
  };
}
