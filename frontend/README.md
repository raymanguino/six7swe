# Frontend - Personal Portfolio Website

React-based personal portfolio website built with Vite, TypeScript, and Tailwind CSS. This app lives in the `frontend/` directory of the Six7SWE monorepo and connects to the Fastify backend for job application management.

## Monorepo Context

- Root project: see `../README.md` for an overview of the Six7SWE monorepo.
- Backend API: Fastify + Supabase service in `../backend` (typically running on `http://localhost:3000` in development).

## Features

- **Home Page**: Landing page with intro, highlights, achievements, and job matcher
- **Work Page**: Showcase of projects including Job Hunter
- **Contacts Page**: Contact information and message form
- **AI Chat Assistant**: Available on all pages to answer questions about professional background

## Environment

- **`VITE_API_URL`**: Base URL for the backend API.
  - In development, the Vite dev server proxies `/api` requests to `VITE_API_URL` (default: `http://localhost:3000`).
  - Set this in your environment (e.g. `.env` file) if your backend runs on a different host or port.

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

This frontend is configured to deploy on Railway as part of a monorepo setup. The Railway configuration is in `railway.json`.
