import type { ProfileData, ProfileStage } from '../../contract.js';

/**
 * Persistence for the structured profile (#86). Kept apart from the document
 * repository: profiles have their own lifecycle (draft, review, publish) and
 * never touch the corpus version.
 */

export interface ProfileRecord {
  ownerId: string;
  stage: ProfileStage;
  data: ProfileData;
  sourceDocumentId: string | null;
  /** See `ProfileDtoSchema.version`; the checks below compare it, not `updatedAt`. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfilePair {
  draft: ProfileRecord | null;
  published: ProfileRecord | null;
}

/** Why a publish did not happen. */
export type PublishOutcome =
  | { status: 'published'; profile: ProfileRecord }
  /** There is no draft to publish. */
  | { status: 'no-draft' }
  /** The draft changed after the owner reviewed it. */
  | { status: 'stale'; draft: ProfileRecord };

/** Why an owner's save did not happen. */
export type OwnerSaveOutcome =
  | { status: 'saved'; profile: ProfileRecord }
  /** The draft is not the one the owner opened; `draft` is the current one (null: none). */
  | { status: 'stale'; draft: ProfileRecord | null };

export interface ProfileRepository {
  getProfiles(ownerId: string): Promise<ProfilePair>;

  getPublished(ownerId: string): Promise<ProfileRecord | null>;

  /**
   * Creates or replaces the owner's draft. `sourceDocumentId` is the resume
   * it was drafted from, or null for a profile the owner wrote.
   */
  saveDraft(
    ownerId: string,
    data: ProfileData,
    sourceDocumentId: string | null,
  ): Promise<ProfileRecord>;

  /**
   * `saveDraft` for the drafter, which must not overwrite the owner's edits
   * made while it ran: writes only if the draft's `version` is still
   * `expectedVersion` (null: there was no draft), or the draft has since
   * been discarded. Returns null, writing nothing, when the draft changed.
   */
  saveDraftIfUnchanged(
    ownerId: string,
    data: ProfileData,
    sourceDocumentId: string | null,
    expectedVersion: number | null,
  ): Promise<ProfileRecord | null>;

  /**
   * Saves the owner's edits as the draft. The draft keeps the resume it was
   * drafted from; a new draft takes the published profile's (null when there
   * is none). The source is read by the write itself, never beforehand, so a
   * concurrent redraft cannot credit the draft to the wrong resume.
   *
   * With `expectedVersion` (null: there must be no draft), writes only if the
   * draft's `version` is still that, and otherwise returns `stale` with the
   * current draft, writing nothing. Undefined: the save is unconditional.
   */
  saveOwnerDraft(
    ownerId: string,
    data: ProfileData,
    expectedVersion?: number | null,
  ): Promise<OwnerSaveOutcome>;

  /** Deletes the draft. False when there was none. */
  deleteDraft(ownerId: string): Promise<boolean>;

  /**
   * Atomically copies the draft over the published profile and deletes the
   * draft, provided the draft's `version` is still `expectedVersion`.
   */
  publishDraft(ownerId: string, expectedVersion: number): Promise<PublishOutcome>;
}
