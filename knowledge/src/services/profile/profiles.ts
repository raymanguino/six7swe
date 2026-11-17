import type { FastifyBaseLogger } from 'fastify';
import type { DraftingStatus, ProfileData } from '../../contract.js';
import type { DocumentRecord, KnowledgeRepository } from '../../db/api/repository.js';
import type { ProfileRecord, ProfileRepository } from '../../db/api/profileRepository.js';
import { SerialQueue } from '../ingestion/queue.js';
import type { FileStore } from '../storage/index.js';
import { DraftError, type ProfileDrafter } from './drafter.js';

/**
 * The structured profile (#86): when a resume becomes primary, the drafter
 * writes a new draft profile from its extracted text. The owner reviews it
 * against the published profile, edits it, and publishes it.
 *
 * Drafting runs on its own serial queue, apart from ingestion, so a slow model
 * never holds up the next upload. It is not durable: a draft cut off by a
 * restart is simply not written, and the owner can ask for another one. Its
 * status is kept in memory for the same reason.
 */

const PDF_MIME = 'application/pdf';

export interface ProfileDraftingDeps {
  repo: Pick<KnowledgeRepository, 'getDocument' | 'getPrimaryResume' | 'getExtractedText'>;
  profiles: ProfileRepository;
  /** Null when no drafting model is configured; drafting is then off. */
  drafter: ProfileDrafter | null;
  log: FastifyBaseLogger;
}

const GENERIC_FAILURE = 'Drafting failed unexpectedly. Try again.';
/** The drafter found the draft edited by the owner while it ran, and kept the edits. */
export const DRAFT_KEPT_EDITS =
  'The draft was edited while a new one was being written, so your edits were kept. ' +
  'Redraft to replace them with a fresh draft from the resume.';

/** Thrown by `request` when no drafting model is configured. Maps to 409. */
export class DraftingDisabledError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('Profile drafting is not configured on the knowledge service (PROFILE_DRAFTER).');
    this.name = 'DraftingDisabledError';
  }
}

export interface ProfileDrafting {
  /** The owner's last drafting attempt. */
  status(ownerId: string): DraftingStatus;
  /**
   * Queues a draft from the owner's primary resume, unless one is already
   * waiting. Throws `DraftingDisabledError` when drafting is off.
   */
  request(ownerId: string): DraftingStatus;
  /**
   * Called after a resume's ingest commits. A resume that is primary now gets
   * a fresh draft. One that is not (an older resume re-ingested) would only
   * redraft from the unchanged primary, overwriting the owner's edits for
   * nothing, so it is ignored. A no-op when drafting is off.
   */
  resumeIngested(doc: Pick<DocumentRecord, 'ownerId' | 'id'>): Promise<void>;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
  /** Drops queued drafts and waits for the running one. */
  stop(): Promise<number>;
}

export function createProfileDrafting(deps: ProfileDraftingDeps): ProfileDrafting {
  const { drafter, log } = deps;
  const statuses = new Map<string, Omit<DraftingStatus, 'enabled'>>();
  const IDLE = { state: 'idle', documentId: null, error: null } as const;
  const DRAFTING = { state: 'drafting', documentId: null, error: null } as const;

  // One job per owner: asking again while one waits is a no-op.
  const queue = new SerialQueue<{ id: string }>(
    ({ id }) => draft(id),
    // draft() handles its own failures; this only fires on a bug.
    ({ id }, error) => {
      log.error({ ownerId: id, err: error }, 'Profile drafting crashed');
      settle(id, { state: 'failed', documentId: null, error: GENERIC_FAILURE });
    },
  );

  const status = (ownerId: string): DraftingStatus => ({
    enabled: drafter !== null,
    ...(statuses.get(ownerId) ?? IDLE),
  });

  /**
   * Records how a job ended, unless another job for the owner is already
   * waiting: then the status stays `drafting`, so the review screen keeps
   * following it instead of showing a draft about to be replaced.
   */
  function settle(ownerId: string, outcome: Omit<DraftingStatus, 'enabled'>): void {
    statuses.set(ownerId, queue.isWaiting(ownerId) ? DRAFTING : outcome);
  }

  async function draft(ownerId: string): Promise<void> {
    if (!drafter) return;
    let documentId: string | null = null;
    try {
      // What the draft was when this job started: the owner's edits saved
      // while the model runs must not be overwritten.
      const before = (await deps.profiles.getProfiles(ownerId)).draft?.version ?? null;

      const resume = await deps.repo.getPrimaryResume(ownerId);
      if (!resume) throw new DraftError('There is no primary resume to draft from.');
      documentId = resume.id;
      statuses.set(ownerId, { state: 'drafting', documentId, error: null });

      const found = await deps.repo.getExtractedText(ownerId, resume.id);
      if (!found?.text) {
        throw new DraftError('The primary resume has no extracted text yet.');
      }

      const started = Date.now();
      const data = await drafter.draft(found.text);
      const saved = await deps.profiles.saveDraftIfUnchanged(ownerId, data, resume.id, before);
      if (!saved) {
        log.info({ documentId }, 'Draft edited while drafting; kept the edits');
        settle(ownerId, { state: 'failed', documentId, error: DRAFT_KEPT_EDITS });
        return;
      }
      settle(ownerId, { state: 'idle', documentId, error: null });
      log.info({ documentId, drafter: drafter.name, ms: Date.now() - started }, 'Profile drafted');
    } catch (error) {
      const detail = error instanceof DraftError ? error.detail : undefined;
      log.warn({ documentId, err: error, detail }, 'Profile drafting failed');
      settle(ownerId, {
        state: 'failed',
        documentId,
        error: error instanceof DraftError ? error.message : GENERIC_FAILURE,
      });
    }
  }

  return {
    status,
    request(ownerId) {
      if (!drafter) throw new DraftingDisabledError();
      if (queue.enqueue({ id: ownerId })) statuses.set(ownerId, DRAFTING);
      return status(ownerId);
    },
    async resumeIngested(doc) {
      if (!drafter) return;
      const current = await deps.repo.getDocument(doc.ownerId, doc.id);
      if (!current?.isPrimaryResume) return;
      if (queue.enqueue({ id: doc.ownerId })) statuses.set(doc.ownerId, DRAFTING);
    },
    idle: () => queue.idle(),
    stop: () => queue.stop(),
  };
}

/**
 * Saves the owner's edits as the draft. The draft keeps the resume it came
 * from; a draft started from the published profile keeps that one's.
 */
export async function saveOwnerDraft(
  deps: { profiles: ProfileRepository },
  ownerId: string,
  data: ProfileData,
): Promise<ProfileRecord> {
  const { draft, published } = await deps.profiles.getProfiles(ownerId);
  const source = (draft ?? published)?.sourceDocumentId ?? null;
  return deps.profiles.saveDraft(ownerId, data, source);
}

export interface PublishedView {
  profile: ProfileRecord | null;
  resume: { document: DocumentRecord; text: string | null } | null;
}

/** What the public portfolio shows: the published profile and the primary resume. */
export async function getPublishedView(
  deps: {
    repo: Pick<KnowledgeRepository, 'getDocument' | 'getPrimaryResume' | 'getExtractedText'>;
    profiles: ProfileRepository;
  },
  ownerId: string,
): Promise<PublishedView> {
  const [profile, document] = await Promise.all([
    deps.profiles.getPublished(ownerId),
    deps.repo.getPrimaryResume(ownerId),
  ]);
  if (!document) return { profile, resume: null };
  const found = await deps.repo.getExtractedText(ownerId, document.id);
  return { profile, resume: { document, text: found?.text ?? null } };
}

export const isPdf = (document: DocumentRecord): boolean => document.mimeType === PDF_MIME;

/** What `findPrimaryResumePdf` found: the bytes, nothing, or a file over `maxBytes`. */
export type ResumePdfResult =
  | { status: 'ok'; bytes: Uint8Array }
  | { status: 'none' }
  | { status: 'too-large'; sizeBytes: number };

/**
 * The primary resume's file when it is a PDF. With `maxBytes`, the stored size
 * is checked before the file is fetched.
 */
export async function findPrimaryResumePdf(
  deps: { repo: Pick<KnowledgeRepository, 'getPrimaryResume'>; files: FileStore },
  ownerId: string,
  maxBytes?: number,
): Promise<ResumePdfResult> {
  const resume = await deps.repo.getPrimaryResume(ownerId);
  if (!resume || !isPdf(resume)) return { status: 'none' };
  if (maxBytes !== undefined && resume.sizeBytes > maxBytes) {
    return { status: 'too-large', sizeBytes: resume.sizeBytes };
  }
  return { status: 'ok', bytes: await deps.files.get(resume.storagePath) };
}

/** The primary resume's file, when it is a PDF; null otherwise. */
export async function getPrimaryResumePdf(
  deps: { repo: Pick<KnowledgeRepository, 'getPrimaryResume'>; files: FileStore },
  ownerId: string,
): Promise<Uint8Array | null> {
  const found = await findPrimaryResumePdf(deps, ownerId);
  return found.status === 'ok' ? found.bytes : null;
}
