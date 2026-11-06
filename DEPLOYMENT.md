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

> Set production values in the Railway dashboard, not in a committed file. `backend/.env` and `backend/.env.*` are gitignored and never deployed.

> **IPv4 only:** Railway does not support outbound IPv6. Use Supabase's IPv4 connection string for `DATABASE_URL`. See [Railway Outbound Networking](https://docs.railway.com/networking/outbound-networking).

### 2. Frontend Service

1. Create a new service in Railway
2. Connect the same GitHub repository
3. Set the **Root Directory** to `frontend` in Railway service settings
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables:
   - `VITE_API_URL` - URL of your backend service (e.g., `https://your-backend.railway.app`)

### 3. Apply the Schema to the Remote Database

The schema must exist before the backend can serve requests. From your machine:

```bash
cd backend
DOTENV_CONFIG_PATH=.env.remote pnpm run db:push
```

`backend/.env.remote` holds the remote `DATABASE_URL` and is gitignored.

### 4. Resume PDF

The frontend downloads the resume from the backend via `GET /resume`. The backend serves it from the local filesystem at `backend/public/`, falling back to `resume.pdf` if the database filename does not match.

- Place your resume at `backend/public/resume.pdf` (or match `portfolio_profile.resume_filename`).
- Ensure it is present in the deployed backend filesystem. Note that this repo's `.gitignore` ignores `backend/public/*.pdf` by default, so it will not deploy unless you change that policy.

> Supabase Storage is **not** currently read by the backend — `@supabase/supabase-js` is not a dependency and no code path reads `SUPABASE_URL` or `SUPABASE_SECRET_KEY`. Serving the resume from Storage requires implementing that path first.

### 5. Update Resume / Portfolio Data

1. Copy `backend/scripts/seed-portfolio.example.ts` to `backend/scripts/seed-portfolio.ts`, fill in your data, then run `pnpm run db:seed-portfolio` in backend—or update `portfolio_profile` directly in the database
2. Contact info is served from the portfolio API; no frontend edits needed

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
