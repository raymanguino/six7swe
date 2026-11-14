import { z } from 'zod';

/**
 * The service's wire contract. When the backends start calling this service,
 * this file moves to `packages/knowledge-types` so both sides share one
 * definition.
 *
 * It is a leaf module: it depends on zod and nothing else, so it can move
 * without dragging the database or service layers along. The database enums
 * are derived from the arrays below, not the other way around.
 */

/** Header that carries the shared service key. Never accepted in a query string. */
export const SERVICE_KEY_HEADER = 'x-knowledge-key';

export const MAX_RETRIEVE_K = 20;
export const DEFAULT_RETRIEVE_K = 6;

export const DOCUMENT_KINDS = ['resume', 'supporting'] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const DOCUMENT_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const RetrieveRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  k: z.number().int().min(1).max(MAX_RETRIEVE_K).default(DEFAULT_RETRIEVE_K),
});
export type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;

export const UploadQuerySchema = z.object({
  kind: DocumentKindSchema.default('supporting'),
});

export const DocumentParamsSchema = z.object({ id: z.uuid() });

export const DocumentDtoSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  kind: DocumentKindSchema,
  /** The newest ready resume; set when its ingest completes, not on upload. */
  isPrimaryResume: z.boolean(),
  status: DocumentStatusSchema,
  /** A short, user-facing reason. Provider and parser details stay in the logs. */
  error: z.string().nullable(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentDto = z.infer<typeof DocumentDtoSchema>;

export const UploadResponseSchema = z.object({
  document: DocumentDtoSchema,
  deduplicated: z.boolean(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export const RetrievedChunkDtoSchema = z.object({
  chunkId: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  heading: z.string().nullable(),
  content: z.string(),
  similarity: z.number(),
});
export type RetrievedChunkDto = z.infer<typeof RetrievedChunkDtoSchema>;

export const RetrieveResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  chunks: z.array(RetrievedChunkDtoSchema),
});
export type RetrieveResponse = z.infer<typeof RetrieveResponseSchema>;

/** The body of every 4xx/5xx response. `issues` is set for validation errors only. */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  issues: z.array(z.unknown()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** `GET /documents/:id/text`. `text` is null until an ingest has extracted it. */
export const DocumentTextResponseSchema = z.object({
  documentId: z.uuid(),
  text: z.string().nullable(),
});
export type DocumentTextResponse = z.infer<typeof DocumentTextResponseSchema>;
