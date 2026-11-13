# Railway Deployment Guide

This monorepo is configured to deploy on Railway with separate services for the frontend, the
backend and the knowledge service. All of them are declared in `.railway/railway.ts` (Railway
Infrastructure as Code).

| Service   | Builder    | Build definition                                     |
| --------- | ---------- | ---------------------------------------------------- |
| backend   | Dockerfile | `backend/Dockerfile`, built from the repository root |
| frontend  | Railpack   | `cd frontend && pnpm build`                          |
| knowledge | Railpack   | `cd knowledge && pnpm build`                         |

The knowledge service's setup, variables and first-deploy checklist are in
`knowledge/README.md`, "Deploy".

The backend uses a Dockerfile because the job scraper launches Chrome, which needs system
libraries at runtime (see [Chrome for the job scraper](#chrome-for-the-job-scraper)). The frontend
is a plain Vite build that Railpack handles with no extra files.

Before deploying, complete the local setup steps in `SETUP.md` (install dependencies, configure environment variables, and seed your portfolio/resume data).

## Node Version

The backend needs **Node 22.12 or later** on the 22 line. The root `package.json` declares it:

```json
"engines": { "node": ">=22.12 <23" }
```

22.12 is the first release where `require(esm)` is on by default. The backend compiles to
CommonJS, and `puppeteer` (25+) is ESM only, so on anything older the backend crashes on
startup with `ERR_REQUIRE_ESM`.

The backend image gets its Node version from the base image tag in `backend/Dockerfile`
(a `node:22.x-bookworm-slim` tag), not from `engines`. Keep the two in agreement: the tag must
satisfy `engines.node`. Dependabot bumps the tag weekly and is told to ignore Node major
versions (`.github/dependabot.yml`), so it stays on 22.

Railpack, which builds the frontend, reads `engines.node` and installs a matching version.

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

The `backend` service in `.railway/railway.ts` sets the source repository, the Dockerfile
builder and its path (`backend/Dockerfile`), the start and pre-deploy commands, the restart
policy and the watch paths.
`railway config apply` creates the service if it does not exist (see
[Changing Railway config](#changing-railway-config)).

1. Leave the **Root Directory** at the default (`/`), the repository root. It is the
   Dockerfile's build context: the image needs the root `package.json`, `pnpm-lock.yaml`,
   `pnpm-workspace.yaml` and `tsconfig.base.json`, so a root directory of `backend` would make
   the build fail.
2. Railway runs a Dockerfile service's start command in exec form, without a shell, so a
   command with `cd` or `&&` does not work there. The image's working directory is
   `/app/backend`, so commands need no `cd`: the start command is `pnpm start`, and the
   pre-deploy command is `pnpm db:deploy`, a package script (pnpm runs scripts in a shell).
   Write any new command for this service, such as a cron command, the same way. Running from
   `backend/` also means pnpm is the version `backend/package.json` pins, which the image
   fetches at build time.
   The image sets `NODE_ENV=production`, which arms the guard that refuses to start with
   `AUTH_DEV_BYPASS` set.
3. Set environment variables on the service. `.railway/railway.ts` lists each secret as
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

The `frontend` service in `.railway/railway.ts` builds with Railpack. Railpack runs
`pnpm install` at the workspace root, then the build command `cd frontend && pnpm build`. The
start command is `cd frontend && pnpm preview --host`, which serves the build on port 4173.

1. Leave the **Root Directory** at the default (`/`), the repository root, so Railpack sees the
   pnpm workspace and the lockfile.
2. Set environment variables (also listed in `.railway/railway.ts`):
   - `VITE_API_URL` - URL of your backend service (e.g., `https://your-backend.railway.app`)
   - `VITE_SUPABASE_URL` - Supabase project URL, for job-hunter sign-in
   - `VITE_SUPABASE_ANON_KEY` - Supabase anon key, for job-hunter sign-in

> Vite inlines `VITE_*` variables into the bundle at build time, not at runtime. Railpack passes
> service variables to the build, but after a builder change check that the deployed bundle
> points at the right backend: the site should load the portfolio, and the browser's network tab
> should show requests going to `VITE_API_URL`.

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
preDeploy: 'pnpm db:deploy',
```

`db:deploy` is a script in `backend/package.json`:
`pnpm db:migrate -- --remote && pnpm db:secure -- --remote`.

`preDeployCommand` runs inside the newly built backend image after the build succeeds and before
the new version starts, so the schema is in place before the code that depends on it. This is why
the image keeps dev dependencies: `db:migrate` and `db:secure` run through `tsx`. The frontend
service does not need a pre-deploy command.

> Railway PR environments inherit this command, and `--remote` points it at `DATABASE_URL`. Do
> not enable PR environments unless their `DATABASE_URL` points at a database other than the
> hosted one.

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
the backend service in Railway. The cron runs inside the backend image, from `/app/backend`,
without a shell:

```bash
pnpm jobs:refresh -- --profile 1
```

`profileId` is the id of the search profile to refresh. The command uses the
same pipeline as the HTTP trigger and records progress in `refresh_status`.

Refreshes abandoned by a crashed process are marked failed on the next backend
startup, so a stale run never blocks the next one.

#### Chrome for the job scraper

The LinkedIn fetcher drives a headless Chrome through puppeteer. Chrome needs shared libraries
(nss, atk, gbm, cups, fonts and others) that the slim Node base image does not have.
`backend/Dockerfile` has three stages:

- **base** is the Node image with corepack, which the other two start from.
- **build** installs the backend's dependencies, downloads Chrome with
  `pnpm run browsers:install`, and compiles the backend. pnpm does not run puppeteer's
  postinstall, so the download is explicit. Chrome has its own layer, before the source is
  copied, so it is downloaded again only when the dependencies change.
- **runtime** installs Chrome's libraries with `apt-get`, then copies the app from the build
  stage. The list comes from the `deb.deps` file that ships with the Chrome build puppeteer
  downloaded, the same list `browsers install --install-deps` would use, so it follows Chrome
  rather than a hand-written list. It includes `ca-certificates` and `fonts-liberation`.

The image that is built is the image that runs, so the libraries the runtime stage installs are
there when the scraper launches Chrome. A builder with a separate, slimmer runtime image
(Railpack) would drop libraries installed during its build, and Chrome would fail only when a
refresh runs, not at boot.

- `backend/.puppeteerrc.cjs` sets puppeteer's cache to `backend/.cache/puppeteer`. Chrome is
  downloaded inside the app directory, so it is copied into the runtime stage with the app, and
  the runtime looks in the same place.
- The browser version follows the installed puppeteer release. A puppeteer upgrade picks up the
  new Chrome, and its library list, on the next deploy.
- The container runs as root, and `services/jobFetchers/browser.ts` launches Chrome with
  `--no-sandbox`.

If a refresh fails with `Could not find Chrome`, check the build log for the `browsers:install`
step. A failure that names a missing `.so` file is a library missing from the runtime stage; add
an `apt-get install` for it there.

### 7. Running the Backend Image Locally

Build from the repository root, which is the build context Railway uses:

```bash
docker build -f backend/Dockerfile -t six7-backend .
```

`.dockerignore` keeps `node_modules`, `.env` files, build output, the Chrome cache and the
private portfolio data out of the build context. Railway builds from git, so gitignored files
never reach its build either.

Check that Chrome launches in the image. Do this before deploying a change to the Dockerfile or a
puppeteer upgrade:

```bash
docker run --rm six7-backend \
  node -e "require('puppeteer').launch({args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('Chrome OK'))"
```

Run the server with your local environment file:

```bash
docker run --rm -p 3000:3000 --env-file backend/.env -e PORT=3000 six7-backend
```

The image runs with `NODE_ENV=production`, so the server refuses to start if `backend/.env` sets
`AUTH_DEV_BYPASS=true`.

### Rolling Back the Builders

To go back to Nixpacks, set the service's `builder` to `NIXPACKS` in `.railway/railway.ts`,
restore its `buildCommand` and its old start and pre-deploy commands, and apply the config. The
backend's build command was
`apt-get update && cd backend && pnpm install && pnpm run browsers:install --install-deps && pnpm build`
and the frontend's `cd frontend && pnpm install && pnpm build`. Nixpacks is deprecated, so treat
this as a short-term fallback.

## Monorepo Structure

```
six7swe/
├── .railway/
│   └── railway.ts    # Railway services (Infrastructure as Code)
├── .dockerignore     # Build context filter for the backend image
├── backend/          # Backend service (Fastify API)
│   ├── Dockerfile    # Backend image (build context: repository root)
│   └── public/       # Static files (resume.pdf)
├── frontend/         # Frontend service (React app)
└── package.json      # Root workspace config
```

## Watch Paths

`.railway/railway.ts` sets watch paths per service, so a change in one service does not rebuild
the others:

- backend: `/backend/**`, plus the root files the Dockerfile reads (`/.dockerignore`,
  `/package.json`, `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/tsconfig.base.json`)
- frontend: `/frontend/**`, plus the root files its build reads (`/package.json`,
  `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/tsconfig.base.json`). Railpack installs from the
  workspace root, and `frontend/tsconfig.json` extends `tsconfig.base.json`.
- knowledge: `/knowledge/**`, plus the same root files as the frontend, for the same reasons.

A change to one of the shared root files rebuilds every service.

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
