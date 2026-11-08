# Railway Deployment Guide

This monorepo is configured to deploy on Railway with separate services for frontend and backend.

Before deploying, complete the local setup steps in `SETUP.md` (install dependencies, configure environment variables, and seed your portfolio/resume data).

## Setup Instructions

### 1. Backend Service

1. Create a new service in Railway
2. Connect your GitHub repository
3. Set the **Root Directory** to `backend` in Railway service settings
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables on the service:
   - `DATABASE_URL` - PostgreSQL connection string
   - `PORT` - Port (Railway sets this automatically)
   - `NODE_ENV` - Set to `production`
   - `MINIMAX_API_KEY` - MiniMax API key
   - `MINIMAX_API_KEY_SECONDARY` - Optional MiniMax key used for one retry when the primary request receives HTTP 429
   - `RESEND_API_KEY` - Resend API key (contact form)
   - `SUPABASE_URL` - Supabase project URL; the JWKS endpoint is derived from it. Required for the job-hunter routes
   - `SUPABASE_JWKS_URL` - Optional explicit JWKS endpoint
   - `JOB_REFRESH_STALE_MINUTES` - Optional; how long a refresh may run before it is considered abandoned (default 30)

> `AUTH_DEV_BYPASS` must **not** be set in production. The server refuses to
> start with it enabled when `NODE_ENV=production`.

> Set production values in the Railway dashboard, not in a committed file. `backend/.env` and `backend/.env.*` are gitignored and never deployed.

> **IPv4 only:** Railway does not support outbound IPv6. Use Supabase's IPv4 connection string for `DATABASE_URL`. See [Railway Outbound Networking](https://docs.railway.com/networking/outbound-networking).

### 2. Frontend Service

1. Create a new service in Railway
2. Connect the same GitHub repository
3. Set the **Root Directory** to `frontend` in Railway service settings
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables:
   - `VITE_API_URL` - URL of your backend service (e.g., `https://your-backend.railway.app`)
   - `VITE_SUPABASE_URL` - Supabase project URL, for job-hunter sign-in
   - `VITE_SUPABASE_ANON_KEY` - Supabase anon key, for job-hunter sign-in

### 3. Apply the Schema to the Remote Database

The schema must exist before the backend can serve requests. From your machine:

```bash
cd backend
pnpm run db:reset -- --remote
```

This drops everything in the `public` schema and re-applies it from `src/db/schema/`. The
Supabase-managed schemas (`auth`, `storage`, `graphql_public`) are left alone, so Supabase Auth
users survive.

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

To only apply the schema without dropping anything, use `pnpm run db:push` with
`DOTENV_CONFIG_PATH=.env.remote`.

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
