# Setup Guide

## Prerequisites

- Node.js 18+ and `pnpm` installed
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- Docker Desktop running (the Supabase CLI starts Postgres in a container)

## Initial Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Start the Local Database

Run from the repo root:

```bash
supabase start
```

This starts Postgres on `127.0.0.1:54322`, the REST API on `54321`, and Studio on `54323`. The local
stack provides Supabase Auth, which the job-hunter signs in with.

> The schema is **not** managed by the Supabase CLI. It is owned by Drizzle
> (`backend/src/db/schema/`); migrations are generated from it with
> `pnpm run db:generate` and applied with `pnpm run db:migrate`.

### 3. Backend Setup

```bash
cd backend
cp .env.example .env
# Edit .env and add your API keys (MiniMax, Resend)
```

Required environment variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (local Supabase by default) |
| `MINIMAX_API_KEY` | AI endpoints (`/chat`, `/fitcheck`) |
| `RESEND_API_KEY` | Contact form delivery |
| `SUPABASE_URL` | Auth provider for the job-hunter (`/job-hunt/*` routes) |

For local development point `SUPABASE_URL` at the local stack
(`http://127.0.0.1:54321`) so the API verifies tokens issued by the local Auth
service. It must match the frontend's `VITE_SUPABASE_URL`.

Optional variables (`PORT`, `PORTFOLIO_DATA_SOURCE`, `PORTFOLIO_CACHE_TTL_MS`, `MCP_*`, `SUPABASE_JWKS_URL`, `AUTH_DEV_BYPASS`, `JOB_REFRESH_STALE_MINUTES`, and `OWNER_AUTH_ID` / `KNOWLEDGE_URL` / `KNOWLEDGE_OWNER_KEY` for the Knowledge page) are documented in [`backend/.env.example`](backend/.env.example).

Set `MINIMAX_API_KEY_SECONDARY` optionally to retry once with a second key when the primary request receives HTTP 429.

> Only one `DATABASE_URL` may be active in `.env` — dotenv resolves duplicates by last occurrence wins. JSON values must be on a single line.

### 4. Apply the Schema and Seed Data

```bash
cd backend
pnpm run db:migrate    # apply the migrations
pnpm run db:seed       # users and search profiles
```

### 5. Frontend Setup

```bash
cd frontend
cp .env.example .env
```

The frontend will automatically proxy API requests to the backend in development.

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_URL` | No | Backend API URL. Leave unset to use the `/api` dev proxy. |
| `VITE_SUPABASE_URL` | For `/hunter` | Supabase project URL. Must match the backend's `SUPABASE_URL`. |
| `VITE_SUPABASE_ANON_KEY` | For `/hunter` | Supabase anon (publishable) key. |

> "Leave unset" applies to `VITE_API_URL` **only**. The two `VITE_SUPABASE_*`
> variables are required by the `/hunter` pages — without them the app shows
> *"Authentication is not configured"* and the job-hunter cannot be used at
> all. The public portfolio works fine without them.

Vite reads `VITE_*` variables once at startup, so restart `pnpm dev:frontend`
after creating or editing `frontend/.env`.

### 6. Portfolio / Resume

1. Copy `backend/scripts/portfolio-data.example.json` to `backend/scripts/portfolio-data.json`
2. Edit `portfolio-data.json` with your profile data (name, email, resume text, etc.)
3. Run `pnpm run db:seed-portfolio` from `backend/`
4. Copy your resume PDF to `backend/public/` (e.g. `resume.pdf`), or set `PORTFOLIO_DATA_SOURCE=mcp` and configure MCP in `backend/.env` so portfolio and resume are served from your MCP server (see `backend/.env.example`).

### 7. Job Hunter (optional)

The job-hunter needs a Supabase project with Auth enabled. **The frontend and
the backend must point at the same project**, because the API verifies the
tokens that project issues.

1. Add `SUPABASE_URL` to `backend/.env` (the JWKS endpoint is derived from it).
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to `frontend/.env`.
3. Create a user in Supabase Auth, then sign in at `http://localhost:5173/hunter/login`.
4. Restart both dev servers if you changed an env file.

#### Running it entirely against the local Supabase stack

The local stack ships Auth as well, so the whole flow works offline:

```bash
supabase start     # from the repo root
supabase status    # prints the publishable and secret keys
```

Point both sides at the local project:

- `backend/.env` → `SUPABASE_URL=http://127.0.0.1:54321`
- `frontend/.env` → `VITE_SUPABASE_URL=http://127.0.0.1:54321` and
  `VITE_SUPABASE_ANON_KEY=<publishable key from `supabase status`>`

Create the sign-in user once. Use `john@example.com` so the API matches the
seeded `users` row and the seeded profiles show up:

```bash
curl -X POST "http://127.0.0.1:54321/auth/v1/admin/users" \
  -H "apikey: <secret key>" \
  -H "Authorization: Bearer <secret key>" \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"<your password>","email_confirm":true}'
```

Then sign in at `http://localhost:5173/hunter/login` with that email.

> `AUTH_DEV_BYPASS=true` in `backend/.env` removes the need for a token on
> **API calls only** — it impersonates the seeded user and is refused when
> `NODE_ENV=production`. The `/hunter` pages still require `VITE_SUPABASE_*`,
> so the UI keeps asking you to sign in.

#### Hosted Supabase project: mail and redirects

The local stack has no mail provider, so sign-up never sends a confirmation
email (`enable_confirmations = false` in `supabase/config.toml`). A hosted
project behaves differently and needs these settings in the Supabase dashboard
(**Authentication** section):

| Setting | Value | Why |
|---|---|---|
| **Email → SMTP Settings** | Custom SMTP | The built-in provider is capped at 2 emails/hour, shared by every project on it. Sign-up then fails with `email rate limit exceeded`. |
| **Email → SMTP Sender** | `no-reply@auth.<your-domain>` | Must be on a domain verified in the mail provider. |
| **URL Configuration → Site URL** | `https://<your-app-host>` | Where Supabase sends the browser when a link has no valid `redirect_to`. |
| **URL Configuration → Redirect URLs** | `https://<your-app-host>/hunter/login` | Where the confirmation link returns to. |

The SMTP host, port and credentials come from the mail provider. For Resend:
host `smtp.resend.com`, port `465`, username `resend`, password = the API
key.

> The **Site URL** is what a broken confirmation link falls back to. If it is
> left at the default (`http://localhost:3000`), clicking "Confirm your email"
> appears to do nothing, because the browser is redirected off the app.

Once custom SMTP is configured, the hourly email quota becomes adjustable
under **Authentication → Rate Limits → Emails sent per hour**.

The sender address is also read by the backend, so both sides agree on one
identity. Set it in `backend/.env`:

```bash
RESEND_FROM_EMAIL=no-reply@auth.<your-domain>
RESEND_FROM_NAME=<display name>
```

The seed data creates two users and three search profiles. A profile's
`location` is a **LinkedIn numeric region id** (for example `105149290` for
Ontario), not a city name — a city name produces a search that silently
returns nothing.

To run a refresh from the command line:

```bash
cd backend
pnpm run jobs:refresh -- --profile 1 --wait
```

Refreshes scrape with a headless Chrome. Install it once per checkout, and again after
a puppeteer upgrade:

```bash
cd backend
pnpm run browsers:install
```

Chrome goes into `backend/.cache/puppeteer` (set in `backend/.puppeteerrc.cjs`), not
`~/.cache/puppeteer`. A refresh that fails with `Could not find Chrome` means this step
was skipped.

### 8. Run Development Servers

**Terminal 1 - Backend:**
```bash
pnpm dev
```

**Terminal 2 - Frontend:**
```bash
pnpm dev:frontend
```

The frontend will be available at http://localhost:5173
The backend will be available at http://localhost:3000

## Local vs Remote Database

The environment is selected by which file dotenv loads, not by commenting lines out. `backend/.env` points at the local database; `backend/.env.remote` points at the remote one.

```bash
# Local database (default)
pnpm dev
pnpm run db:migrate

# Remote database
pnpm run db:migrate -- --remote
```

Both files are gitignored. Only `backend/.env.example` is tracked.

## Resetting the Database

The schema in `backend/src/db/schema/` is the source of truth. Migrations are generated from
it and applied in order. To rebuild a database from scratch, drop everything in the `public`
schema and replay the migrations:

```bash
cd backend
pnpm run db:reset                # local
pnpm run db:reset -- --remote    # hosted
pnpm run db:seed-portfolio       # portfolio profile and content sections
```

The Supabase-managed schemas (`auth`, `storage`, `graphql_public`) are left alone, so Supabase
Auth users survive a reset.

## Updating Resume/Portfolio Data

Update the `portfolio_profile` table in the database, or edit `backend/scripts/portfolio-data.json` (copy from `portfolio-data.example.json` if needed) and re-run `pnpm run db:seed-portfolio` from `backend/`. The AI chat assistant uses `full_resume_text` to answer questions.

> The portfolio payload is cached in memory for `PORTFOLIO_CACHE_TTL_MS`
> (default 10 minutes), so chat may keep serving the previous text until the
> cache expires.

## Deployment

For deploying this project to Railway, including service configuration and production environment variables, see `DEPLOYMENT.md`.
