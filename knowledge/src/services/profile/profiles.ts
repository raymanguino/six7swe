import type { FastifyBaseLogger } from 'fastify';
import type { DraftingStatus } from '../../contract.js';
import type { DocumentRecord, KnowledgeRepository } from '../../db/api/repository.js';
import type { ProfileRepository } from '../../db/api/profileRepository.js';
import { SerialQueue } from '../ingestion/queue.js';
import { DraftError, type ProfileDrafter } from './drafter.js';

/**
 * Profile drafting (#86): when a resume becomes primary, the drafter writes a
 * new draft profile from its extracted text. The owner reviews it against the
 * published profile, edits it, and publishes it.
 *
 * Drafting runs on its own serial queue, apart from ingestion, so a slow model
 * never holds up the next upload. It is not durable: a draft cut off by a
 * restart is simply not written, and the owner can ask for another one. Its
 * status is kept in memory for the same reason.
 */

export interface ProfileDraftingDeps {
  repo: Pick<KnowledgeRepository, 'listDocuments' | 'getExtractedText'>;
  profiles: ProfileRepository;
  /** Null when no drafting model is configured; drafting is then off. */
  drafter: ProfileDrafter | null;
  log: FastifyBaseLogger;
}

const GENERIC_FAILURE = 'Drafting failed unexpectedly. Try again.';

/** Thrown by `request` when no drafting model is configured. Maps to 409. */
export class DraftingDisabledError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('Profile drafting is not configured on the knowledge service (PROFILE_DRAFTER).');
    this.name = 'DraftingDisabledError';
  }
}

/**
 * The owner's primary resume, whatever its status: a primary whose re-ingest
 * failed stays primary, and its file and last extracted text are still good.
 */
export async function findPrimaryResume(
  repo: Pick<KnowledgeRepository, 'listDocuments'>,
  ownerId: string,
): Promise<DocumentRecord | null> {
  const documents = await repo.listDocuments(ownerId);
  return documents.find((d) => d.kind === 'resume' && d.isPrimaryResume) ?? null;
}

export interface ProfileDrafting {
  /** The owner's last drafting attempt. */
  status(ownerId: string): DraftingStatus;
  /**
   * Queues a draft from the owner's primary resume, unless one is already
   * waiting. Throws `DraftingDisabledError` when drafting is off.
   */
  request(ownerId: string): DraftingStatus;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
  /** Drops queued drafts and waits for the running one. */
  stop(): Promise<number>;
}

export function createProfileDrafting(deps: ProfileDraftingDeps): ProfileDrafting {
  const { drafter, log } = deps;
  const statuses = new Map<string, Omit<DraftingStatus, 'enabled'>>();
  const IDLE = { state: 'idle', documentId: null, error: null } as const;

  const status = (ownerId: string): DraftingStatus => ({
    enabled: drafter !== null,
    ...(statuses.get(ownerId) ?? IDLE),
  });

  async function draft(ownerId: string): Promise<void> {
    if (!drafter) return;
    let documentId: string | null = null;
    try {
      const resume = await findPrimaryResume(deps.repo, ownerId);
      if (!resume) throw new DraftError('There is no primary resume to draft from.');
      documentId = resume.id;
      statuses.set(ownerId, { state: 'drafting', documentId, error: null });

      const found = await deps.repo.getExtractedText(ownerId, resume.id);
      if (!found?.text) {
        throw new DraftError('The primary resume has no extracted text yet.');
      }

      const started = Date.now();
      const data = await drafter.draft(found.text);
      await deps.profiles.saveDraft(ownerId, data, resume.id);
      statuses.set(ownerId, { state: 'idle', documentId, error: null });
      log.info({ documentId, drafter: drafter.name, ms: Date.now() - started }, 'Profile drafted');
    } catch (error) {
      const detail = error instanceof DraftError ? error.detail : undefined;
      log.warn({ documentId, err: error, detail }, 'Profile drafting failed');
      statuses.set(ownerId, {
        state: 'failed',
        documentId,
        error: error instanceof DraftError ? error.message : GENERIC_FAILURE,
      });
    }
  }

  // One job per owner: asking again while one waits is a no-op.
  const queue = new SerialQueue<{ id: string }>(
    ({ id }) => draft(id),
    // draft() handles its own failures; this only fires on a bug.
    ({ id }, error) => log.error({ ownerId: id, err: error }, 'Profile drafting crashed'),
  );

  return {
    status,
    request(ownerId) {
      if (!drafter) throw new DraftingDisabledError();
      if (queue.enqueue({ id: ownerId })) {
        statuses.set(ownerId, { state: 'drafting', documentId: null, error: null });
      }
      return status(ownerId);
    },
    idle: () => queue.idle(),
    stop: () => queue.stop(),
  };
}
