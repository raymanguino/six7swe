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

This starts Postgres on `127.0.0.1:54322`, the REST API on `54321`, and Studio on `54323`. The Supabase migrations in `supabase/migrations/` are applied automatically on first run.

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
| `MINIMAX_API_KEY` | AI endpoints (`/chat`, `/job-match`, `/fitcheck`) |
| `RESEND_API_KEY` | Contact form delivery |

Optional variables (`PORT`, `PORTFOLIO_DATA_SOURCE`, `PORTFOLIO_CACHE_TTL_MS`, `MCP_*`) are documented in [`backend/.env.example`](backend/.env.example).

Set `MINIMAX_API_KEY_SECONDARY` optionally to retry once with a second key when the primary request receives HTTP 429.

> Only one `DATABASE_URL` may be active in `.env` — dotenv resolves duplicates by last occurrence wins. JSON values must be on a single line.

### 4. Apply the Schema and Seed Data

```bash
cd backend
pnpm run db:push
pnpm run db:seed-portfolio
```

### 5. Frontend Setup

The frontend will automatically proxy API requests to the backend in development.

For production, set:
- `VITE_API_URL` - Backend API URL

### 6. Portfolio / Resume

1. Copy `backend/scripts/seed-portfolio.example.ts` to `backend/scripts/seed-portfolio.ts`
2. Edit `seed-portfolio.ts` with your profile data (name, email, resume text, etc.)
3. Run `pnpm run db:seed-portfolio` in backend
4. Copy your resume PDF to `backend/public/` (e.g. `resume.pdf`), or set `PORTFOLIO_DATA_SOURCE=mcp` and configure MCP in `backend/.env` so portfolio and resume are served from your MCP server (see `backend/.env.example`).

### 7. Run Development Servers

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
pnpm run db:push

# Remote database
DOTENV_CONFIG_PATH=.env.remote pnpm run db:push
DOTENV_CONFIG_PATH=.env.remote pnpm run db:seed-portfolio
```

Both files are gitignored. Only `backend/.env.example` is tracked.

## Updating Resume/Portfolio Data

Update the `portfolio_profile` table in the database, or edit `backend/scripts/seed-portfolio.ts` (copy from `seed-portfolio.example.ts` if needed) and re-run `pnpm run db:seed-portfolio`. The AI chat assistant uses `full_resume_text` to answer questions.

## Deployment

For deploying this project to Railway, including service configuration and production environment variables, see `DEPLOYMENT.md`.
