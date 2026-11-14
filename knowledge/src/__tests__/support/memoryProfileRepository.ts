import { ProfileDataSchema, type ProfileStage } from '../../contract.js';
import {
  sameInstant,
  type ProfileRecord,
  type ProfileRepository,
} from '../../db/api/profileRepository.js';

/**
 * An in-memory ProfileRepository with the same observable behaviour as the
 * Drizzle one (both pass `profileRepositoryContract.ts`).
 */
export function createMemoryProfileRepository(): ProfileRepository & {
  rows: Map<string, ProfileRecord>;
} {
  const rows = new Map<string, ProfileRecord>();
  const key = (ownerId: string, stage: ProfileStage) => `${stage}\u0000${ownerId}`;
  // Strictly increasing, so two writes in one millisecond still differ, as
  // the database's microsecond clock almost always does.
  let last = 0;
  const now = () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last);
  };

  const upsert = (
    ownerId: string,
    stage: ProfileStage,
    record: Pick<ProfileRecord, 'data' | 'sourceDocumentId'>,
  ): ProfileRecord => {
    const existing = rows.get(key(ownerId, stage));
    const at = now();
    const saved: ProfileRecord = {
      ownerId,
      stage,
      data: ProfileDataSchema.parse(record.data),
      sourceDocumentId: record.sourceDocumentId,
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

    async saveDraft(ownerId, data, sourceDocumentId) {
      return upsert(ownerId, 'draft', { data, sourceDocumentId });
    },

    async deleteDraft(ownerId) {
      return rows.delete(key(ownerId, 'draft'));
    },

    async publishDraft(ownerId, expectedUpdatedAt) {
      const draft = rows.get(key(ownerId, 'draft'));
      if (!draft) return { status: 'no-draft' };
      if (!sameInstant(draft.updatedAt, expectedUpdatedAt)) return { status: 'stale', draft };
      const profile = upsert(ownerId, 'published', draft);
      rows.delete(key(ownerId, 'draft'));
      return { status: 'published', profile };
    },
  };
}
