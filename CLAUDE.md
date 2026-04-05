# six7swe

Portfolio + job-matching SWE platform. Full architecture in `docs/architecture.md`.

## Architecture Notes
- Auth is stubbed: `onRequest` hard-codes a user via `@fastify/request-context`; replace before prod
- Supabase used for Storage only (resume/PDF bucket `portfolio-files`); no frontend Supabase client
- Drizzle manages schema (`backend/src/db/schema.ts`) and migrations (`backend/migrations/`); Supabase migrations (`supabase/migrations/`) cover the same tables for local Supabase CLI use
- `portfolioService.ts` caches in memory; TTL via `PORTFOLIO_CACHE_TTL_MS` (default 10 min)
- Lerna is present (`lerna.json`) but unused; pnpm workspace scripts are authoritative
- `packages/` is empty; no shared packages yet
