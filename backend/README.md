# Backend - Job Application Management Platform

A modular monolith application for managing job applications with a Fastify backend and Supabase (PostgreSQL) database.

This backend lives in the `backend/` directory of the Six7SWE monorepo. See the root `README.md` for an overview of the entire project.

## Features

- ✅ User and profile queries
- ✅ Job ingestion, matching and refresh status
- ✅ PostgreSQL database integration via Drizzle ORM
- ✅ Chat, fit check and job matching grounded in knowledge-service retrieval
- ✅ AI endpoints (chat, job match, fit check) via MiniMax
- ✅ Contact form delivery via Resend
- ✅ TypeScript with Fastify framework
- ✅ Environment-based configuration
- ✅ Unit testing with Jest
- ✅ Modular architecture with services and handlers

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/six7swe.git
   cd six7swe
   ```

2. Start the local database (Supabase CLI + Docker Desktop):
   ```bash
   supabase start
   ```

3. Create the environment file and install dependencies:
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env and add your API keys
   cd ..
   pnpm install
   ```

4. Apply the schema (the job hunter's tables):
   ```bash
   cd backend
   pnpm run db:migrate
   ```

   The owner's background is not in this database: chat, the fit check, `/resume` and the job
   matcher retrieve it from the knowledge service (`knowledge/README.md`). Set `KNOWLEDGE_URL` and
   `KNOWLEDGE_SERVICE_KEY` in `.env` to use it.

5. Run the API:
   ```bash
   pnpm dev
   ```

6. Test the API:
   ```bash
   curl http://localhost:3000/
   ```

> **Prerequisites:** Node.js (LTS), `pnpm`, the [Supabase CLI](https://supabase.com/docs/guides/cli), and Docker Desktop (the Supabase CLI starts Postgres in a container).

## Environment Files

| File | Tracked | Purpose |
|---|---|---|
| `.env.example` | ✅ | Template with placeholder values |
| `.env` | ❌ | Local development. Points at the local Supabase database |
| `.env.remote` | ❌ | Copy of `.env` pointing at the remote database |

`.env` and `.env.*` are gitignored, so only `.env.example` is ever committed.

### Choosing between local and remote

The environment is selected by **which file dotenv loads**, not by commenting lines out. The server
(`src/index.ts`) and the Drizzle config use `dotenv/config`, which honours `DOTENV_CONFIG_PATH`.
The maintenance scripts take an explicit `--remote` flag instead, because they load the env file
themselves:

```bash
# Local database (default - .env)
pnpm dev
pnpm run db:migrate
pnpm run db:seed

# Remote database (.env.remote)
pnpm run db:reset -- --remote
```

> **Two rules that cause most `.env` bugs:**
> 1. **Only one `DATABASE_URL` may be active.** dotenv resolves duplicates by *last occurrence wins*, so a stale line silently overrides the intended one.
> 2. **JSON values must be on a single line.** dotenv stops parsing a value at the first newline, which turns a multi-line JSON blob into invalid JSON.

See [`.env.example`](.env.example) for the full annotated list of variables.

## Database Setup

This project uses **Supabase** (PostgreSQL) with Drizzle ORM. You can use either local Supabase for development or remote Supabase for production.

### Local Development with Supabase

1. Start local Supabase (run from the repo root):
   ```bash
   supabase start
   ```
   This boots Postgres on `127.0.0.1:54322`, the REST API on `54321`, and Studio on `54323`.

2. Configure your `.env` file in the backend directory:
   ```env
   NODE_ENV=development
   PORT=3000
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable
   ```

3. Apply the schema:
   ```bash
   cd backend
   pnpm run db:migrate
   ```

### Remote Supabase (Production)

1. Get the connection string from Supabase Dashboard → Settings → Database.

2. **Railway deployment:** Railway does not support outbound IPv6. Use Supabase’s **IPv4** connection string for `DATABASE_URL` so the backend can reach the database. See [Railway Outbound Networking](https://docs.railway.com/networking/outbound-networking).

3. Set the variables on the Railway service (not in a file):
   ```env
   NODE_ENV=production
   PORT=3000
   DATABASE_URL=your_supabase_connection_string
   ```

4. Apply the schema to the remote database:
   ```bash
   cd backend
   pnpm run db:migrate -- --remote
   ```

### Drizzle Studio (Database GUI)

Explore your database with Drizzle Studio:

```bash
cd backend
pnpm run db:studio
```

Opens at `https://local.drizzle.studio`

### Database Scripts

Migrations are generated from the schema in `src/db/schema/` and applied in order.

```bash
# In backend directory:
pnpm run db:generate        # Generate a migration from a schema change
pnpm run db:migrate         # Apply the pending migrations
pnpm run db:secure          # Revoke the public grants and enable row level security
pnpm run db:reset           # Drop everything in `public` and replay the migrations
pnpm run db:reset -- --seed # The same, and insert the development data
pnpm run db:reset -- --remote   # The same, against the hosted database
pnpm run db:studio          # Open Drizzle Studio GUI
pnpm run db:seed            # Seed the users and search profiles
```

`db:reset` drops and recreates everything in the `public` schema, then replays the migration
history. It leaves the database empty unless `--seed` is passed. The Supabase-managed schemas
(`auth`, `storage`, `graphql_public`) are left alone, so Supabase Auth users survive a reset.

A database that was created before the migration history existed has the tables but no
migration ledger, so `db:migrate` cannot apply anything to it. Run `db:reset` on such a
database once to rebuild it from the history.

### Database access lockdown

Supabase grants the `anon` and `authenticated` roles full privileges on every table in `public`,
and row level security is off unless it is turned on. Since the frontend ships the anon key in
the browser bundle, that would leave the job-hunter tables (users and their email addresses
among them) readable and writable by anyone, without authenticating.

`db:secure` turns row level security on for every application table and revokes the
`anon` and `authenticated` grants. No policies are created, so the default is to deny every
row. Function execution is revoked as well, since a function in an exposed schema is an RPC
endpoint that the anon key could otherwise call. The backend connects as a runtime role that
`db:secure` creates and admits per table (`DEPLOYMENT.md`, "Database roles").

**Run `db:secure` after every migration.** The Drizzle schema is the source of truth
for the tables, but Drizzle ORM 0.33 cannot express row level security or role grants, so the
rules live in `src/db/security.ts` and are applied separately. `db:reset` applies them
automatically, and the Railway deploy runs `db:migrate` followed by `db:secure`.

See [`docs/SECURITY.md`](../docs/SECURITY.md) for the full rationale.

## Development

```bash
# From the backend directory:
pnpm install

# Run in development mode
pnpm run dev

# Build for production
pnpm run build

# Debug mode
pnpm run debug
```

## Testing

The project includes unit tests using Jest:

```bash
# Run all tests
pnpm test

# Run tests in watch mode (auto-rerun on file changes)
pnpm run test:watch

# Run tests with coverage report
pnpm run test:coverage
```

### Test Coverage

Tests cover:
- ✅ Environment allowlisting (guarantees secrets are never exposed over HTTP)
- ✅ Handler methods (success and error cases)
- ✅ Service layer functionality
- ✅ Input validation
- ✅ Database error handling
- ✅ Edge cases and null scenarios

## API Endpoints

### Health Check
- `GET /` - Health check. Returns `status` plus an allowlisted subset of non-sensitive env values. Never returns secrets.

### Portfolio (public)
- `GET /resume` - The knowledge service's primary resume PDF (404 when there is none)

### AI (public)
- `POST /chat` - Conversational assistant grounded in the chunks retrieved for each question. `example: true` marks a clicked example question: on an exact example text the click is counted in the eval set instead of the question being recorded
- `POST /mcp/public` - Public MCP server (stateless streamable HTTP, no auth): `search_background { query, k? }` (k 6 by default, at most 8) and `get_resume_pdf`. Rate limited per client (`PUBLIC_MCP_RATE_LIMIT_MAX` per `PUBLIC_MCP_RATE_LIMIT_WINDOW_MS`, default 20 per 10 minutes) and searches capped per UTC day (`PUBLIC_MCP_DAILY_SEARCH_CAP`, default 500, and `PUBLIC_MCP_CLIENT_DAILY_SEARCH_CAP` per client, default 50; counted per process). Only the first `PUBLIC_MCP_CLIENT_DAILY_RECORD_CAP` searches per client (default 5), up to `PUBLIC_MCP_DAILY_RECORD_CAP` a day (default 100), are recorded in the eval set. `GET`/`DELETE` answer 405. Add it with `claude mcp add --transport http six7swe https://<backend-host>/mcp/public`
- `POST /fitcheck` - Fit assessment for a role, grounded in the chunks retrieved for the job description (503 when the knowledge service is unreachable)
- `POST /contact` - Contact form submission to `CONTACT_TO_EMAIL` (delivered via Resend; 503 without it)

### Job Hunter (requires authentication)

All job-hunter routes live under `/job-hunt` and require a Supabase access
token. Every profile-scoped route is limited to the signed-in user's own
profiles.

- `GET /job-hunt/jobs` - List all scraped jobs
- `GET /job-hunt/jobs/:source_id/:source_job_id` - Get a job by source
- `GET /job-hunt/profiles` - List the caller's search profiles
- `POST /job-hunt/profiles` - Create a search profile
- `GET /job-hunt/profiles/:profileId` - Get a profile by ID
- `PATCH /job-hunt/profiles/:profileId` - Update a profile
- `DELETE /job-hunt/profiles/:profileId` - Delete a profile
- `GET /job-hunt/profiles/:profileId/jobs` - Scored matches for a profile
- `POST /job-hunt/profiles/:profileId/jobs/refresh` - Start a job refresh (returns `202` with `refreshStatusId`)
- `GET /job-hunt/profiles/:profileId/jobs/refresh/:refreshId` - Refresh status
- `GET /job-hunt/users` - The caller's own user record
- `GET /job-hunt/users/:id` - A user by ID (only the caller's own)

> Routes are **private by default**. Each route declares its access in
> `src/routes/access.ts`; the guard in `src/index.ts` reads that flag, so a new
> endpoint cannot be exposed by accident.
>
> Authentication is verified against the Supabase JWKS endpoint. See
> [`.env.example`](.env.example) for `SUPABASE_URL` and `AUTH_DEV_BYPASS`.

### Job refresh

```bash
# Start a refresh from the command line and wait for it to finish.
pnpm run jobs:refresh -- --profile 1 --wait

# Fire and forget.
pnpm run jobs:refresh -- --profile 1
```

The CLI uses the same pipeline as the HTTP trigger. Scheduled refreshes run on
the scraper worker (`pnpm worker:dev` locally, `pnpm start:worker` on Railway),
which refreshes the profiles in `JOB_REFRESH_PROFILE_IDS` every
`JOB_REFRESH_INTERVAL_HOURS` (DEPLOYMENT.md, "Scraper Worker and Scheduled
Refreshes"). Refreshes abandoned by a crashed process are marked failed on the
next startup.

## Project Structure

```text
src/
├── index.ts                   # App entry point, hooks, health check
├── constants.ts
├── config/
│   ├── auth.ts                # Auth provider configuration
│   ├── env.ts                 # Allowlisted env values safe to expose
│   └── knowledgeRetrieval.ts  # Knowledge service URL, key and retrieval settings
├── data/
│   └── chatContext.ts         # Chat and fitcheck context from retrieval
├── db/
│   ├── index.ts               # postgres.js client + Drizzle instance
│   ├── api/                   # Data access per domain
│   └── schema/
│       └── jobHunt.ts         # Job-hunter tables (the only ones)
├── domain/
│   └── jobHunt/               # Pure logic: score, refresh, filtering, jobs
├── plugins/                   # Fastify decorators (auth, services)
├── routes/
│   ├── index.ts               # Route registration
│   ├── access.ts              # Public / private route declarations
│   ├── portfolio.ts           # Public portfolio routes
│   ├── jobHunt.ts             # /job-hunt/* routes
│   └── handlers/              # Request handlers
├── services/
│   ├── ai/                    # Chat, fitcheck and the canonical matcher
│   │   └── prompts/           # Prompts as files
│   ├── auth/                  # Supabase JWT verification
│   ├── jobHunt/               # Refresh orchestration
│   ├── jobFetchers/           # Puppeteer job scrapers
│   ├── knowledge/             # Knowledge service clients and the version-keyed cache
│   ├── knowledgeRetrieval.ts  # Retrieval client and its version-keyed cache
│   ├── resumeDownload.ts      # /resume, cached by corpus version
│   └── minimaxService.ts      # AI transport only
├── types/
├── util/                      # retry, hash, decode, redact, concurrency
└── __tests__/                 # Unit tests
```

## Tech Stack

- **Backend**: Node.js, Fastify, TypeScript
- **Database**: Supabase (PostgreSQL)
- **ORM**: Drizzle ORM
- **Testing**: Jest, ts-jest
- **AI**: MiniMax
- **Email**: Resend
- **Scraping**: Puppeteer
- **Package Manager**: pnpm

## Database Schema

All tables are the job hunter's, in `src/db/schema/jobHunt.ts`. Migration
`0002_drop_portfolio` dropped the former portfolio tables (`portfolio_profile`,
`content_sections`) when retrieval became the only background source (#213).

### `users`
- `id` - Primary key
- `name` - User's full name
- `email` - Unique email address
- `auth_id` - Unique external auth provider id (Supabase)
- `created_at` / `updated_at` - Timestamps

### `profiles`
- `id` - Primary key
- `user_id` - Foreign key to `users` (cascade delete)
- `name` - Profile name (unique per user)
- `keywords` - Text array
- `location` - LinkedIn numeric region id (geoId), not a city name
- `additional_context` - Additional profile information (the candidate's background comes from the knowledge base, not from the profile)
- The old `resume` column was dropped by migration `0001_deep_ultimatum`. **The drop is irreversible**: resume text pasted into a profile is deleted when the migration runs and cannot be restored from the database afterwards. Copy any you want to keep before migrating.
- `created_at` / `updated_at` - Timestamps

### `jobs`
- `id` - Primary key
- `source_id` - Enum: `LINKEDIN`, `INDEED`, `GLASSDOOR`, `COMPANY_WEBSITE`, `OTHER`
- `source_job_id` - Identifier from the source
- `link`, `company`, `position`, `description`
- `location` - Location as displayed by the source
- `date_posted` - Relative label from the source (e.g. "2 days ago")
- `hash` - SHA-256 content fingerprint for change detection
- `created_at` / `updated_at` - Timestamps
- Unique on `(source_id, source_job_id)`

### `profile_jobs`
- `id` - Primary key
- `profile_id` / `job_id` - Foreign keys (cascade delete)
- `job_hash` - Hash of the job at match time
- `score` - Match score, 0-100
- `band` - Enum: `LOW`, `MEDIUM`, `HIGH`, `TOP` (derived from the score)
- `explanation`, `summary` - Human-readable reasoning
- `first_skill_match`, `second_skill_match`, `third_skill_match`
- `knowledge_version` - Knowledge corpus version the match was scored against (null: scored without it). A different current version makes the match stale.
- `evidence` - JSON array of `{ documentId, filename }`: the knowledge documents retrieved for the match
- Unique on `(profile_id, job_id)`

### `refresh_status`
- `id` - Primary key
- `profile_id` - Foreign key to `profiles` (cascade delete)
- `status` - Enum: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`
- `step` - Enum: `PENDING`, `FETCHING_JOBS`, `FILTERING_JOBS`
- `description` - Progress detail
- `created_at` / `updated_at` - Timestamps

## Example Usage

### Health check
```bash
curl http://localhost:3000/
```

### Portfolio
```bash
curl -OJ http://localhost:3000/resume
```

### Chat
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are Ray'"'"'s main skills?"}'
```

### Public MCP
```bash
curl -X POST http://localhost:3000/mcp/public   -H "Content-Type: application/json"   -H "Accept: application/json, text/event-stream"   -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_background","arguments":{"query":"distributed systems","k":3}}}'
```

### Contact form
```bash
curl -X POST http://localhost:3000/contact \
  -H "Content-Type: application/json" \
  -d '{"name": "Jane Doe", "email": "jane@example.com", "message": "Hello"}'
```

### List jobs (requires authentication)
```bash
curl http://localhost:3000/job-hunt/jobs \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

## Security

See [`docs/SECURITY.md`](../docs/SECURITY.md) for the credential rotation checklist and incident notes.

- Secrets live only in environment variables. Never commit `.env`.
- The health check returns an **allowlist** of non-sensitive values (`NODE_ENV`, `PORT`, `HOST`). Never spread `process.env` into a response.
- Pino redacts `authorization`, `x-api-key` and `x-brain-key` request headers.
- Upstream error bodies are truncated and masked before being logged.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Ensure all tests pass: `pnpm test`
5. Submit a pull request

## License

This project is licensed under the ISC License.
