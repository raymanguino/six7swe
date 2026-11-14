import { z } from 'zod';

/**
 * The knowledge service's wire contract, shared by the service
 * (`knowledge/`) and its callers (the backend).
 *
 * It is a leaf module: it depends on zod and nothing else, so it pulls neither
 * side's database or service layers along. The service's database enums are
 * derived from the arrays below, not the other way around.
 *
 * Both callers read the compiled `dist/`, which `pnpm install` does not
 * build. Every script that needs it builds it first: the backend's and the
 * service's `build`, `test` and `typecheck`/`chat:eval` scripts, and the root
 * `lint` and `dev` scripts. Anything else (an editor's type checking, a
 * one-off `tsx` run) needs `pnpm build:types` after a change here.
 */

/** Header that carries the shared service key. Never accepted in a query string. */
export const SERVICE_KEY_HEADER = 'x-knowledge-key';

export const MAX_RETRIEVE_K = 20;
/** The longest `/retrieve` query, after trimming. */
export const MAX_RETRIEVE_QUERY_CHARS = 2000;
export const DEFAULT_RETRIEVE_K = 6;

export const DOCUMENT_KINDS = ['resume', 'supporting'] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const DOCUMENT_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const RetrieveRequestSchema = z.object({
  query: z.string().trim().min(1).max(MAX_RETRIEVE_QUERY_CHARS),
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

/** `GET /documents`: the owner's documents, newest first. */
export const DocumentListResponseSchema = z.object({
  documents: z.array(DocumentDtoSchema),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

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

export const VersionResponseSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

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

/*
 * The structured profile (#86): the landing page's name, title, summary,
 * skills, experience, projects and links. An LLM drafts it from the primary
 * resume; the owner reviews, edits and publishes it. The backend maps the
 * published one to its `PortfolioData`.
 */

export const PROFILE_STAGES = ['draft', 'published'] as const;
export const ProfileStageSchema = z.enum(PROFILE_STAGES);
export type ProfileStage = z.infer<typeof ProfileStageSchema>;

/** Bounds that keep a profile page-sized; a model that rambles fails validation instead. */
export const PROFILE_LIMITS = {
  shortText: 200,
  longText: 4000,
  skills: 100,
  entries: 30,
  technologies: 30,
  link: 500,
  email: 254,
  phone: 50,
} as const;

const shortText = z.string().trim().min(1).max(PROFILE_LIMITS.shortText);
const optionalShortText = z.string().trim().max(PROFILE_LIMITS.shortText);
const longText = z.string().trim().max(PROFILE_LIMITS.longText);
/**
 * Links become `href`s on the public site, so only http(s) is accepted: a
 * `javascript:` URL from a hallucinating model or a typo must never reach a
 * visitor.
 */
const httpLink = z.httpUrl().max(PROFILE_LIMITS.link).nullable();

export const ProfileExperienceSchema = z.strictObject({
  title: shortText,
  company: shortText,
  /** Free text, e.g. "2021 - 2024"; may be empty. */
  period: optionalShortText,
  description: longText,
});
export type ProfileExperience = z.infer<typeof ProfileExperienceSchema>;

export const ProfileProjectSchema = z.strictObject({
  name: shortText,
  description: longText,
  technologies: z.array(shortText).max(PROFILE_LIMITS.technologies),
});
export type ProfileProject = z.infer<typeof ProfileProjectSchema>;

/** How to reach the owner. `email` is also where the portfolio's contact form delivers. */
export const ProfileLinksSchema = z.strictObject({
  email: z.email().max(PROFILE_LIMITS.email).nullable(),
  phone: z.string().trim().min(1).max(PROFILE_LIMITS.phone).nullable(),
  linkedin: httpLink,
  github: httpLink,
  website: httpLink,
});
export type ProfileLinks = z.infer<typeof ProfileLinksSchema>;

/** The editable content of a profile, the same for a draft and a published one. */
export const ProfileDataSchema = z.strictObject({
  name: shortText,
  title: shortText,
  location: z.string().trim().min(1).max(PROFILE_LIMITS.shortText).nullable(),
  summary: longText,
  skills: z.array(shortText).max(PROFILE_LIMITS.skills),
  experience: z.array(ProfileExperienceSchema).max(PROFILE_LIMITS.entries),
  projects: z.array(ProfileProjectSchema).max(PROFILE_LIMITS.entries),
  links: ProfileLinksSchema,
});
export type ProfileData = z.infer<typeof ProfileDataSchema>;

export const ProfileDtoSchema = z.object({
  stage: ProfileStageSchema,
  data: ProfileDataSchema,
  /** The resume it was drafted from; null when the owner wrote it or that resume is gone. */
  sourceDocumentId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProfileDto = z.infer<typeof ProfileDtoSchema>;

export const DRAFTING_STATES = ['idle', 'drafting', 'failed'] as const;

/**
 * The last drafting attempt. The service keeps it in memory, so a restart
 * forgets it. `enabled` is false when no drafting model is configured.
 */
export const DraftingStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(DRAFTING_STATES),
  /** The resume being, or last, drafted from. */
  documentId: z.uuid().nullable(),
  /** A short, user-facing reason when `state` is `failed`. */
  error: z.string().nullable(),
});
export type DraftingStatus = z.infer<typeof DraftingStatusSchema>;

/** `GET /profile` (owner): both stages and the drafting status, for the review screen. */
export const ProfileStateResponseSchema = z.object({
  draft: ProfileDtoSchema.nullable(),
  published: ProfileDtoSchema.nullable(),
  drafting: DraftingStatusSchema,
});
export type ProfileStateResponse = z.infer<typeof ProfileStateResponseSchema>;

/** `PUT /profile/draft` (owner): replaces the draft with the owner's edits. */
export const SaveDraftRequestSchema = z.strictObject({ data: ProfileDataSchema });
export type SaveDraftRequest = z.infer<typeof SaveDraftRequestSchema>;

/**
 * `POST /profile/publish` (owner). `draftUpdatedAt` is the draft the owner
 * reviewed: if the draft changed since (a new resume re-drafted it), the
 * service answers 409 rather than publish something the owner has not seen.
 */
export const PublishRequestSchema = z.strictObject({ draftUpdatedAt: z.iso.datetime() });
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** `PUT /profile/draft` and `POST /profile/publish`: the stage that was written. */
export const ProfileResponseSchema = z.object({ profile: ProfileDtoSchema });
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

/** `POST /profile/draft` (owner): re-drafts from the primary resume, in the background. */
export const DraftAcceptedResponseSchema = z.object({ drafting: DraftingStatusSchema });
export type DraftAcceptedResponse = z.infer<typeof DraftAcceptedResponseSchema>;

/** The primary resume, as the public portfolio needs it. */
export const PrimaryResumeDtoSchema = z.object({
  documentId: z.uuid(),
  filename: z.string(),
  mimeType: z.string(),
  /** True when `GET /resume.pdf` serves it. */
  isPdf: z.boolean(),
  /** The extracted text; null until an ingest has extracted it. */
  text: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type PrimaryResumeDto = z.infer<typeof PrimaryResumeDtoSchema>;

/**
 * `GET /profile/published` (service): what the public portfolio shows. Each
 * part is null when the owner has not published a profile, or has no ready
 * resume.
 */
export const PublishedProfileResponseSchema = z.object({
  profile: ProfileDtoSchema.nullable(),
  resume: PrimaryResumeDtoSchema.nullable(),
});
export type PublishedProfileResponse = z.infer<typeof PublishedProfileResponseSchema>;
