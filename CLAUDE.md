# six7swe

Portfolio + job-matching SWE platform. Full architecture in `docs/architecture.md`.

## Architecture Notes
- Two separate products in one repo: the public **portfolio** (`backend/src/db/schema/portfolio.ts`, routes in `backend/src/routes/portfolio.ts`) and the **job hunter** (`backend/src/db/schema/jobHunt.ts`, routes in `backend/src/routes/jobHunt.ts`). The job hunter lives under `/job-hunt/*`.
- Auth verifies real Supabase JWTs against the project JWKS (`backend/src/services/auth/`). Routes are private by default and opt out via `PUBLIC_ROUTE` in `backend/src/routes/access.ts`. `AUTH_DEV_BYPASS=true` is for local use only.
- Supabase used for Storage only (resume/PDF bucket `portfolio-files`); no frontend Supabase client
- **No migration files.** The Drizzle schema (`backend/src/db/schema/`) is the single source of truth; `pnpm run db:push` reconciles the database with it and `pnpm run db:reset` rebuilds it from scratch. The parallel `supabase/migrations/` set was removed because it drifted.
- **`pnpm run db:reset` leaves the database empty.** Dev data is opt-in with `--seed`; the portfolio is a separate script (`pnpm run db:seed-portfolio`) because its data is gitignored. A reset against the hosted database asks you to type the host before it drops anything (`--yes` skips the prompt).
- **`auth_id` is the identity key, not the email.** A local user row is bound to exactly one authenticated subject and is never re-bound (`backend/src/domain/jobHunt/identity.ts`). `users.email` is nullable because a token may carry no email claim.
- Portfolio data is private and gitignored: `backend/scripts/portfolio-data.json` (template: `portfolio-data.example.json`) and `backend/content/`. Seed it with `pnpm run db:seed-portfolio`.
- `portfolioService.ts` caches in memory; TTL via `PORTFOLIO_CACHE_TTL_MS` (default 10 min)
- Lerna was removed: it was never used, and it pulled in `nx` and `axios`, which accounted for most of the dependency advisories. pnpm workspace scripts are authoritative
- `packages/` is empty; no shared packages yet
