import { z } from 'zod';
import { isSafeKeySegment } from '../services/storage/keys.js';

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
    HOST: z.string().default('0.0.0.0'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /**
     * Shared secret for service-to-service calls (the portfolio and hunter
     * backends) and, until the owner JWT gate lands, for the owner endpoints.
     */
    KNOWLEDGE_SERVICE_KEY: z
      .string()
      .min(32, 'KNOWLEDGE_SERVICE_KEY must be at least 32 characters'),

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
     * `openrouter` calls a real embedding model. `hashing` is a deterministic,
     * offline embedder for local development and tests: it ranks by shared
     * words, not by meaning.
     */
    EMBEDDER: z.enum(['openrouter', 'hashing']).default('openrouter'),
    OPENROUTER_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),

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
  .superRefine((env, ctx) => {
    if (env.EMBEDDER === 'openrouter' && !env.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENROUTER_API_KEY'],
        message: 'OPENROUTER_API_KEY is required when EMBEDDER=openrouter',
      });
    }
    if (env.EMBEDDER === 'hashing' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDER'],
        message: 'EMBEDDER=hashing is for development and tests only',
      });
    }
    if (env.FILE_STORE === 'supabase') {
      for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when FILE_STORE=supabase`,
          });
        }
      }
    }
  });

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
