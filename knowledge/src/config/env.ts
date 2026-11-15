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
     * Bearer token for the MCP adapter (#89), held by your own Claude
     * clients. A key of its own, so the owner key never leaves the backend.
     * Unset (or empty) disables `/mcp`: every request gets 401.
     */
    KNOWLEDGE_MCP_KEY: z
      .string()
      .optional()
      .transform((v) => (v === '' ? undefined : v))
      .pipe(z.string().min(32, 'KNOWLEDGE_MCP_KEY must be at least 32 characters').optional()),

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

    /**
     * The chat model that drafts the structured profile from the primary
     * resume (#86). `minimax` is MiniMax, the app's LLM provider (the
     * backend's chat uses it too). `stub` is a deterministic, offline drafter
     * for development and tests. `none` (the default) turns drafting off; the
     * owner can still write and publish a profile by hand. Drafting has its
     * own providers (`DRAFT_PROVIDERS`), apart from the embedders.
     */
    PROFILE_DRAFTER: z.enum(['none', 'minimax', 'stub']).default('none'),
    /** Overrides the provider's default drafting model. */
    PROFILE_DRAFT_MODEL: z.string().min(1).optional(),
    MINIMAX_API_KEY: z.string().optional(),
    /** Optional: tried once when MiniMax answers 429 to the primary key. */
    MINIMAX_API_KEY_SECONDARY: z.string().optional(),

    /**
     * The chat model that answers each question in an eval run (#85), from
     * the chunks retrieved for it. `none` (the default) records retrieval
     * only; `stub` is offline and deterministic. Uses the drafter's MiniMax
     * keys.
     */
    EVAL_ANSWERER: z.enum(['none', 'minimax', 'stub']).default('none'),
    /** Overrides the provider's default answering model. */
    EVAL_ANSWER_MODEL: z.string().min(1).optional(),
    /**
     * Eval thresholds that depend on the embedder (cosine similarity). An
     * active question whose best chunk is below the gap threshold is flagged
     * as a knowledge gap; a new visitor question below the off-topic one is
     * flagged off-topic (never suggested to the owner for promotion). The
     * defaults suit text-embedding-3-small.
     */
    EVAL_GAP_SIMILARITY: z.coerce.number().min(-1).max(1).optional(),
    EVAL_OFF_TOPIC_SIMILARITY: z.coerce.number().min(-1).max(1).optional(),

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

    if (env.KNOWLEDGE_MCP_KEY !== undefined) {
      for (const other of ['KNOWLEDGE_SERVICE_KEY', 'KNOWLEDGE_OWNER_KEY'] as const) {
        if (env.KNOWLEDGE_MCP_KEY === env[other]) {
          ctx.addIssue({
            code: 'custom',
            path: ['KNOWLEDGE_MCP_KEY'],
            message: `KNOWLEDGE_MCP_KEY must differ from ${other}`,
          });
        }
      }
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

    /** The drafter and the eval answerer pick a chat model the same way. */
    const chatModel = (
      variable: 'PROFILE_DRAFTER' | 'EVAL_ANSWERER',
      modelOverride: string | undefined,
    ): ChatModelConfig | undefined => {
      const kind = env[variable];
      if (kind === 'none') return { kind: 'none' };
      if (kind === 'stub') {
        if (env.NODE_ENV === 'production') {
          ctx.addIssue({
            code: 'custom',
            path: [variable],
            message: `${variable}=stub is for development and tests only`,
          });
        }
        return { kind: 'stub' };
      }
      const provider = DRAFT_PROVIDERS[kind];
      const apiKey = env[provider.keyVariable];
      if (!apiKey) {
        ctx.addIssue({
          code: 'custom',
          path: [provider.keyVariable],
          message: `${provider.keyVariable} is required when ${variable}=${kind}`,
        });
        return undefined;
      }
      return {
        kind: 'minimax',
        url: provider.url,
        apiKey,
        secondaryApiKey: env[provider.secondaryKeyVariable] || undefined,
        model: modelOverride ?? provider.defaultModel,
      };
    };
    const profileDrafter = chatModel('PROFILE_DRAFTER', env.PROFILE_DRAFT_MODEL);
    const evalAnswerer = chatModel('EVAL_ANSWERER', env.EVAL_ANSWER_MODEL);

    if (!embedder || !fileStore || !profileDrafter || !evalAnswerer) return z.NEVER;
    return { ...env, embedder, fileStore, profileDrafter, evalAnswerer };
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

/**
 * Providers that draft the profile (#86), kept apart from the embedders so a
 * drafting provider can never be picked as an EMBEDDER. MiniMax's chat
 * completions API is the one the backend's chat uses
 * (`backend/src/services/minimaxService.ts`).
 */
export const DRAFT_PROVIDERS = {
  minimax: {
    label: 'MiniMax',
    url: 'https://api.minimax.io/v1/chat/completions',
    keyVariable: 'MINIMAX_API_KEY',
    secondaryKeyVariable: 'MINIMAX_API_KEY_SECONDARY',
    defaultModel: 'MiniMax-M3',
  },
} as const;

export type EmbedderConfig =
  | { kind: 'hashing' }
  | {
      kind: 'openai-compatible';
      provider: EmbeddingProvider;
      baseUrl: string;
      apiKey: string;
      model: string;
    };

/** The profile drafter (#86) and the eval answerer (#85) share the chat model providers. */
export type ProfileDrafterConfig = ChatModelConfig;
export type EvalAnswererConfig = ChatModelConfig;

export type ChatModelConfig =
  | { kind: 'none' }
  | { kind: 'stub' }
  | {
      kind: 'minimax';
      /** The chat completions endpoint. */
      url: string;
      apiKey: string;
      /** Tried once when the primary key gets a 429. */
      secondaryApiKey?: string;
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
