import { z } from 'zod';
import { normalizeKnowledgeUrl } from './knowledgeUrl';

/**
 * Configuration for the knowledge owner proxy (`/knowledge/*`).
 *
 * The knowledge service is reachable only on Railway's private network, so
 * the browser never calls it. The backend checks that the signed-in user is
 * the owner (`OWNER_AUTH_ID`), then forwards the request to `KNOWLEDGE_URL`
 * with `KNOWLEDGE_OWNER_KEY`, the key the service accepts on its owner routes.
 *
 * Every variable is optional, so a backend without the knowledge service
 * still boots: without `OWNER_AUTH_ID` nobody is the owner (403), and without
 * the key the owner gets 503. `KNOWLEDGE_URL` alone leaves the proxy off, since
 * chat retrieval shares it. A malformed value, or the key without the URL, is
 * a deploy mistake and fails the boot.
 */

const knowledgeEnvSchema = z
  .object({
    OWNER_AUTH_ID: z.string().trim().min(1).optional(),
    KNOWLEDGE_URL: z
      .string()
      .refine((value) => normalizeKnowledgeUrl(value) !== null, {
        message: 'KNOWLEDGE_URL must be an http(s) URL without credentials, query or fragment',
      })
      .optional(),
    KNOWLEDGE_OWNER_KEY: z
      .string()
      .min(32, 'KNOWLEDGE_OWNER_KEY must be at least 32 characters')
      .optional(),
  })
  .superRefine((env, ctx) => {
    // A key with no address is a half-finished setup. The reverse is fine:
    // KNOWLEDGE_URL is shared with chat retrieval, which has its own key.
    if (env.KNOWLEDGE_OWNER_KEY && !env.KNOWLEDGE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['KNOWLEDGE_URL'],
        message: 'KNOWLEDGE_URL is required when KNOWLEDGE_OWNER_KEY is set',
      });
    }
  });

export interface KnowledgeProxyTarget {
  /** Base URL of the knowledge service, without a trailing slash. */
  url: string;
  /** Sent in the service's `x-knowledge-key` header on owner routes. */
  ownerKey: string;
}

export interface KnowledgeConfig {
  /** The Supabase auth subject (JWT `sub`) that owns the knowledge base; null when unset. */
  ownerAuthId: string | null;
  /** Where owner requests go; null when the URL or the key is unset. */
  target: KnowledgeProxyTarget | null;
}

/** `process.env`, or a plain object in tests. */
type EnvSource = Record<string, string | undefined>;

/** Empty strings count as unset, like a variable left blank in `.env`. */
function read(source: EnvSource, key: string): string | undefined {
  const value = source[key]?.trim();
  return value ? value : undefined;
}

/** Reads the proxy configuration. Throws one error listing every malformed value. */
export function loadKnowledgeConfig(source: EnvSource = process.env): KnowledgeConfig {
  const parsed = knowledgeEnvSchema.safeParse({
    OWNER_AUTH_ID: read(source, 'OWNER_AUTH_ID'),
    KNOWLEDGE_URL: read(source, 'KNOWLEDGE_URL'),
    KNOWLEDGE_OWNER_KEY: read(source, 'KNOWLEDGE_OWNER_KEY'),
  });
  if (!parsed.success) {
    // Names only, never values: these include a secret.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid knowledge proxy configuration: ${problems}`);
  }

  const env = parsed.data;
  return {
    ownerAuthId: env.OWNER_AUTH_ID ?? null,
    target:
      env.KNOWLEDGE_URL && env.KNOWLEDGE_OWNER_KEY
        ? {
            url: normalizeKnowledgeUrl(env.KNOWLEDGE_URL) ?? env.KNOWLEDGE_URL,
            ownerKey: env.KNOWLEDGE_OWNER_KEY,
          }
        : null,
  };
}
