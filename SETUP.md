# Setup Guide

## Prerequisites

- Node.js 18+ and pnpm installed
- PostgreSQL database (local Supabase or remote)
- OpenAI API key

## Initial Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Backend Setup

```bash
cd backend
cp .env.example .env
# Edit .env with your database URL and OpenAI API key
```

Required environment variables:
- `DATABASE_URL` - PostgreSQL connection string
- `OPENAI_API_KEY` - Your OpenAI API key
- `APP_PORT` - Port (default: 3000)

### 3. Frontend Setup

The frontend will automatically proxy API requests to the backend in development.

For production, set:
- `VITE_API_URL` - Backend API URL

### 4. Portfolio / Resume

1. Copy `backend/scripts/seed-portfolio.example.ts` to `backend/scripts/seed-portfolio.ts`
2. Edit `seed-portfolio.ts` with your profile data (name, email, resume text, etc.)
3. Run `pnpm run db:seed-portfolio` in backend
4. Copy your resume PDF to `backend/public/` (e.g. `resume.pdf`) or upload to Supabase Storage

### 5. Run Development Servers

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

## Updating Resume/Portfolio Data

Update the `portfolio_profile` table in the database, or edit `backend/scripts/seed-portfolio.ts` (copy from `seed-portfolio.example.ts` if needed) and re-run `pnpm run db:seed-portfolio`. The AI chat assistant uses `full_resume_text` to answer questions.
