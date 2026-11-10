# Backend - Job Application Management Platform

A modular monolith application for managing job applications with a Fastify backend and Supabase (PostgreSQL) database.

This backend lives in the `backend/` directory of the Six7SWE monorepo. See the root `README.md` for an overview of the entire project.

## Features

- ✅ User and profile queries
- ✅ Job ingestion, matching and refresh status
- ✅ PostgreSQL database integration via Drizzle ORM
- ✅ Portfolio content served from the database or an MCP server
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

4. Apply the schema and seed portfolio data:
   ```bash
   cd backend
   pnpm run db:migrate
   # The profile data is gitignored, so copy the example first:
   cp scripts/portfolio-data.example.json scripts/portfolio-data.json
   # Edit scripts/portfolio-data.json with your own profile data, then:
   pnpm run db:seed-portfolio
   ```

5. Run the API:
   ```bash
   pnpm dev
   ```

6. Test the API:
   ```bash
   curl http://localhost:3000/
   curl http://localhost:3000/portfolio
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
pnpm run db:seed-portfolio -- --remote
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
pnpm run db:seed-portfolio  # Seed the portfolio profile and content sections
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
the browser bundle, that would leave the portfolio data (resume, email, phone) and the
job-hunter tables readable and writable by anyone, without authenticating.

`db:secure` turns row level security on for every application table and revokes the
`anon` and `authenticated` grants. No policies are created, so the default is to deny every
row. Function execution is revoked as well, since a function in an exposed schema is an RPC
endpoint that the anon key could otherwise call. The backend is unaffected: it connects as the
table owner, and an owner bypasses RLS.

**Run `db:secure` after every migration.** The Drizzle schema is the source of truth
for the tables, but Drizzle ORM 0.33 cannot express row level security or role grants, so the
rules live in `src/db/security.ts` and are applied separately. `db:reset` applies them
automatically, and the Railway deploy runs `db:migrate` followed by `db:secure`.

See [`docs/SECURITY.md`](../docs/SECURITY.md) for the full rationale.

### Portfolio Data (Supabase)

Portfolio profile and content are stored in Supabase for public-repo safety:

1. Apply the schema: `pnpm run db:migrate`
2. Seed portfolio data:
   - Copy `scripts/portfolio-data.example.json` to `scripts/portfolio-data.json`
   - Edit `scripts/portfolio-data.json` with your profile data
   - Run `pnpm run db:seed-portfolio`
   - Seeds `portfolio_profile` (id=1) and `content_sections`
   - If `backend/content/` exists, reads .md/.txt files into content_sections
3. **Resume PDF**: With `PORTFOLIO_DATA_SOURCE=mcp`, implement `get_resume_pdf` on your MCP server (see `.env.example`). Otherwise place the PDF in `backend/public/` (e.g. `resume.pdf`) for local serving.

The data file is gitignored (`backend/scripts/portfolio-data.json`), as is `backend/content/`.
Only the example JSON and the seed logic are tracked.

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
- `GET /portfolio` - Portfolio contact/profile metadata (email, phone, social links, resume filename)
- `GET /resume` - Resume PDF download

### AI (public)
- `POST /chat` - Conversational assistant grounded in the portfolio
- `POST /job-match` - Score a job description against the profile. Returns `{ score, analysis, band, matchedSkills, gaps, summary }`
- `POST /fitcheck` - Fit assessment for a role
- `POST /contact` - Contact form submission (delivered via Resend)

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

The CLI uses the same pipeline as the HTTP trigger. Schedule it as a Railway
Cron so a refresh survives a process restart. Refreshes abandoned by a crashed
process are marked failed on the next startup.

## Project Structure

```text
src/
├── index.ts                   # App entry point, hooks, health check
├── constants.ts
├── config/
│   ├── auth.ts                # Auth provider configuration
│   ├── env.ts                 # Allowlisted env values safe to expose
│   └── portfolioMcp.ts        # MCP source configuration
├── data/
│   └── chatContext.ts
├── db/
│   ├── index.ts               # postgres.js client + Drizzle instance
│   ├── api/                   # Data access per domain
│   └── schema/
│       ├── portfolio.ts       # Portfolio tables
│       └── jobHunt.ts         # Job-hunter tables
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
│   ├── portfolioService.ts
│   ├── minimaxService.ts      # AI transport only
│   └── mcpPortfolioClient.ts
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

Tables are split by product: `src/db/schema/portfolio.ts` and
`src/db/schema/jobHunt.ts`.

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
- `additional_context` - Additional profile information
- `resume` - Resume text/data
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
- Unique on `(profile_id, job_id)`

### `refresh_status`
- `id` - Primary key
- `profile_id` - Foreign key to `profiles` (cascade delete)
- `status` - Enum: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`
- `step` - Enum: `PENDING`, `FETCHING_JOBS`, `FILTERING_JOBS`
- `description` - Progress detail
- `created_at` / `updated_at` - Timestamps

### `portfolio_profile`
Single row (`id = 1`) holding the portfolio owner’s public profile.
- `name`, `title`, `email`, `phone`, `location`
- `linkedin_url`, `github_url`
- `summary` - Text
- `skills` - JSONB array
- `experience` - JSONB array of `{ title, company, period, description }`
- `projects` - JSONB array of `{ name, description, technologies }`
- `full_resume_text` - Plain text resume used by the AI endpoints
- `resume_filename` - PDF filename served by `GET /resume`
- `created_at` / `updated_at` - Timestamps

### `content_sections`
- `id` - Primary key
- `filename` - Source file name
- `content` - Markdown/plain text body
- `sort_order` - Display order
- `created_at` / `updated_at` - Timestamps

## Example Usage

### Health check
```bash
curl http://localhost:3000/
```

### Portfolio
```bash
curl http://localhost:3000/portfolio
```

### Chat
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are Ray'"'"'s main skills?"}'
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
