import type { Env } from '../../config/env.js';
import { createLocalFileStore } from './local.js';
import { createSupabaseFileStore } from './supabase.js';

/** Where the raw uploaded files live. The database only holds their keys. */
export interface FileStore {
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Removing a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
}

export function createFileStore(env: Env): FileStore {
  if (env.FILE_STORE === 'local') return createLocalFileStore(env.LOCAL_FILE_STORE_DIR);
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for FILE_STORE=supabase');
  }
  return createSupabaseFileStore({
    url: env.SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
    bucket: env.STORAGE_BUCKET,
  });
}

const SAFE_KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Rejects keys that could escape a directory or a bucket prefix. */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
