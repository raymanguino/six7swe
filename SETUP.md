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

### 4. Resume PDF

1. Copy your resume PDF to `backend/public/resume.pdf`
2. Update resume data in `backend/src/data/resume.ts` with your actual information
3. Update contact information in `frontend/src/pages/Contacts.tsx`

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

## Updating Resume Data

Edit `backend/src/data/resume.ts` to update:
- Personal information
- Skills
- Experience
- Projects
- Full resume text (used by AI chat assistant)

The AI chat assistant uses the `fullResumeText` field to answer questions, so make sure it contains comprehensive information about your professional background.
