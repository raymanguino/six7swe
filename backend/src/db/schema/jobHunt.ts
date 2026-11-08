import {
  pgTable,
  serial,
  varchar,
  timestamp,
  integer,
  text,
  pgEnum,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============================================================
// JOB-HUNTER PRODUCT SCHEMA
//
// Tables owned by the job-search product: users, per-search profiles,
// scraped job postings, matches and refresh progress.
// These are independent of the public portfolio site; see ./portfolio.ts
// for the portfolio owner's public profile.
// ============================================================

export const jobSourceEnum = pgEnum('job_source', [
  'LINKEDIN',
  'INDEED',
  'GLASSDOOR',
  'COMPANY_WEBSITE',
  'OTHER',
]);

export const refreshUpdateStatusEnum = pgEnum('refresh_update_status', [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
]);

export const refreshUpdateStatusStepEnum = pgEnum('refresh_update_status_step', [
  'PENDING',
  'FETCHING_JOBS',
  'FILTERING_JOBS',
]);

export const matchBandEnum = pgEnum('match_band', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'TOP',
]);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  /** External auth provider id (Supabase auth user id). */
  authId: varchar('auth_id', { length: 255 }).unique(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const profiles = pgTable('profiles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  keywords: varchar('keywords', { length: 255 }).array(),
  location: varchar('location', { length: 255 }),
  additionalContext: text('additional_context'),
  resume: text('resume'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  userNameUnique: unique().on(table.userId, table.name),
}));

export const jobs = pgTable('jobs', {
  id: serial('id').primaryKey(),
  sourceId: jobSourceEnum('source_id').default('LINKEDIN'),
  sourceJobId: varchar('source_job_id', { length: 255 }).notNull(),
  link: varchar('link', { length: 512 }).notNull(),
  company: varchar('company', { length: 255 }).notNull(),
  position: varchar('position', { length: 255 }).notNull(),
  description: text('description').notNull(),
  // Location as displayed by the source (e.g. "Toronto, Ontario, Canada").
  location: varchar('location', { length: 255 }),
  // Raw relative label from the source (e.g. "2 days ago"), not a timestamp.
  datePosted: varchar('date_posted', { length: 64 }),
  hash: varchar('hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  sourceJobUnique: unique().on(table.sourceId, table.sourceJobId),
  sourceJobIdx: index('idx_jobs_source_job_lookup').on(table.sourceId, table.sourceJobId),
}));

export const refreshStatus = pgTable('refresh_status', {
  id: serial('id').primaryKey(),
  profileId: integer('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  status: refreshUpdateStatusEnum('status').default('PENDING'),
  step: refreshUpdateStatusStepEnum('step').default('PENDING'),
  description: varchar('description', { length: 512 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  // At most one refresh may be active for a profile at a time.
  //
  // The application also checks for an active refresh before starting one,
  // but that check and the insert are separate statements, so two concurrent
  // requests can both observe "no active refresh" and both insert. This
  // partial unique index makes the database the authority: the second insert
  // fails with a unique violation instead of creating a duplicate run.
  //
  // It is partial so that finished rows (COMPLETED / FAILED) never block a
  // later refresh, and so the full history of past refreshes is kept.
  activeProfileUnique: uniqueIndex('refresh_status_active_profile_unique')
    .on(table.profileId)
    .where(sql`${table.status} in ('PENDING', 'IN_PROGRESS')`),
}));

export const profileJobs = pgTable('profile_jobs', {
  id: serial('id').primaryKey(),
  profileId: integer('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  jobHash: varchar('job_hash', { length: 64 }).notNull(),
  score: integer('score'),
  band: matchBandEnum('band'),
  explanation: text('explanation'),
  firstSkillMatch: text('first_skill_match'),
  secondSkillMatch: text('second_skill_match'),
  thirdSkillMatch: text('third_skill_match'),
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileJobUnique: unique().on(table.profileId, table.jobId),
}));

// ============================================================
// TYPE EXPORTS
// ============================================================

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export type Profile = typeof profiles.$inferSelect;
export type InsertProfile = typeof profiles.$inferInsert;

export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;

export type RefreshStatus = typeof refreshStatus.$inferSelect;
export type InsertRefreshStatus = typeof refreshStatus.$inferInsert;

export type ProfileJob = typeof profileJobs.$inferSelect;
export type InsertProfileJob = typeof profileJobs.$inferInsert;

export type JobSource = (typeof jobSourceEnum.enumValues)[number];
export type RefreshUpdateStatus = (typeof refreshUpdateStatusEnum.enumValues)[number];
export type RefreshUpdateStatusStep = (typeof refreshUpdateStatusStepEnum.enumValues)[number];
export type MatchBand = (typeof matchBandEnum.enumValues)[number];
