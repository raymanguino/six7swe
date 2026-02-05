import {
  pgTable,
  serial,
  varchar,
  timestamp,
  integer,
  text,
  pgEnum,
  unique,
  index,
} from 'drizzle-orm/pg-core';

// ============================================================
// ENUMS
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

export const matchScoreEnum = pgEnum('match_score', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'TOP',
]);

// ============================================================
// TABLES
// ============================================================

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
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
});

export const profileJobs = pgTable('profile_jobs', {
  id: serial('id').primaryKey(),
  profileId: integer('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  jobHash: varchar('job_hash', { length: 64 }).notNull(),
  score: matchScoreEnum('score'),
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
