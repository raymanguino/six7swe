/**
 * Database schema entry point.
 *
 * The schema is split by product so each product owns its tables:
 *   - ./portfolio  -> public portfolio site and its AI endpoints
 *   - ./jobHunt    -> job-search product (users, profiles, jobs, matches)
 *
 * This barrel re-exports both so existing import sites keep working and
 * Drizzle can discover every table from a single entry point.
 */
export * from './portfolio';
export * from './jobHunt';
