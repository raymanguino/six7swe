/**
 * The service's wire contract lives in `packages/knowledge-types`, shared with
 * the backend. This module re-exports it so the service's own modules keep a
 * single local import path.
 */
export * from '@six7swe/knowledge-types';
