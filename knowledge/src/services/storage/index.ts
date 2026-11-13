import type { FileStoreConfig } from '../../config/env.js';
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

export function createFileStore(config: FileStoreConfig): FileStore {
  switch (config.kind) {
    case 'local':
      return createLocalFileStore(config.dir);
    case 'supabase':
      return createSupabaseFileStore({
        url: config.url,
        secretKey: config.secretKey,
        bucket: config.bucket,
      });
  }
}
