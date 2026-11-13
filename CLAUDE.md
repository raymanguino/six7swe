# six7swe

Portfolio + job-matching SWE platform. Full architecture in `docs/architecture.md`.

## Architecture Notes
- Two separate products in one repo: the public **portfolio** (`backend/src/db/schema/portfolio.ts`, routes in `backend/src/routes/portfolio.ts`) and the **job hunter** (`backend/src/db/schema/jobHunt.ts`, routes in `backend/src/routes/jobHunt.ts`). The job hunter lives under `/job-hunt/*`.
- Auth verifies real Supabase JWTs against the project JWKS (`backend/src/services/auth/`). Routes are private by default and opt out via `PUBLIC_ROUTE` in `backend/src/routes/access.ts`. `AUTH_DEV_BYPASS=true` is for local use only.
- Supabase used for Storage only (resume/PDF bucket `portfolio-files`); no frontend Supabase client
- **Migrations.** The schema (`backend/src/db/schema/`) is the source of truth. `pnpm run db:generate` writes a migration from a schema change; `pnpm run db:migrate` applies it. `pnpm run db:reset` rebuilds the database from the migration history.
- **`pnpm run db:reset` leaves the database empty.** Dev data is opt-in with `--seed`; the portfolio is a separate script (`pnpm run db:seed-portfolio`) because its data is gitignored. A reset against the hosted database asks you to type the host before it drops anything (`--yes` skips the prompt).
- **`auth_id` is the identity key, not the email.** A local user row is bound to exactly one authenticated subject and is never re-bound (`backend/src/domain/jobHunt/identity.ts`). `users.email` is nullable because a token may carry no email claim.
- Portfolio data is private and gitignored: `backend/scripts/portfolio-data.json` (template: `portfolio-data.example.json`) and `backend/content/`. Seed it with `pnpm run db:seed-portfolio`.
- `portfolioService.ts` caches in memory; TTL via `PORTFOLIO_CACHE_TTL_MS` (default 10 min)
- Lerna was removed: it was never used, and it pulled in `nx` and `axios`, which accounted for most of the dependency advisories. pnpm workspace scripts are authoritative
- `packages/` is empty; no shared packages yet
- **Knowledge service** (`knowledge/`): a separate ESM deployable. It holds the owner's background docs and serves vector retrieval (pgvector) for chat and job matching; see `knowledge/README.md`. It owns the `knowledge` + `knowledge_migrations` Postgres schemas and never touches `public`. Its migrations are applied with `pnpm --filter @six7swe/knowledge db:migrate` (not drizzle-kit migrate, which swallows errors). `EMBEDDER=hashing` + `FILE_STORE=local` run it offline.
- **Railway config is `.railway/railway.ts`** (Infrastructure as Code; `railway.json` was retired before the 2026-12-01 cutoff). Railway does not read it on deploy: a change is applied by hand with `railway config plan` then `railway config apply`. Applies are declarative, so a variable missing from the file is deleted; secrets are listed as `preserve()`.
- **On Windows, `railway config plan` / `railway config apply` fail** with "This version of railway/iac requires Railway CLI 5.42.1 or newer" even on a current CLI (5.74.0). The `railway` SDK checks the version by running `railway --version` without a shell, which cannot spawn the `railway.cmd` / `railway.ps1` / `railway` shell shims that npm and pnpm install. Fix: put the directory holding `railway.exe` ahead of the shims on `PATH` — `$env:PATH = "$(npm root -g)\@railway\cli\bin;$env:PATH"` (PowerShell; cmd.exe and Git Bash variants, and how `_` factors in per shell, in [Changing Railway config](./DEPLOYMENT.md#changing-railway-config)).
