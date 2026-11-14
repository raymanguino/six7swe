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

  /** Deletes the draft. False when there was none. */
  deleteDraft(ownerId: string): Promise<boolean>;

  /**
   * Atomically copies the draft over the published profile and deletes the
   * draft, provided the draft's `updatedAt` is still `expectedUpdatedAt`
   * (compared to the millisecond, the wire precision).
   */
  publishDraft(ownerId: string, expectedUpdatedAt: Date): Promise<PublishOutcome>;
}

/** Timestamps travel as ISO strings, so equality is checked at millisecond precision. */
export function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}
