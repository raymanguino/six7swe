import { describe, expect, it } from 'vitest';
import type { ProfileRepository } from '../../db/api/profileRepository.js';
import { SAMPLE_PROFILE } from './fixtures.js';
import { seedDraft } from './seedDraft.js';

export interface ProfileContractTarget {
  profiles: ProfileRepository;
  /** A fresh owner id for one test, so no test sees another's rows. */
  newOwner: () => string;
  /**
   * Test-only: sets the draft's `updatedAt` and nothing else (its `version`
   * is kept), to force two writes into one millisecond.
   */
  setDraftUpdatedAt: (ownerId: string, at: Date) => Promise<void>;
  /** A document of the owner's that a profile may name as its source. */
  newSourceDocument: (ownerId: string) => Promise<string>;
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
      const first = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      expect(first).toMatchObject({ ownerId: owner, stage: 'draft', data: SAMPLE_PROFILE });

      const edited = { ...SAMPLE_PROFILE, title: 'Principal Engineer' };
      const second = await seedDraft(profiles, owner, edited, null);
      expect(second.data.title).toBe('Principal Engineer');
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
      expect(second.version).not.toBe(first.version);
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
      await expect(profiles.saveOwnerDraft(newOwner(), bad)).rejects.toThrow();
      await expect(profiles.saveDraftIfUnchanged(newOwner(), bad, null, null)).rejects.toThrow();

      // Validated before the version check: bad data is an error, never "stale".
      const owner = newOwner();
      await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      await expect(profiles.saveOwnerDraft(owner, bad, 999)).rejects.toThrow();
      await expect(profiles.saveOwnerDraft(owner, bad, null)).rejects.toThrow();
      await expect(profiles.saveDraftIfUnchanged(owner, bad, null, 999)).rejects.toThrow();
    });

    it('publishes the reviewed draft and removes it', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      expect(await profiles.publishDraft(owner, 1)).toEqual({ status: 'no-draft' });

      const draft = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      const outcome = await profiles.publishDraft(owner, draft.version);
      expect(outcome).toMatchObject({
        status: 'published',
        profile: { stage: 'published', data: SAMPLE_PROFILE },
      });
      expect(await profiles.getProfiles(owner)).toMatchObject({
        draft: null,
        published: { data: SAMPLE_PROFILE },
      });

      // Publishing again replaces the published profile.
      const next = await seedDraft(
        profiles,
        owner,
        { ...SAMPLE_PROFILE, name: 'J. Example' },
        null,
      );
      await profiles.publishDraft(owner, next.version);
      expect((await profiles.getPublished(owner))?.data.name).toBe('J. Example');
    });

    it('refuses to publish a draft that changed after review', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const reviewed = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      await seedDraft(profiles, owner, { ...SAMPLE_PROFILE, title: 'Changed' }, null);

      const outcome = await profiles.publishDraft(owner, reviewed.version);
      expect(outcome).toMatchObject({ status: 'stale', draft: { data: { title: 'Changed' } } });
      expect(await profiles.getPublished(owner)).toBeNull();
    });

    // #184: `updatedAt` reaches callers at millisecond precision, so a check
    // on it missed a change saved in the same millisecond as the reviewed write.
    it('refuses a changed draft whose updatedAt equals the reviewed one', async () => {
      const { profiles, newOwner, setDraftUpdatedAt } = target();
      const owner = newOwner();
      const reviewed = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      const changed = await seedDraft(
        profiles,
        owner,
        { ...SAMPLE_PROFILE, title: 'Changed' },
        null,
      );
      await setDraftUpdatedAt(owner, reviewed.updatedAt);
      const draft = (await profiles.getProfiles(owner)).draft;
      expect(draft?.updatedAt.getTime()).toBe(reviewed.updatedAt.getTime());
      expect(draft?.version).toBe(changed.version);

      expect(await profiles.publishDraft(owner, reviewed.version)).toMatchObject({
        status: 'stale',
        draft: { data: { title: 'Changed' } },
      });
      const drafted = { ...SAMPLE_PROFILE, title: 'Model draft' };
      expect(
        await profiles.saveDraftIfUnchanged(owner, drafted, null, reviewed.version),
      ).toBeNull();
      expect((await profiles.getProfiles(owner)).draft?.data.title).toBe('Changed');
      expect(await profiles.getPublished(owner)).toBeNull();
    });

    it('never reuses the version of a published or discarded draft', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const published = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      await profiles.publishDraft(owner, published.version);
      const discarded = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      await profiles.deleteDraft(owner);

      const next = await seedDraft(profiles, owner, { ...SAMPLE_PROFILE, title: 'Next' }, null);
      expect(next.version).not.toBe(published.version);
      expect(next.version).not.toBe(discarded.version);
      expect(await profiles.publishDraft(owner, published.version)).toMatchObject({
        status: 'stale',
      });
      expect(await profiles.publishDraft(owner, discarded.version)).toMatchObject({
        status: 'stale',
      });
    });

    it('writes a drafter’s draft only over the draft it started from', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      // No draft yet: written.
      const first = await profiles.saveDraftIfUnchanged(owner, SAMPLE_PROFILE, null, null);
      expect(first?.data).toEqual(SAMPLE_PROFILE);
      if (!first) throw new Error('expected a draft');

      // The owner edits it while a new one is drafted: the edits are kept.
      await seedDraft(profiles, owner, { ...SAMPLE_PROFILE, title: 'Owner edit' }, null);
      const drafted = { ...SAMPLE_PROFILE, title: 'Model draft' };
      expect(await profiles.saveDraftIfUnchanged(owner, drafted, null, first.version)).toBeNull();
      expect(await profiles.saveDraftIfUnchanged(owner, drafted, null, null)).toBeNull();
      expect((await profiles.getProfiles(owner)).draft?.data.title).toBe('Owner edit');

      // Unchanged since the drafter started: replaced.
      const current = (await profiles.getProfiles(owner)).draft;
      if (!current) throw new Error('expected a draft');
      const saved = await profiles.saveDraftIfUnchanged(owner, drafted, null, current.version);
      expect(saved?.data.title).toBe('Model draft');

      // Discarded since the drafter started: written.
      await profiles.deleteDraft(owner);
      const after = await profiles.saveDraftIfUnchanged(owner, drafted, null, current.version);
      expect(after?.data.title).toBe('Model draft');
    });

    // #186: a stale tab must not silently replace a newer draft.
    it('saves the owner’s edits only over the draft the owner opened', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const edit = (title: string) => ({ ...SAMPLE_PROFILE, title });

      // No draft expected and none there: written.
      const first = await profiles.saveOwnerDraft(owner, edit('First'), null);
      if (first.status !== 'saved') throw new Error('expected a save');

      // Another write (a redraft) lands; the tab that opened `first` is stale.
      const newer = await seedDraft(profiles, owner, edit('Redrafted'), null);
      expect(await profiles.saveOwnerDraft(owner, edit('Stale'), first.profile.version)).toEqual({
        status: 'stale',
        draft: newer,
      });
      expect(await profiles.saveOwnerDraft(owner, edit('Stale'), null)).toMatchObject({
        status: 'stale',
        draft: { version: newer.version },
      });
      expect((await profiles.getProfiles(owner)).draft).toEqual(newer);

      // Expecting the current draft: written, with a new version.
      const current = await profiles.saveOwnerDraft(owner, edit('Edited'), newer.version);
      if (current.status !== 'saved') throw new Error('expected a save');
      expect(current.profile.data.title).toBe('Edited');
      expect(current.profile.version).not.toBe(newer.version);

      // Without an expected version the save is unconditional.
      const blind = await profiles.saveOwnerDraft(owner, edit('Blind'));
      expect(blind).toMatchObject({ status: 'saved', profile: { data: { title: 'Blind' } } });

      // Expecting a draft that has since been discarded: stale, nothing written.
      await profiles.deleteDraft(owner);
      expect(await profiles.saveOwnerDraft(owner, edit('Stale'), current.profile.version)).toEqual({
        status: 'stale',
        draft: null,
      });
      expect((await profiles.getProfiles(owner)).draft).toBeNull();
    });

    it('keeps the draft’s source when the owner saves, or takes the published one', async () => {
      const { profiles, newOwner, newSourceDocument } = target();
      const owner = newOwner();
      const publishedSource = await newSourceDocument(owner);
      const draftSource = await newSourceDocument(owner);

      // No draft and nothing published: no source.
      const scratch = await profiles.saveOwnerDraft(owner, SAMPLE_PROFILE, null);
      expect(scratch).toMatchObject({ status: 'saved', profile: { sourceDocumentId: null } });
      await profiles.deleteDraft(owner);

      const toPublish = await seedDraft(profiles, owner, SAMPLE_PROFILE, publishedSource);
      await profiles.publishDraft(owner, toPublish.version);

      // A new draft started from the published profile takes its source.
      for (const expected of [null, undefined]) {
        const saved = await profiles.saveOwnerDraft(owner, SAMPLE_PROFILE, expected);
        expect(saved).toMatchObject({
          status: 'saved',
          profile: { sourceDocumentId: publishedSource },
        });
        await profiles.deleteDraft(owner);
      }

      // A drafted draft keeps the resume it came from through the owner's edits.
      const drafted = await seedDraft(profiles, owner, SAMPLE_PROFILE, draftSource);
      const edited = { ...SAMPLE_PROFILE, title: 'Edited' };
      for (const expected of [drafted.version, undefined]) {
        const saved = await profiles.saveOwnerDraft(owner, edited, expected);
        expect(saved).toMatchObject({
          status: 'saved',
          profile: { sourceDocumentId: draftSource },
        });
      }
    });

    it('scopes profiles to the owner', async () => {
      const { profiles, newOwner } = target();
      const owner = newOwner();
      const draft = await seedDraft(profiles, owner, SAMPLE_PROFILE, null);
      const other = newOwner();
      expect(await profiles.getProfiles(other)).toEqual({ draft: null, published: null });
      expect(await profiles.publishDraft(other, draft.version)).toEqual({ status: 'no-draft' });
      expect(await profiles.deleteDraft(other)).toBe(false);
    });
  });
}
