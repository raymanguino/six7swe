import { ProfileDataSchema, type ProfileStage } from '../../contract.js';
import type { ProfileRecord, ProfileRepository } from '../../db/api/profileRepository.js';

/**
 * An in-memory ProfileRepository with the same observable behaviour as the
 * Drizzle one (both pass `profileRepositoryContract.ts`).
 */
export function createMemoryProfileRepository(): ProfileRepository & {
  rows: Map<string, ProfileRecord>;
} {
  const rows = new Map<string, ProfileRecord>();
  const key = (ownerId: string, stage: ProfileStage) => `${stage}\u0000${ownerId}`;
  // One counter for every row, like the database's `profile_version_seq`.
  let lastVersion = 0;

  const upsert = (
    ownerId: string,
    stage: ProfileStage,
    record: Pick<ProfileRecord, 'data' | 'sourceDocumentId'>,
  ): ProfileRecord => {
    const existing = rows.get(key(ownerId, stage));
    // The real clock, so two writes may share a millisecond as they can in
    // the database: the checks must rely on `version` alone.
    const at = new Date();
    const saved: ProfileRecord = {
      ownerId,
      stage,
      data: ProfileDataSchema.parse(record.data),
      sourceDocumentId: record.sourceDocumentId,
      version: ++lastVersion,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    rows.set(key(ownerId, stage), saved);
    return saved;
  };

  return {
    rows,

    async getProfiles(ownerId) {
      return {
        draft: rows.get(key(ownerId, 'draft')) ?? null,
        published: rows.get(key(ownerId, 'published')) ?? null,
      };
    },

    async getPublished(ownerId) {
      return rows.get(key(ownerId, 'published')) ?? null;
    },

    // Both writes validate before the version check, as the Drizzle ones do.
    async saveDraftIfUnchanged(ownerId, data, sourceDocumentId, expectedVersion) {
      ProfileDataSchema.parse(data);
      const current = rows.get(key(ownerId, 'draft'));
      if (current && current.version !== expectedVersion) return null;
      return upsert(ownerId, 'draft', { data, sourceDocumentId });
    },

    async saveOwnerDraft(ownerId, data, expectedVersion) {
      ProfileDataSchema.parse(data);
      const current = rows.get(key(ownerId, 'draft')) ?? null;
      if (expectedVersion !== undefined && (current?.version ?? null) !== expectedVersion) {
        return { status: 'stale', draft: current };
      }
      const source = (current ?? rows.get(key(ownerId, 'published')))?.sourceDocumentId ?? null;
      return {
        status: 'saved',
        profile: upsert(ownerId, 'draft', { data, sourceDocumentId: source }),
      };
    },

    async deleteDraft(ownerId) {
      return rows.delete(key(ownerId, 'draft'));
    },

    async publishDraft(ownerId, expectedVersion) {
      const draft = rows.get(key(ownerId, 'draft'));
      if (!draft) return { status: 'no-draft' };
      if (draft.version !== expectedVersion) return { status: 'stale', draft };
      const profile = upsert(ownerId, 'published', draft);
      rows.delete(key(ownerId, 'draft'));
      return { status: 'published', profile };
    },
  };
}
