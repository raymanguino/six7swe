import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';

const base = {
  DATABASE_URL: 'postgres://localhost/db',
  KNOWLEDGE_SERVICE_KEY: 'k'.repeat(32),
  KNOWLEDGE_OWNER_KEY: 'o'.repeat(32),
  OWNER_AUTH_ID: 'owner',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ ...base, EMBEDDER: 'hashing', FILE_STORE: 'local' });
    expect(env).toMatchObject({
      PORT: 3100,
      STORAGE_BUCKET: 'portfolio-files',
      MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
      RESUME_INGESTION_ON_BOOT: true,
    });
  });

  it('lists every problem at once', () => {
    expect(() => loadEnv({})).toThrow(
      /DATABASE_URL[\s\S]*KNOWLEDGE_SERVICE_KEY[\s\S]*KNOWLEDGE_OWNER_KEY[\s\S]*OWNER_AUTH_ID/,
    );
  });

  it('requires the OpenAI key and Supabase settings for the production defaults', () => {
    expect(() => loadEnv(base)).toThrow(
      /OPENAI_API_KEY is required when EMBEDDER=openai[\s\S]*SUPABASE_URL[\s\S]*SUPABASE_SECRET_KEY/,
    );
  });

  it('defaults to the OpenAI embedder and its model', () => {
    const env = loadEnv({ ...base, OPENAI_API_KEY: 'sk', FILE_STORE: 'local' });
    expect(env.embedder).toEqual({
      kind: 'openai-compatible',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk',
      model: 'text-embedding-3-small',
    });
  });

  it('requires the OpenRouter key, not the OpenAI one, for EMBEDDER=openrouter', () => {
    const env = { ...base, EMBEDDER: 'openrouter', FILE_STORE: 'local' };
    expect(() => loadEnv({ ...env, OPENAI_API_KEY: 'sk' })).toThrow(
      /OPENROUTER_API_KEY is required when EMBEDDER=openrouter/,
    );
    expect(loadEnv({ ...env, OPENROUTER_API_KEY: 'sk-or' }).embedder).toMatchObject({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/text-embedding-3-small',
    });
  });

  it('requires an owner key of at least 32 characters that differs from the service key', () => {
    const env = { ...base, EMBEDDER: 'hashing', FILE_STORE: 'local' };
    expect(() => loadEnv({ ...env, KNOWLEDGE_OWNER_KEY: 'short' })).toThrow(
      /KNOWLEDGE_OWNER_KEY must be at least 32 characters/,
    );
    expect(() => loadEnv({ ...env, KNOWLEDGE_OWNER_KEY: base.KNOWLEDGE_SERVICE_KEY })).toThrow(
      /KNOWLEDGE_OWNER_KEY must differ from KNOWLEDGE_SERVICE_KEY/,
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

  it.each(['../evil', 'a/b', 'has space', '.', '..'])(
    'rejects OWNER_AUTH_ID %j, which would be an unsafe storage key',
    (owner) => {
      expect(() =>
        loadEnv({ ...base, OWNER_AUTH_ID: owner, EMBEDDER: 'hashing', FILE_STORE: 'local' }),
      ).toThrow(/OWNER_AUTH_ID/);
    },
  );

  it('accepts a Supabase user id as OWNER_AUTH_ID', () => {
    const owner = '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
    expect(
      loadEnv({ ...base, OWNER_AUTH_ID: owner, EMBEDDER: 'hashing', FILE_STORE: 'local' })
        .OWNER_AUTH_ID,
    ).toBe(owner);
  });

  it('caps MAX_UPLOAD_BYTES at 50 MB', () => {
    const env = { ...base, EMBEDDER: 'hashing', FILE_STORE: 'local' };
    expect(loadEnv({ ...env, MAX_UPLOAD_BYTES: String(50 * 1024 * 1024) }).MAX_UPLOAD_BYTES).toBe(
      50 * 1024 * 1024,
    );
    expect(() => loadEnv({ ...env, MAX_UPLOAD_BYTES: String(50 * 1024 * 1024 + 1) })).toThrow(
      /MAX_UPLOAD_BYTES must be at most 50 MB/,
    );
  });
});
