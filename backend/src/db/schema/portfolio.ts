import {
  pgTable,
  serial,
  varchar,
  timestamp,
  text,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';

// ============================================================
// PORTFOLIO PRODUCT SCHEMA
//
// Tables owned by the public portfolio site and its AI endpoints.
// These are independent of the job-hunter product; see ./jobHunt.ts
// for the job-search tables.
// ============================================================

// Portfolio owner profile (resume + contact info) - single row
export const portfolioProfile = pgTable('portfolio_profile', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  title: varchar('title', { length: 512 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  location: varchar('location', { length: 255 }),
  linkedinUrl: varchar('linkedin_url', { length: 512 }),
  githubUrl: varchar('github_url', { length: 512 }),
  summary: text('summary'),
  skills: jsonb('skills').$type<string[]>().default([]),
  experience: jsonb('experience').$type<Array<{ title: string; company: string; period: string; description: string }>>().default([]),
  projects: jsonb('projects').$type<Array<{ name: string; description: string; technologies: string[] }>>().default([]),
  fullResumeText: text('full_resume_text').notNull(),
  resumeFilename: varchar('resume_filename', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Additional content sections (from backend/content files)
export const contentSections = pgTable('content_sections', {
  id: serial('id').primaryKey(),
  filename: varchar('filename', { length: 255 }).notNull(),
  content: text('content').notNull(),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ============================================================
// TYPE EXPORTS
// ============================================================

export type PortfolioProfile = typeof portfolioProfile.$inferSelect;
export type InsertPortfolioProfile = typeof portfolioProfile.$inferInsert;

export type ContentSection = typeof contentSections.$inferSelect;
export type InsertContentSection = typeof contentSections.$inferInsert;
