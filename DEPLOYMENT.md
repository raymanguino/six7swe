# Railway Deployment Guide

This monorepo is configured to deploy on Railway with separate services for frontend and backend.

Before deploying, complete the local setup steps in `SETUP.md` (install dependencies, configure environment variables, and seed your portfolio/resume data).

## Setup Instructions

### 1. Backend Service

1. Create a new service in Railway
2. Connect your GitHub repository
3. Set the **Root Directory** to `backend` in Railway service settings
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables:
   - `DATABASE_URL` - PostgreSQL connection string
   - `OPENAI_API_KEY` - Your OpenAI API key
   - `APP_PORT` - Port (Railway will set this automatically)
   - `NODE_ENV` - Set to `production`

### 2. Frontend Service

1. Create a new service in Railway
2. Connect the same GitHub repository
3. Set the **Root Directory** to `frontend` in Railway service settings
4. Railway will automatically detect the `railway.json` configuration
5. Set environment variables:
   - `VITE_API_URL` - URL of your backend service (e.g., `https://your-backend.railway.app`)

### 3. Resume PDF

1. Copy your resume PDF to `backend/public/resume.pdf`
2. The resume will be served at `/public/resume.pdf` from the backend

### 4. Update Resume / Portfolio Data

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
