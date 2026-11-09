# Frontend - Portfolio and Job Hunter

React + TypeScript frontend for Six7SWE, built with Vite and Tailwind CSS.
It lives in the `frontend/` directory of the monorepo and contains two separate
experiences.

## Monorepo Context

- Root project: see `../README.md` for an overview of the Six7SWE monorepo.
- Backend API: Fastify + Supabase service in `../backend` (typically running on
  `http://localhost:3000` in development).

## Two Experiences

### Portfolio (public, `/`)

The personal portfolio site. No authentication required.

- **Landing page**: intro, highlights, achievements, projects, skills, hobbies
- **Job Match Score**: paste a job description to get a 0-100 score, the
  matching skills and the gaps
- **Honest Fit Assessment**: a first-person fit assessment for a role
- **Contact**: contact details and a message form
- **AI Chat Assistant**: available across the site, answering questions about
  professional background

### Job Hunter (`/hunter`)

A signed-in tool for tracking job searches.

- **Sign in** at `/hunter/login` using Supabase Auth
- **Search profiles**: create and edit the profiles you search with (keywords,
  LinkedIn geo id, resume text)
- **Job refresh**: start a refresh and watch it progress
- **Scored matches**: each posting with its score, band and reasoning

The job-hunter talks to `/job-hunt/*` on the backend, which requires a bearer
token. The token is attached automatically by `src/utils/api.ts`.

## Environment

Copy the template and fill it in:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Base URL of the backend API. Leave unset to use the Vite dev proxy at `/api` (defaults to `http://localhost:3000`). |
| `VITE_SUPABASE_URL` | Supabase project URL. Required for the job-hunter. |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key. Required for the job-hunter. |

Without the Supabase variables the portfolio still works; the `/hunter` pages
explain that authentication is not configured.

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview
```

## Railway Deployment

This frontend is configured to deploy on Railway as part of a monorepo setup.
The Railway configuration is in `railway.json`.

Set `VITE_API_URL`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` on the
Railway service.
