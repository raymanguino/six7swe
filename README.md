# Six7SWE - Personal Portfolio & Job Application Platform

Six7SWE is a monorepo that combines a Fastify + Supabase backend for managing job applications with a React-based personal portfolio frontend.

## Monorepo Structure

- `backend/` - Fastify + TypeScript API for job application management and interview prep, backed by Supabase (PostgreSQL) and Drizzle ORM.
- `frontend/` - Vite + React + TypeScript portfolio site with an AI chat assistant. See `frontend/README.md` for frontend-specific details and commands.

## Prerequisites

- Node.js (LTS) and `pnpm` installed globally
- Supabase CLI for managing the local PostgreSQL instance
- Podman or Docker for containerized backend services
- (Optional) Railway account for hosting the frontend

## Frontend - Personal Portfolio Website

The frontend is a Vite + React + TypeScript application styled with Tailwind CSS. It powers the personal portfolio site, including:

- Landing page with highlights, achievements, and job matcher
- Work page showcasing projects (including Job Hunter)
- Contact page with contact info and a message form
- AI chat assistant available across pages to answer questions about professional background

See `frontend/README.md` for full frontend development and deployment instructions.

## Backend - Job Application Management Platform

A modular monolith application for managing job applications with a Fastify backend and Supabase (PostgreSQL) database.

For full backend setup, database configuration, and API documentation, see `backend/README.md`.