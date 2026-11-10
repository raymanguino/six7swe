# Railway Deployment Guide

This monorepo is configured to deploy on Railway with separate services for frontend and backend.

Before deploying, complete the local setup steps in `SETUP.md` (install dependencies, configure environment variables, and seed your portfolio/resume data).

## Node Version

The backend needs **Node 22**. The root `package.json` declares it:

```json
"engines": { "node": ">=22 <23" }
```

Railway's Nixpacks builder reads that field and installs the matching Node
version. Without it the builder falls back to Node 18, which is end of life and
too old for some dependencies.

> Node 18 crashes the backend on startup with `ERR_REQUIRE_ESM`. The
> `content-disposition` package that `@fastify/static` depends on is ESM only,
> and Node 18 cannot `require()` an ES module. The dependency is pinned to a
> CommonJS release through a pnpm override in `pnpm-workspace.yaml`, so the
> backend also runs on older runtimes, but Node 22 is the supported version and
> the one CI tests.
>
> `backend/src/__tests__/runtimeDependencies.test.ts` fails the build if a
> dependency becomes ESM only, so this cannot regress silently.

## Setup Instructions

### 1. Backend Service

1. Create a new service in Railway
2. Connect your GitHub repository
3. Leave the **Root Directory** at the default (`/`), the repository root. The commands in
   `railway.json` already `cd` into `backend`, so a root directory of `backend` would make them
   fail.
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables on the service:
   - `DATABASE_URL` - PostgreSQL connection string
   - `PORT` - Port (Railway sets this automatically)
   - `NODE_ENV` - Set to `production`
   - `MINIMAX_API_KEY` - MiniMax API key
   - `MINIMAX_API_KEY_SECONDARY` - Optional MiniMax key used for one retry when the primary request receives HTTP 429
   - `RESEND_API_KEY` - Resend API key (contact form)
   - `RESEND_FROM_EMAIL` - Sender address for outbound mail. Must be on a domain verified in Resend, e.g. `no-reply@auth.your-domain.dev`
   - `RESEND_FROM_NAME` - Optional display name shown next to the sender address
   - `SUPABASE_URL` - Supabase project URL; the JWKS endpoint is derived from it. Required for the job-hunter routes
   - `SUPABASE_JWKS_URL` - Optional explicit JWKS endpoint
   - `JOB_REFRESH_STALE_MINUTES` - Optional; how long a refresh may run before it is considered abandoned (default 30)

> `AUTH_DEV_BYPASS` must **not** be set in production. The server refuses to
> start with it enabled when `NODE_ENV=production`.

> `RESEND_FROM_EMAIL` is required for the contact form. The backend refuses to
> send mail without it and answers `/contact` with a 500, because the
> Resend shared sender (`onboarding@resend.dev`) only delivers to the account
> owner and would silently drop every message.

> Set production values in the Railway dashboard, not in a committed file. `backend/.env` and `backend/.env.*` are gitignored and never deployed.

> **IPv4 only:** Railway does not support outbound IPv6. Use Supabase's IPv4 connection string for `DATABASE_URL`. See [Railway Outbound Networking](https://docs.railway.com/networking/outbound-networking).

### 2. Frontend Service

1. Create a new service in Railway
2. Connect the same GitHub repository
3. Leave the **Root Directory** at the default (`/`), the repository root, for the same reason as
   the backend service.
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables:
   - `VITE_API_URL` - URL of your backend service (e.g., `https://your-backend.railway.app`)
   - `VITE_SUPABASE_URL` - Supabase project URL, for job-hunter sign-in
   - `VITE_SUPABASE_ANON_KEY` - Supabase anon key, for job-hunter sign-in

### 3. Apply the Migrations to the Remote Database

The schema must exist before the backend can serve requests. From your machine:

```bash
cd backend
pnpm run db:migrate -- --remote
```

The migrations are generated from `src/db/schema/` and applied in order. `db:migrate` applies
only the ones that have not been applied yet, so it is safe to run at any time.

A database that was created before the migration history existed has the tables but no
migration ledger, so `db:migrate` cannot apply anything to it. Run `db:reset` on such a
database once to rebuild it from the history.

To rebuild the database from scratch instead, drop everything in the `public` schema and replay
the migrations:

```bash
pnpm run db:reset -- --remote
```

This leaves the Supabase-managed schemas (`auth`, `storage`, `graphql_public`) alone, so
Supabase Auth users survive.

Because the reset destroys data, it prints the target host and asks you to type it back before it
drops anything. Pass `--yes` to skip the prompt when you have already checked the host:

```bash
pnpm run db:reset -- --remote --yes
```

The database is left **empty**. Add `--seed` to also insert the job-hunter development data:

```bash
pnpm run db:reset -- --remote --seed   # hosted database, with dev data
pnpm run db:reset -- --seed             # local database, with dev data
```

The portfolio is never seeded by the reset: its data lives in gitignored files, so apply it
separately with `pnpm run db:seed-portfolio -- --remote`. Without it the public site renders
without a profile.

> Take a backup first (`pg_dump "$DATABASE_URL" -Fc -f backup.dump`) if the hosted database holds
> anything you want to keep.

### 3a. Schema on Deploy

The backend service applies the migrations as a **pre-deploy** command, so every deploy brings
the hosted database in line with `src/db/schema/`:

```json
"deploy": {
  "preDeployCommand": "cd backend && pnpm db:migrate -- --remote && pnpm db:secure -- --remote"
}
```

`preDeployCommand` runs after the build succeeds and before the new version starts, so the schema
is in place before the code that depends on it. The frontend service does not need one.

The two steps are in that order on purpose. `db:migrate` applies the migrations, and a table that
a migration created starts out with the default Supabase grants, so `db:secure` has to run after
it to turn row level security back on and revoke the public grants. `docs/SECURITY.md` describes
what that does and why it matters.

`db:migrate` does not prompt, so it is safe to run unattended.

> A migration that drops a table or a column is applied to the hosted database automatically.
> Take a backup before deploying one.

`backend/.env.remote` holds the remote `DATABASE_URL` and is gitignored.

### 4. Resume PDF

The frontend downloads the resume from the backend via `GET /resume`. The backend serves it from the local filesystem at `backend/public/`, falling back to `resume.pdf` if the database filename does not match.

- Place your resume at `backend/public/resume.pdf` (or match `portfolio_profile.resume_filename`).
- Ensure it is present in the deployed backend filesystem. Note that this repo's `.gitignore` ignores `backend/public/*.pdf` by default, so it will not deploy unless you change that policy.

> Supabase Storage is **not** currently read by the backend — `@supabase/supabase-js` is not a dependency and no code path reads `SUPABASE_URL` or `SUPABASE_SECRET_KEY`. Serving the resume from Storage requires implementing that path first.

### 5. Update Resume / Portfolio Data

1. Copy `backend/scripts/portfolio-data.example.json` to `backend/scripts/portfolio-data.json`, fill in your data, then run `pnpm run db:seed-portfolio -- --remote` from `backend/`—or update `portfolio_profile` directly in the database
2. Contact info is served from the portfolio API; no frontend edits needed

### 6. Job Refreshes (optional)

The job-hunter can trigger a refresh over HTTP, but a refresh started that way
does not survive a backend restart. For scheduled refreshes, add a **Cron** to
the backend service in Railway:

```bash
pnpm run jobs:refresh -- --profile 1
```

`profileId` is the id of the search profile to refresh. The command uses the
same pipeline as the HTTP trigger and records progress in `refresh_status`.

Refreshes abandoned by a crashed process are marked failed on the next backend
startup, so a stale run never blocks the next one.

## Monorepo Structure

```
six7swe/
├── backend/          # Backend service (Fastify API)
│   ├── railway.json  # Railway config
│   └── public/        # Static files (resume.pdf)
├── frontend/         # Frontend service (React app)
│   └── railway.json  # Railway config
└── package.json      # Root workspace config
```

## Watch Paths (Optional)

To prevent unnecessary rebuilds, configure watch paths in Railway:

- **Backend**: `/backend/**`
- **Frontend**: `/frontend/**`

This ensures that changes in one service don't trigger rebuilds of the other.
