# Railway Deployment Guide

This monorepo is configured to deploy on Railway with separate services for frontend and backend.
Both services are declared in `.railway/railway.ts` (Railway Infrastructure as Code).

Before deploying, complete the local setup steps in `SETUP.md` (install dependencies, configure environment variables, and seed your portfolio/resume data).

## Node Version

The backend needs **Node 22.12 or later** on the 22 line. The root `package.json` declares it:

```json
"engines": { "node": ">=22.12 <23" }
```

22.12 is the first release where `require(esm)` is on by default. The backend compiles to
CommonJS, and `puppeteer` (25+) is ESM only, so on anything older the backend crashes on
startup with `ERR_REQUIRE_ESM`.

Railway's Nixpacks builder reads that field and installs the matching Node
version. Without it the builder falls back to Node 18, which is end of life and
too old for some dependencies.

> Node 18 crashes the backend on startup with `ERR_REQUIRE_ESM`. The
> `content-disposition` package that `@fastify/static` depends on is ESM only,
> and Node 18 cannot `require()` an ES module. The dependency is pinned to a
> CommonJS release through a pnpm override in `pnpm-workspace.yaml`. That override
> no longer makes older runtimes work on its own, because `puppeteer` is now ESM
> only too. Node 22.12+ is the supported version and the one CI tests.
>
> `backend/src/__tests__/runtimeDependencies.test.ts` fails the build if the
> `engines.node` floor drops below 22.12, or if a dependency cannot be loaded with
> `require()`, so this cannot regress silently.

## Setup Instructions

### 1. Backend Service

The `backend` service in `.railway/railway.ts` sets the source repository, the Nixpacks
builder, the build, start and pre-deploy commands, the restart policy and the watch path.
`railway config apply` creates the service if it does not exist (see
[Changing Railway config](#changing-railway-config)).

1. Leave the **Root Directory** at the default (`/`), the repository root. The commands
   already `cd` into `backend`, so a root directory of `backend` would make them fail.
2. Set environment variables on the service. `.railway/railway.ts` lists each secret as
   `preserve()`, which keeps the value set in Railway, so a new variable has to be added there as
   well or the next apply deletes it:
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

The `frontend` service in `.railway/railway.ts` follows the same pattern.

1. Leave the **Root Directory** at the default (`/`), the repository root, for the same reason as
   the backend service.
2. Set environment variables (also listed in `.railway/railway.ts`):
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

```ts
deploy: {
  preDeployCommand: ['cd backend && pnpm db:migrate -- --remote && pnpm db:secure -- --remote'],
},
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

**Production currently has no resume** (#104): no PDF reaches the deployed image, so `GET /resume`
returns 404. The site handles this. `GET /portfolio` reports `resumeAvailable`, using the same
lookup as `/resume`, and the Landing page shows the Resume card only when it is true. Each miss
is logged at `warn` as `Resume not found`, with the filename and directory it checked, so it
shows up in the Railway logs. The planned fix serves the PDF from the knowledge service (#86).

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

#### Chrome for the job scraper

The LinkedIn fetcher drives a headless Chrome through puppeteer. pnpm does not run
puppeteer's postinstall, so the Railway build installs Chrome explicitly:

```bash
apt-get update && cd backend && pnpm install && pnpm run browsers:install --install-deps && pnpm build
```

- `backend/.puppeteerrc.cjs` sets puppeteer's cache to `backend/.cache/puppeteer`. Chrome
  is downloaded inside the app directory, so it ships in the deployed image, and the
  runtime looks in the same place. The default, `~/.cache/puppeteer`, is not reliable
  across the build and the running container.
- `--install-deps` installs the shared libraries Chrome needs (nss, atk, gbm, cups, fonts
  and others) with `apt-get`, from the `deb.deps` list that ships with each Chrome build.
  It does not refresh the package index itself, so `apt-get update` runs first.
- The browser version follows the installed puppeteer release. A puppeteer upgrade picks
  up the new Chrome on the next deploy.

If a refresh fails with `Could not find Chrome`, check the build log for the
`browsers:install` step. A failure that names a missing `.so` file is a library that
`--install-deps` did not cover.

## Monorepo Structure

```
six7swe/
├── .railway/
│   └── railway.ts    # Railway services (Infrastructure as Code)
├── backend/          # Backend service (Fastify API)
│   └── public/       # Static files (resume.pdf)
├── frontend/         # Frontend service (React app)
└── package.json      # Root workspace config
```

## Watch Paths

`.railway/railway.ts` sets a watch path per service (`/backend/**` and `/frontend/**`), so a
change in one service does not rebuild the other.

## Changing Railway config

Railway does not read `.railway/railway.ts` during deploys. Code pushes to `main` deploy as usual,
but a change to the file itself (a command, a variable, a domain, a new service) reaches Railway
only when you apply it. This is done by hand; CI only type-checks the file.

One-time setup: install the Railway CLI (5.63 or later), then `railway login` and `railway link`
to the six7swe project and the production environment.

```bash
railway config plan    # read-only: what would change
railway config apply   # plans again, asks for confirmation, then applies
```

An apply is **declarative**: a service, variable or domain that exists in Railway but not in the
file is deleted. Read the plan before applying, and stop if it shows a destructive entry you did
not intend. In particular, every variable set on a service must appear in the file, with
`preserve()` for secrets. Never write a secret value into the file.

After an apply, `railway config plan` should report no changes.

> **Windows:** `railway/iac` 3.17 checks the CLI version by running `railway --version` without a
> shell, which cannot run the `railway.cmd` shim that npm and pnpm install, so evaluation fails
> with "requires Railway CLI 5.42.1 or newer" even on a newer CLI. The SDK uses `$_` when it is
> set, so point it at the real binary first (PowerShell):
>
> ```powershell
> $env:_ = "$(npm root -g)\@railway\cli\bin\railway.exe"
> ```
