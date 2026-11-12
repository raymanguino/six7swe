import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';

const base = {
  DATABASE_URL: 'postgres://localhost/db',
  KNOWLEDGE_SERVICE_KEY: 'k'.repeat(32),
  OWNER_AUTH_ID: 'owner',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ ...base, EMBEDDER: 'hashing', FILE_STORE: 'local' });
    expect(env).toMatchObject({
      PORT: 3100,
      STORAGE_BUCKET: 'portfolio-files',
      EMBEDDING_MODEL: 'openai/text-embedding-3-small',
      MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
      RESUME_INGESTION_ON_BOOT: true,
    });
  });

  it('lists every problem at once', () => {
    expect(() => loadEnv({})).toThrow(
      /DATABASE_URL[\s\S]*KNOWLEDGE_SERVICE_KEY[\s\S]*OWNER_AUTH_ID/,
    );
  });

  it('requires the OpenRouter key and Supabase settings for the production defaults', () => {
    expect(() => loadEnv(base)).toThrow(
      /OPENROUTER_API_KEY[\s\S]*SUPABASE_URL[\s\S]*SUPABASE_SECRET_KEY/,
    );
  });

  it('refuses the hashing embedder in production', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', EMBEDDER: 'hashing', FILE_STORE: 'local' }),
    ).toThrow(/EMBEDDER=hashing is for development and tests only/);
  });

  it('rejects a short service key', () => {
    expect(() =>
      loadEnv({
        ...base,
        KNOWLEDGE_SERVICE_KEY: 'short',
        EMBEDDER: 'hashing',
        FILE_STORE: 'local',
      }),
    ).toThrow(/at least 32 characters/);
  });
});
