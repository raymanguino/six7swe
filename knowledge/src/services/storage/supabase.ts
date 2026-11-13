import { createClient } from '@supabase/supabase-js';
import type { FileStore } from './index.js';
import { assertSafeKey } from './keys.js';

export interface SupabaseFileStoreOptions {
  url: string;
  /** A secret (service role) key. Only this service ever holds it. */
  secretKey: string;
  bucket: string;
}

/** Keeps files in a private Supabase Storage bucket. */
export function createSupabaseFileStore(options: SupabaseFileStoreOptions): FileStore {
  const client = createClient(options.url, options.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = () => client.storage.from(options.bucket);

  return {
    name: `supabase:${options.bucket}`,
    async put(key, bytes, contentType) {
      assertSafeKey(key);
      const { error } = await bucket().upload(key, bytes, { contentType, upsert: true });
      if (error) throw new Error(`Storage upload failed for ${key}: ${error.message}`);
    },
    async get(key) {
      assertSafeKey(key);
      const { data, error } = await bucket().download(key);
      if (error || !data) {
        throw new Error(`Storage download failed for ${key}: ${error?.message ?? 'no data'}`);
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async delete(key) {
      assertSafeKey(key);
      const { error } = await bucket().remove([key]);
      if (error) throw new Error(`Storage delete failed for ${key}: ${error.message}`);
    },
  };
}
