import { z } from 'zod';
import { isSafeKeySegment } from '../lib/storageKeys.js';

/** Hard ceiling for MAX_UPLOAD_BYTES: uploads are buffered in memory. */
export const MAX_UPLOAD_BYTES_CEILING = 50 * 1024 * 1024;

/**
 * Service configuration, validated once at startup.
 *
 * Everything the service reads from the environment goes through here, so a
 * missing or malformed variable fails the boot instead of the first request.
 */

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3100),
    /**
     * `::` listens on IPv6 and, on Linux and Windows, IPv4 too (dual-stack), so
     * `localhost` works whichever family it resolves to first. Set `0.0.0.0` on
     * a host with IPv6 disabled.
     */
    HOST: z.string().default('::'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /** Shared secret for service-to-service calls (the portfolio and hunter backends). */
    KNOWLEDGE_SERVICE_KEY: z
      .string()
      .min(32, 'KNOWLEDGE_SERVICE_KEY must be at least 32 characters'),

    /**
     * Secret for the owner endpoints (documents, search). Only the backend's
     * owner proxy holds it, and it sends it only after checking the caller's
     * Supabase JWT against OWNER_AUTH_ID. Must differ from the service key, so
     * a leaked service key cannot change the knowledge base.
     */
    KNOWLEDGE_OWNER_KEY: z.string().min(32, 'KNOWLEDGE_OWNER_KEY must be at least 32 characters'),

    /**
     * The Supabase auth subject that owns the knowledge base. It becomes the
     * first segment of every storage key, so it must be a safe key segment
     * (a Supabase user id, a UUID, always is).
     */
    OWNER_AUTH_ID: z
      .string()
      .min(1, 'OWNER_AUTH_ID is required')
      .max(255, 'OWNER_AUTH_ID must be at most 255 characters')
      .refine(isSafeKeySegment, {
        message: 'OWNER_AUTH_ID may only contain letters, digits, ".", "_" and "-"',
      }),

    /**
     * `openai` (OpenAI directly) and `openrouter` call a real embedding model
     * through the same OpenAI-compatible API. `hashing` is a deterministic,
     * offline embedder for local development and tests: it ranks by shared
     * words, not by meaning.
     */
    EMBEDDER: z.enum(['openai', 'openrouter', 'hashing']).default('openai'),
    OPENAI_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    /** Overrides the provider's default model; it must output 1536 dimensions. */
    EMBEDDING_MODEL: z.string().min(1).optional(),

    /** Where raw uploaded files are kept. */
    FILE_STORE: z.enum(['supabase', 'local']).default('supabase'),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SECRET_KEY: z.string().optional(),
    STORAGE_BUCKET: z.string().default('portfolio-files'),
    LOCAL_FILE_STORE_DIR: z.string().default('.data/files'),

    /** Upload size limit in bytes (default 10 MB, at most 50 MB). */
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_UPLOAD_BYTES_CEILING, 'MAX_UPLOAD_BYTES must be at most 50 MB (52428800)')
      .default(10 * 1024 * 1024),

    /** Re-queue documents left pending or processing by a previous process. */
    RESUME_INGESTION_ON_BOOT: booleanish.default(true),
  })
  .transform((env, ctx) => {
    // Cross-field rules, checked once here. The result carries the embedder
    // and file-store settings as discriminated unions, so nothing downstream
    // has to re-check that the variables a mode needs are present.
    let embedder: EmbedderConfig | undefined;
    if (env.EMBEDDER === 'hashing') {
      if (env.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['EMBEDDER'],
          message: 'EMBEDDER=hashing is for development and tests only',
        });
      }
      embedder = { kind: 'hashing' };
    } else {
      const provider = EMBEDDING_PROVIDERS[env.EMBEDDER];
      const apiKey = env[provider.keyVariable];
      if (apiKey) {
        embedder = {
          kind: 'openai-compatible',
          provider: env.EMBEDDER,
          baseUrl: provider.baseUrl,
          apiKey,
          model: env.EMBEDDING_MODEL ?? provider.defaultModel,
        };
      } else {
        ctx.addIssue({
          code: 'custom',
          path: [provider.keyVariable],
          message: `${provider.keyVariable} is required when EMBEDDER=${env.EMBEDDER}`,
        });
      }
    }

    if (env.KNOWLEDGE_OWNER_KEY === env.KNOWLEDGE_SERVICE_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['KNOWLEDGE_OWNER_KEY'],
        message: 'KNOWLEDGE_OWNER_KEY must differ from KNOWLEDGE_SERVICE_KEY',
      });
    }

    let fileStore: FileStoreConfig | undefined;
    if (env.FILE_STORE === 'local') {
      fileStore = { kind: 'local', dir: env.LOCAL_FILE_STORE_DIR };
    } else {
      for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when FILE_STORE=supabase`,
          });
        }
      }
      if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) {
        fileStore = {
          kind: 'supabase',
          url: env.SUPABASE_URL,
          secretKey: env.SUPABASE_SECRET_KEY,
          bucket: env.STORAGE_BUCKET,
        };
      }
    }

    if (!embedder || !fileStore) return z.NEVER;
    return { ...env, embedder, fileStore };
  });

/** Providers with an OpenAI-compatible embeddings API. */
export const EMBEDDING_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyVariable: 'OPENAI_API_KEY',
    defaultModel: 'text-embedding-3-small',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyVariable: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/text-embedding-3-small',
  },
} as const;

export type EmbeddingProvider = keyof typeof EMBEDDING_PROVIDERS;

export type EmbedderConfig =
  | { kind: 'hashing' }
  | {
      kind: 'openai-compatible';
      provider: EmbeddingProvider;
      baseUrl: string;
      apiKey: string;
      model: string;
    };

export type FileStoreConfig =
  | { kind: 'local'; dir: string }
  | { kind: 'supabase'; url: string; secretKey: string; bucket: string };

export type Env = z.infer<typeof EnvSchema>;

/** Parses the environment, throwing one error that lists every problem. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid knowledge service configuration:\n${problems}`);
  }
  return result.data;
}
