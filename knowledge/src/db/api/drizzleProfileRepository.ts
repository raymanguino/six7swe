import { and, eq, sql } from 'drizzle-orm';
import { ProfileDataSchema, type ProfileData, type ProfileStage } from '../../contract.js';
import type { KnowledgeDb, KnowledgeExecutor } from '../index.js';
import { nextProfileVersion, profiles } from '../schema.js';
import type {
  OwnerSaveOutcome,
  ProfilePair,
  ProfileRecord,
  ProfileRepository,
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
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** What every write sets besides the data: a new version and timestamp. */
function touched() {
  return {
    version: nextProfileVersion(),
    updatedAt: sql<Date>`now()`,
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
          set: { ...values, ...touched() },
        })
        .returning();
      if (!row) throw new Error('profile draft upsert returned no row');
      return toRecord(row);
    },

    async saveDraftIfUnchanged(ownerId, data, sourceDocumentId, expectedVersion) {
      const values = { ...columnsOf(data), sourceDocumentId };
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({ version: profiles.version })
          .from(profiles)
          .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft')))
          .for('update');
        if (current) {
          // Locked, so the owner's save cannot land between this check and the write.
          if (current.version !== expectedVersion) return null;
          const [row] = await tx
            .update(profiles)
            .set({ ...values, ...touched() })
            .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft')))
            .returning();
          if (!row) return null;
          if (row.version === current.version) {
            throw new Error('profile draft update did not change its version');
          }
          return toRecord(row);
        }
        // No draft (never was, or discarded). An owner's draft inserted
        // concurrently wins: the insert then does nothing.
        const [row] = await tx
          .insert(profiles)
          .values({ ownerId, stage: 'draft', ...values })
          .onConflictDoNothing()
          .returning();
        return row ? toRecord(row) : null;
      });
    },

    async saveOwnerDraft(ownerId, data, expectedVersion): Promise<OwnerSaveOutcome> {
      const columns = columnsOf(data);
      const isDraft = and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft'));
      const checked = expectedVersion !== undefined;
      return db.transaction(async (tx) => {
        // Locked, so a redraft cannot land between this check and the write.
        const [current] = await tx.select().from(profiles).where(isDraft).for('update');
        if (current) {
          if (checked && current.version !== expectedVersion) {
            return { status: 'stale', draft: toRecord(current) } as const;
          }
          // The source is left as it is: the draft keeps the resume it came from.
          const [row] = await tx
            .update(profiles)
            .set({ ...columns, ...touched() })
            .where(isDraft)
            .returning();
          if (!row) throw new Error('profile draft update returned no row');
          return { status: 'saved', profile: toRecord(row) } as const;
        }
        if (checked && expectedVersion !== null) return { status: 'stale', draft: null } as const;

        // No draft: a new one takes the published profile's source, read by
        // the insert itself.
        const publishedSource = tx
          .select({ id: profiles.sourceDocumentId })
          .from(profiles)
          .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'published')));
        const insert = tx.insert(profiles).values({
          ownerId,
          stage: 'draft',
          ...columns,
          sourceDocumentId: sql<string | null>`(${publishedSource})`,
        });
        // A draft inserted concurrently (nothing to lock above): an unchecked
        // save replaces its data and keeps its source; a checked one is stale.
        const [row] = checked
          ? await insert.onConflictDoNothing().returning()
          : await insert
              .onConflictDoUpdate({
                target: [profiles.ownerId, profiles.stage],
                set: { ...columns, ...touched() },
              })
              .returning();
        if (row) return { status: 'saved', profile: toRecord(row) } as const;
        return { status: 'stale', draft: await getStage(tx, ownerId, 'draft') } as const;
      });
    },

    async deleteDraft(ownerId) {
      const deleted = await db
        .delete(profiles)
        .where(and(eq(profiles.ownerId, ownerId), eq(profiles.stage, 'draft')))
        .returning({ ownerId: profiles.ownerId });
      return deleted.length > 0;
    },

    async publishDraft(ownerId, expectedVersion) {
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
        if (draft.version !== expectedVersion) return { status: 'stale', draft } as const;

        const values = { ...columnsOf(draft.data), sourceDocumentId: draft.sourceDocumentId };
        const [published] = await tx
          .insert(profiles)
          .values({ ownerId, stage: 'published', ...values })
          .onConflictDoUpdate({
            target: [profiles.ownerId, profiles.stage],
            set: { ...values, ...touched() },
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
