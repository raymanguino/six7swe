import { and, eq, sql } from 'drizzle-orm';
import { ProfileDataSchema, type ProfileData, type ProfileStage } from '../../contract.js';
import type { KnowledgeDb, KnowledgeExecutor } from '../index.js';
import { profiles } from '../schema.js';
import {
  sameInstant,
  type ProfilePair,
  type ProfileRecord,
  type ProfileRepository,
} from './profileRepository.js';

type ProfileRow = typeof profiles.$inferSelect;

/**
 * A row as a record. The data is validated on the way out as well as on the
 * way in, so a row edited by hand into something the contract rejects fails
 * loudly here rather than on the public site.
 */
function toRecord(row: ProfileRow): ProfileRecord {
  return {
    ownerId: row.ownerId,
    stage: row.stage,
    data: ProfileDataSchema.parse({
      name: row.name,
      title: row.title,
      location: row.location,
      summary: row.summary,
      skills: row.skills,
      experience: row.experience,
      projects: row.projects,
      links: row.links,
    }),
    sourceDocumentId: row.sourceDocumentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function columnsOf(data: ProfileData) {
  const valid = ProfileDataSchema.parse(data);
  return {
    name: valid.name,
    title: valid.title,
    location: valid.location,
    summary: valid.summary,
    skills: valid.skills,
    experience: valid.experience,
    projects: valid.projects,
    links: valid.links,
  };
}

async function getStage(
  executor: KnowledgeExecutor,
  ownerId: string,
  stage: ProfileStage,
): Promise<ProfileRecord | null> {
  const [row] = await executor
    .select()
    .from(profiles)
    .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, stage)))
    .limit(1);
  return row ? toRecord(row) : null;
}

export function createDrizzleProfileRepository(db: KnowledgeDb): ProfileRepository {
  return {
    async getProfiles(ownerId): Promise<ProfilePair> {
      const rows = await db.select().from(profiles).where(eq(profiles.ownerId, ownerId));
      const draft = rows.find((r) => r.stage === 'draft');
      const published = rows.find((r) => r.stage === 'published');
      return {
        draft: draft ? toRecord(draft) : null,
        published: published ? toRecord(published) : null,
      };
    },

    async getPublished(ownerId) {
      return getStage(db, ownerId, 'published');
    },

    async saveDraft(ownerId, data, sourceDocumentId) {
      const values = { ...columnsOf(data), sourceDocumentId };
      const [row] = await db
        .insert(profiles)
        .values({ ownerId, stage: 'draft', ...values })
        .onConflictDoUpdate({
          target: [profiles.ownerId, profiles.stage],
          set: { ...values, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new Error('profile draft upsert returned no row');
      return toRecord(row);
    },

    async deleteDraft(ownerId) {
      const deleted = await db
        .delete(profiles)
        .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft')))
        .returning({ ownerId: profiles.ownerId });
      return deleted.length > 0;
    },

    async publishDraft(ownerId, expectedUpdatedAt) {
      return db.transaction(async (tx) => {
        // Locks the draft, so a re-draft landing now waits for the publish
        // (and then writes a new draft) instead of being deleted unseen.
        const [draftRow] = await tx
          .select()
          .from(profiles)
          .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft')))
          .for('update');
        if (!draftRow) return { status: 'no-draft' } as const;
        const draft = toRecord(draftRow);
        if (!sameInstant(draft.updatedAt, expectedUpdatedAt)) {
          return { status: 'stale', draft } as const;
        }

        const values = { ...columnsOf(draft.data), sourceDocumentId: draft.sourceDocumentId };
        const [published] = await tx
          .insert(profiles)
          .values({ ownerId, stage: 'published', ...values })
          .onConflictDoUpdate({
            target: [profiles.ownerId, profiles.stage],
            set: { ...values, updatedAt: sql`now()` },
          })
          .returning();
        if (!published) throw new Error('profile publish upsert returned no row');
        await tx
          .delete(profiles)
          .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft')));
        return { status: 'published', profile: toRecord(published) } as const;
      });
    },
  };
}
