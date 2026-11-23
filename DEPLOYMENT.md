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
is a static SPA: Railpack builds it and serves `frontend/dist` with Caddy.

Before deploying, complete the local setup steps in `SETUP.md` (install dependencies and configure environment variables). The owner's background (resume and supporting documents) is uploaded on the Knowledge page once the knowledge service is deployed.

## Node Version

The backend needs **Node 26** (the current LTS line, supported well past Node 22's April 2027
end of life). The root `package.json` declares it:

```json
"engines": { "node": ">=26 <27" }
```

22.12 is the lowest Node with `require(esm)` on by default, and is the lower bound
`runtimeDependencies.test.ts` enforces; the declared range (`>=26 <27`) is stricter. The backend
compiles to CommonJS, and `puppeteer` (25+) is ESM only, so on anything older than 22.12 the
backend crashes on startup with `ERR_REQUIRE_ESM`. Everything (CI, the image, Railpack) runs 26.

The backend image gets its Node version from the base image tag in `backend/Dockerfile`
(a `node:26.x-bookworm-slim` tag, pinned by digest), not from `engines`. Keep the two in
agreement: the tag must satisfy `engines.node`. Dependabot bumps the tag and its digest together
weekly and is told to ignore Node major versions (`.github/dependabot.yml`), so it stays on 26
until a deliberate major change.

Railpack builds both the frontend and the knowledge service (`.railway/railway.ts` sets the
`RAILPACK` builder for knowledge), and both read the root `engines.node` and install a matching
version. Confirming that Railpack resolves Node 26 for each is part of the Railway PR-environment
check.

> Node 18 crashes the backend on startup with `ERR_REQUIRE_ESM`. The
> `content-disposition` package that `@fastify/static` depends on is ESM only,
> and Node 18 cannot `require()` an ES module. The dependency is pinned to a
> CommonJS release through a pnpm override in `pnpm-workspace.yaml`. That override
> no longer makes older runtimes work on its own, because `puppeteer` is now ESM
> only too. Node 26 is the supported version and the one CI tests.
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
   `/app/backend`, so commands need no `cd`: the start command is
   `env -u DATABASE_MIGRATION_URL pnpm start`, and the
   pre-deploy command is `pnpm db:deploy`, a package script (pnpm runs scripts in a shell).
   Write any new command for this service, such as a cron command, the same way. Running from
   `backend/` still uses the root `packageManager` (`backend/package.json` has none, so corepack
   walks up to `/app/package.json`), so build and runtime use the same pnpm version.
   The start command is prefixed with `env -u DATABASE_MIGRATION_URL`, so the server never holds
   the table owner's connection (see [Database roles](#database-roles)); `env` replaces itself
   with pnpm, so no process keeps the variable. The runtime
   stage prefetches its own copy into `COREPACK_HOME` at build time, and fails the build if the
   version it resolves differs from the root pin.
   The image sets `NODE_ENV=production`, which arms the guard that refuses to start with
   `AUTH_DEV_BYPASS` set.
3. Set environment variables on the service. `.railway/railway.ts` lists each secret as
   `preserve()`, which keeps the value set in Railway, so a new variable has to be added there as
   well or the next apply deletes it:
   - `DATABASE_URL` - PostgreSQL connection string for the backend's **runtime role**, which reads and writes the job hunter's rows and owns no table (see [Database roles](#database-roles))
   - `DATABASE_MIGRATION_URL` - PostgreSQL connection string for the **table owner** (`postgres`), used only by the pre-deploy command. The start command removes it from the server's environment
   - `PORT` - Port (Railway sets this automatically)
   - `NODE_ENV` - Set to `production`
   - `MINIMAX_API_KEY` - MiniMax API key
   - `MINIMAX_API_KEY_SECONDARY` - Optional MiniMax key used for one retry when the primary request receives HTTP 429
   - `RESEND_API_KEY` - Resend API key (contact form)
   - `RESEND_FROM_EMAIL` - Sender address for outbound mail. Must be on a domain verified in Resend, e.g. `no-reply@auth.your-domain.dev`
   - `RESEND_FROM_NAME` - Optional display name shown next to the sender address
   - `CONTACT_TO_EMAIL` - Where contact form messages are delivered. Unset, `/contact` answers 503. Listed as `preserve()` in `railway.ts`, so set it in Railway before the apply that adds it
   - `CORS_ORIGINS` - **Required in production.** Comma-separated browser origins allowed to call the API, e.g. `https://ray-manguino.dev,https://six7swe.up.railway.app` (scheme and host, no path). The literal lives in `.railway/railway.ts`, so an apply sets it. Unset or invalid makes the server refuse to start rather than allow every origin. Only `NODE_ENV=development` or `test` allows every origin
   - `SUPABASE_URL` - Supabase project URL; the JWKS endpoint is derived from it. Required for the job-hunter routes
   - `SUPABASE_JWKS_URL` - Optional explicit JWKS endpoint
   - `JOB_REFRESH_STALE_MINUTES` - Optional; how long a refresh may run before it is considered abandoned (default 30)
   - `OWNER_AUTH_ID` - The knowledge base owner's Supabase auth user id; the same value as on the knowledge service. Only this user gets the Knowledge page (`/hunter/knowledge`); everyone else gets 403 on `/knowledge/*`
   - `KNOWLEDGE_URL` - Written in `railway.ts` as `http://six7sweknowledge.railway.internal:3100`, the knowledge service's private address. **Required in production** with `KNOWLEDGE_SERVICE_KEY`: chat, the fit check, `/resume` and the job hunter all retrieve from the knowledge service, and the server refuses to start without them
   - `KNOWLEDGE_SERVICE_KEY` - The knowledge service's `KNOWLEDGE_SERVICE_KEY` (same value); opens retrieval, `/version` and `/resume.pdf`
   - `KNOWLEDGE_OWNER_KEY` - The knowledge service's `KNOWLEDGE_OWNER_KEY` (same value). The backend sends it to the service only after checking the caller is the owner

> `AUTH_DEV_BYPASS` must **not** be set in production. The server refuses to
> start with it enabled when `NODE_ENV=production`.

> `RESEND_FROM_EMAIL` is required for the contact form. The backend refuses to
> send mail without it and answers `/contact` with a 500, because the
> Resend shared sender (`onboarding@resend.dev`) only delivers to the account
> owner and would silently drop every message.

> Set production values in the Railway dashboard, not in a committed file. `backend/.env` and `backend/.env.*` are gitignored and never deployed.

> **IPv4 only:** Railway does not support outbound IPv6. Use Supabase's IPv4 connection string for `DATABASE_URL`. See [Railway Outbound Networking](https://docs.railway.com/networking/outbound-networking).

#### Database roles

Anything that compromises the `--no-sandbox` scraper Chrome can read the server's environment, so
`DATABASE_URL` connects as a runtime role that reads and writes rows but owns nothing (no DDL, no
`TRUNCATE`, no turning RLS off). The owner (`postgres`) connects only through
`DATABASE_MIGRATION_URL`, for `db:migrate`, `db:secure` and `db:reset`. The fallback to
`DATABASE_URL` is local only: with `--remote` or `NODE_ENV=production` the scripts fail without
`DATABASE_MIGRATION_URL` or when both URLs name the same role, and the server refuses to start if
its role is a superuser, bypasses RLS, belongs to `postgres` or owns a `public` table. Chrome
itself gets only `PATH`, `HOME`, locale, temp and font variables
(`services/jobFetchers/browser.ts`).

`db:secure` provisions the role from `DATABASE_URL` (user `six7swe_app.<project-ref>` on the
pooler means role `six7swe_app`), in one transaction: create it if missing, set the URL's
password (as a SCRAM verifier), check it, roll back if the check fails. The check rejects
reserved names (`pg_*`, `supabase_*`, `anon`, ...), passwords under 32 characters, and a role
that is a superuser, bypasses RLS, can create roles or databases or replicate, is a member of any
role, owns any object in `public`, or can create there. It then grants row access, one RLS policy
per table for that role, and default privileges for later tables.

Provisioning on Railway (to rotate the password, steps 1 and 2 with a new password):

1. Generate the password: `openssl rand -hex 32` (URL-safe). The URL is the only copy.
2. In the backend's variables, stage both changes together: `DATABASE_MIGRATION_URL` = the
   current owner URL, and `DATABASE_URL` =
   `postgresql://six7swe_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
3. Apply `.railway/railway.ts` ([Changing Railway config](#changing-railway-config)) and deploy
   this change. The pre-deploy creates the role before the server starts; its log says
   `The backend connects as six7swe_app`. A deploy of this code without the variables fails in
   pre-deploy and leaves the old deployment serving.

A cron or one-off command in the backend image should be prefixed with
`env -u DATABASE_MIGRATION_URL` like the start command, unless it is a migration script.

### 2. Frontend Service

The `frontend` service in `.railway/railway.ts` builds with Railpack. Railpack runs
`pnpm install` at the workspace root, then the build command `cd frontend && pnpm build`.

The service has **no start command**. `RAILPACK_SPA_OUTPUT_DIR=frontend/dist` tells Railpack to
serve that directory as a static site with Caddy, in a runtime image that holds only the built
files (no Node, no `vite`). Caddy falls back to `index.html` for unknown paths, so React Router
deep links such as `/hunter/knowledge` load. Caddy listens on `$PORT`, which is pinned to `8080`
in `.railway/railway.ts`, and the `ray-manguino.dev` domain targets that port. Do not add a start
command: it switches Railpack back to a Node image. `vite preview` is for local checks only
(`pnpm --filter @six7swe/frontend preview`).

Railpack adds Chrome's system packages to Node images that depend on `puppeteer`. Only the
backend does, and the backend builds from its Dockerfile. The frontend's runtime image is Caddy
plus the built files, so those packages should not be in it; check the first deploy's build log.

First-deploy checks for the static setup:

- The build log shows Railpack in SPA mode (a Caddy runtime stage), not a Node start command. The
  root `package.json` has a `start` script for the backend; Railpack checks
  `RAILPACK_SPA_OUTPUT_DIR` before looking at start scripts, but confirm the deployed image is
  Caddy and not a Node process booting the backend.
- Caddy serves from `frontend/dist`: the site loads, and `/hunter/knowledge` opened directly
  returns the app, not a 404.
- `VITE_API_URL`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are available at **build**
  time (Vite inlines them): the network tab shows requests to the backend, and sign-in works.
- Both `ray-manguino.dev` and `six7swe.up.railway.app` answer, on port 8080.

1. Leave the **Root Directory** at the default (`/`), the repository root, so Railpack sees the
   pnpm workspace and the lockfile.
2. Set environment variables (also listed in `.railway/railway.ts`):
   - `PORT` - `8080`, the port Caddy listens on and the custom domain targets
   - `RAILPACK_SPA_OUTPUT_DIR` - `frontend/dist`
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

The database holds only the job hunter's tables. The portfolio's background lives in the
knowledge service, which keeps its own schemas and is not touched by the reset.

> Take a backup first (`pg_dump "$DATABASE_MIGRATION_URL" -Fc -f backup.dump`) if the hosted database holds
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

> Railway PR environments inherit this command, and `--remote` points it at
> `DATABASE_MIGRATION_URL` (or `DATABASE_URL` when that is unset). Do not enable PR environments
> unless both point at a database other than the hosted one.

Both steps connect as the table owner through `DATABASE_MIGRATION_URL` (see
[Database roles](#database-roles)), and `db:secure` also provisions the runtime role that
`DATABASE_URL` names.

The two steps are in that order on purpose. `db:migrate` applies the migrations, and a table that
a migration created starts out with the default Supabase grants, so `db:secure` has to run after
it to turn row level security back on and revoke the public grants. `docs/SECURITY.md` describes
what that does and why it matters.

`db:migrate` does not prompt, so it is safe to run unattended.

> A migration that drops a table or a column is applied to the hosted database automatically.
> Take a backup before deploying one.

`backend/.env.remote` holds the remote `DATABASE_URL` and `DATABASE_MIGRATION_URL` and is
gitignored. Commands run from your machine with `--remote` (`db:migrate`, `db:secure`,
`db:reset`) need `DATABASE_MIGRATION_URL` there too, or they connect as the runtime role and
fail on the first DDL statement.

### 4. Resume PDF

The frontend downloads the resume from the backend via `GET /resume`, and shows the Resume card only after a `HEAD /resume` probe on page load answers 2xx (it stays hidden on 404, 5xx or a network error). The backend serves only the knowledge service's primary resume (`/resume.pdf`), cached by the corpus `/version` (re-read every 30 s), so a new primary resume is served within about 30 s. There is no local or `public/` fallback: upload a PDF through the owner's knowledge page and mark it primary. `GET /resume` returns 404 (logged at `warn` as `Resume not found`) when there is no primary resume, or when `KNOWLEDGE_URL` / `KNOWLEDGE_SERVICE_KEY` are not set.

> Supabase Storage is **not** currently read by the backend — `@supabase/supabase-js` is not a dependency and no code path reads `SUPABASE_URL` or `SUPABASE_SECRET_KEY`. Serving the resume from Storage requires implementing that path first.

### 5. Update the Background and Contact Details

1. Upload the resume and supporting documents on the owner's Knowledge page (`/hunter/knowledge`). Chat, the fit check and the job matcher answer from them through retrieval; an upload or delete reaches every backend replica within about 30 s (the caches are keyed to the corpus `/version`), with no restart
2. The landing page's content and contact details are static: edit `frontend/src/content/`. The contact form delivers to `CONTACT_TO_EMAIL`

### 6. Job Refreshes (optional)

The job-hunter can trigger a refresh over HTTP, but a refresh started that way
does not survive a backend restart. For scheduled refreshes, add a **Cron** to
the backend service in Railway. The cron runs inside the backend image, from `/app/backend`,
without a shell. Strip the owner's connection the way the start command does (`jobs:refresh`
also drops it from its own environment before it launches Chrome, and warns that it was set):

```bash
env -u DATABASE_MIGRATION_URL pnpm jobs:refresh -- --profile 1
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
- The runtime stage runs as the unprivileged `node` user (`USER node`). `/app` is chowned to
  `node` and the app is copied with `COPY --chown=node:node`. `COREPACK_HOME` points at
  `/home/node/.cache/corepack`, where `corepack install` prefetches pnpm, so nothing is fetched
  at container start. The pre-deploy command and the cron run in this image as `node` too, so
  they may write under `/app`, `node`'s home, or the temp directory, and nowhere else.
- Chrome's sandbox cannot start on Railway, which gives containers no user namespaces (or
  `SYS_ADMIN`), so `services/jobFetchers/browser.ts` launches Chrome with `--no-sandbox`.
  Non-root limits what a compromised page can change in the container, but it does not keep
  backend secrets away from a compromised Chrome: the same user can read the Node process's
  environment. That environment's `DATABASE_URL` connects as a role that owns no table
  ([Database roles](#database-roles)), and the owner's `DATABASE_MIGRATION_URL` is stripped by
  the start command. The rest of the scraper and secret isolation is tracked in #127.

If a refresh fails with `Could not find Chrome`, check the build log for the `browsers:install`
step. A failure that names a missing `.so` file is a library missing from the runtime stage; add
an `apt-get install` for it there.

### 7. Running the Backend Image Locally

Build from the repository root, which is the build context Railway uses:

```bash
docker build -f backend/Dockerfile -t six7-backend .
```

`.dockerignore` keeps `node_modules`, `.env` files, build output, the Chrome cache and any
leftover local copy of the retired portfolio seed data out of the build context. Railway builds from git, so gitignored files
never reach its build either.

Check that the image runs as `node`, owns `/app`, and that pnpm and tsx (used by the pre-deploy
command and the cron) resolve without a download:

```bash
docker run --rm --network none six7-backend   sh -c 'id -un && stat -c "%U" /app /app/backend && pnpm --version && pnpm exec tsx --version'
```

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

### Rolling Back the Static Frontend

To go back to `vite preview` for the frontend (still on Railpack), in `.railway/railway.ts`:

1. Restore the start command `cd frontend && pnpm preview --host`.
2. Point the `ray-manguino.dev` domain, and the generated `six7swe.up.railway.app` domain under
   `networking.serviceDomains`, back at port `4173`.
3. Remove the `PORT` and `RAILPACK_SPA_OUTPUT_DIR` variables.
4. Restore `preview.allowedHosts` in `frontend/vite.config.ts` from git history: the last commit
   that has it is `7494644`, where the block was `preview: { port: 4173, host: true,
   allowedHosts: ['ray-manguino.dev', 'six7swe.up.railway.app'] }`
   (`git show 7494644:frontend/vite.config.ts`).

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

## Deploy Order for Knowledge Contract Changes

A change to the wire contract between the services (`packages/knowledge-types`) must go live in
this order:

1. The knowledge service, with its migration (its pre-deploy step applies it)
2. The backend
3. The frontend

Railway does not enforce this order. A push to `main` redeploys every service it touches, in
parallel. So a contract change must keep the public portfolio working against the previous release
of the other side, and its PR says what breaks while the services are mismatched. After the merge,
check that the knowledge deploy and its pre-deploy migration succeeded. If they failed, the backend
and frontend stay mismatched until the knowledge service is fixed and redeployed.

The removal of the published profile (#213) is one of these:

- The backend no longer calls `/profile/published`, so it works against either knowledge release.
  Its migration `0002_drop_portfolio` drops the portfolio tables on deploy; take a backup first if
  you want to keep them.
- The knowledge service's migration `0008_drop_profiles` drops `knowledge.profiles`. A backend or
  frontend still on the previous release loses only the profile review on the Knowledge page
  (its `/knowledge/profile*` calls answer 404) until it is deployed too.
- Set `CONTACT_TO_EMAIL` on the backend before it goes live, or the contact form answers 503.

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

> **Windows:** `railway/iac` 3.17 checks the CLI version by running `railway --version` through
> `execFileSync`, without a shell. The npm and pnpm installs ship a `railway.cmd`, a `railway.ps1`
> and a `railway` shell script, and Windows cannot spawn any of those without a shell, so the check
> throws "This version of railway/iac requires Railway CLI 5.42.1 or newer" even on a current CLI
> (5.74.0).
>
> The fix is the same in every shell: put the directory holding `railway.exe` on `PATH` ahead of
> the shims. The directory is `$(npm root -g)\@railway\cli\bin`.
>
> The SDK resolves the CLI with `execFileSync(process.env._ || "railway")`, so what `_` holds
> decides which one runs, and that differs by shell:
>
> - In PowerShell and cmd.exe, `_` is not set, so the SDK falls back to the bare name `railway`
>   and Windows resolves it against `PATH`.
> - In Git Bash, bash sets `_` to the command it just resolved, so `_` points at whichever
>   `railway` came first on `PATH`.
>
> Prepending the executable's directory settles both: in bash, `railway` resolves to that
> directory and `_` follows it; in PowerShell and cmd.exe, the fallback name resolves to the
> executable instead of the shim.
>
> PowerShell:
>
> ```powershell
> $env:PATH = "$(npm root -g)\@railway\cli\bin;$env:PATH"
> railway config plan    # now works
> ```
>
> cmd.exe (the `for /f` capture needs `%%i` instead of `%i` inside a batch file):
>
> ```cmd
> for /f "delims=" %i in ('npm root -g') do set "PATH=%i\@railway\cli\bin;%PATH%"
> railway config plan    # now works
> ```
>
> Git Bash (use `cygpath -u` on the result: `npm root -g` prints a Windows path, and its `C:` drive
> letter would otherwise split the `PATH` entry):
>
> ```bash
> export PATH="$(cygpath -u "$(npm root -g)")/@railway/cli/bin:$PATH"
> railway config plan    # now works
> ```
