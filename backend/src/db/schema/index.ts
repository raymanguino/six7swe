/**
 * Database schema entry point.
 *
 * Only the job hunter has tables (./jobHunt: users, profiles, jobs, matches).
 * The portfolio's background lives in the knowledge service, which owns its
 * own `knowledge` schema.
 *
 * Drizzle discovers every table from this single entry point.
 */
export * from './jobHunt';
