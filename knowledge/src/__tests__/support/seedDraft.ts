import type { ProfileData } from '../../contract.js';
import type { ProfileRecord, ProfileRepository } from '../../db/api/profileRepository.js';

/**
 * Test-only: writes the owner's draft as the drafter would, over whatever
 * draft is there now, and returns it. The repository has no unchecked write,
 * so this reads the current version and saves over it. It throws if another
 * draft write lands in between (a publish or discard in between is fine: the
 * draft is then simply written).
 */
export async function seedDraft(
  profiles: ProfileRepository,
  ownerId: string,
  data: ProfileData,
  sourceDocumentId: string | null,
): Promise<ProfileRecord> {
  const current = (await profiles.getProfiles(ownerId)).draft;
  const saved = await profiles.saveDraftIfUnchanged(
    ownerId,
    data,
    sourceDocumentId,
    current?.version ?? null,
  );
  if (!saved) throw new Error('seedDraft: the draft changed while it was being seeded');
  return saved;
}
