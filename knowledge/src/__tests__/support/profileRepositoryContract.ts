import { describe, expect, it } from 'vitest';
import type { ProfileRepository } from '../../db/api/profileRepository.js';
import { SAMPLE_PROFILE } from './fixtures.js';

export interface ProfileContractTarget {
  profiles: ProfileRepository;
  /** A fresh owner id for one test, so no test sees another's rows. */
  newOwner: () => string;
}

/**
 * The behaviour every ProfileRepository must have, run against the
 * in-memory double (always) and the Drizzle repository (with a database).
 */
export function describeProfileRepositoryContract(
  name: string,
  target: () => ProfileContractTarget,
  options: { skip?: boolean } = {},
): void {
  describe.skipIf(options.skip ?? false)(`ProfileRepository contract: ${name}`, () => {
    it('starts empty', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      expect(await profiles.getProfiles(owner)).toEqual({ draft: null, published: null });
      expect(await profiles.getPublished(owner)).toBeNull();
      expect(await profiles.deleteDraft(owner)).toBe(false);
    });

    it('saves, replaces and deletes the draft', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const first = await profiles.saveDraft(owner, SAMPLE_PROFILE, null);
      expect(first).toMatchObject({ ownerId: owner, stage: 'draft', data: SAMPLE_PROFILE });

      const edited = { ...SAMPLE_PROFILE, title: 'Principal Engineer' };
      const second = await profiles.saveDraft(owner, edited, null);
      expect(second.data.title).toBe('Principal Engineer');
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
      expect((await profiles.getProfiles(owner)).draft?.data.title).toBe('Principal Engineer');

      expect(await profiles.deleteDraft(owner)).toBe(true);
      expect((await profiles.getProfiles(owner)).draft).toBeNull();
    });

    it('rejects data the contract rejects', async () => {
      const { profiles, newOwner } = target();
      const bad = {
        ...SAMPLE_PROFILE,
        links: { ...SAMPLE_PROFILE.links, website: 'javascript:alert(1)' },
      };
      await expect(profiles.saveDraft(newOwner(), bad, null)).rejects.toThrow();
    });

    it('publishes the reviewed draft and removes it', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      expect(await profiles.publishDraft(owner, new Date())).toEqual({ status: 'no-draft' });

      const draft = await profiles.saveDraft(owner, SAMPLE_PROFILE, null);
      const outcome = await profiles.publishDraft(owner, draft.updatedAt);
      expect(outcome).toMatchObject({
        status: 'published',
        profile: { stage: 'published', data: SAMPLE_PROFILE },
      });
      expect(await profiles.getProfiles(owner)).toMatchObject({
        draft: null,
        published: { data: SAMPLE_PROFILE },
      });

      // Publishing again replaces the published profile.
      const next = await profiles.saveDraft(owner, { ...SAMPLE_PROFILE, name: 'J. Example' }, null);
      await profiles.publishDraft(owner, next.updatedAt);
      expect((await profiles.getPublished(owner))?.data.name).toBe('J. Example');
    });

    it('refuses to publish a draft that changed after review', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const reviewed = await profiles.saveDraft(owner, SAMPLE_PROFILE, null);
      await profiles.saveDraft(owner, { ...SAMPLE_PROFILE, title: 'Changed' }, null);

      const outcome = await profiles.publishDraft(owner, reviewed.updatedAt);
      expect(outcome).toMatchObject({ status: 'stale', draft: { data: { title: 'Changed' } } });
      expect(await profiles.getPublished(owner)).toBeNull();
    });

    it('writes a drafter’s draft only over the draft it started from', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      // No draft yet: written.
      const first = await profiles.saveDraftIfUnchanged(owner, SAMPLE_PROFILE, null, null);
      expect(first?.data).toEqual(SAMPLE_PROFILE);
      if (!first) throw new Error('expected a draft');

      // The owner edits it while a new one is drafted: the edits are kept.
      await profiles.saveDraft(owner, { ...SAMPLE_PROFILE, title: 'Owner edit' }, null);
      const drafted = { ...SAMPLE_PROFILE, title: 'Model draft' };
      expect(await profiles.saveDraftIfUnchanged(owner, drafted, null, first.updatedAt)).toBeNull();
      expect(await profiles.saveDraftIfUnchanged(owner, drafted, null, null)).toBeNull();
      expect((await profiles.getProfiles(owner)).draft?.data.title).toBe('Owner edit');

      // Unchanged since the drafter started: replaced.
      const current = (await profiles.getProfiles(owner)).draft;
      if (!current) throw new Error('expected a draft');
      const saved = await profiles.saveDraftIfUnchanged(owner, drafted, null, current.updatedAt);
      expect(saved?.data.title).toBe('Model draft');

      // Discarded since the drafter started: written.
      await profiles.deleteDraft(owner);
      const after = await profiles.saveDraftIfUnchanged(owner, drafted, null, current.updatedAt);
      expect(after?.data.title).toBe('Model draft');
    });

    it('scopes profiles to the owner', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const draft = await profiles.saveDraft(owner, SAMPLE_PROFILE, null);
      const other = newOwner();
      expect(await profiles.getProfiles(other)).toEqual({ draft: null, published: null });
      expect(await profiles.publishDraft(other, draft.updatedAt)).toEqual({ status: 'no-draft' });
      expect(await profiles.deleteDraft(other)).toBe(false);
    });
  });
}
