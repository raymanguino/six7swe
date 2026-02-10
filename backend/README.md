# Backend - Job Application Management Platform

A modular monolith application for managing job applications with a Fastify backend and Supabase (PostgreSQL) database.

This backend lives in the `backend/` directory of the Six7SWE monorepo. See the root `README.md` for an overview of the entire project.

## Features

- ✅ User CRUD operations
- ✅ Profile CRUD operations
- ✅ PostgreSQL database integration
- ✅ Containerized with Podman/Docker
- ✅ TypeScript with Fastify framework
- ✅ Environment-based configuration
- ✅ Comprehensive unit testing with Jest
- ✅ Modular architecture with services and handlers

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/six7swe.git
   cd six7swe
   ```

2. Create environment file:
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env and add your database credentials
   ```

3. Start the services:
   ```bash
   podman compose up -d
   ```

4. Test the API:
   ```bash
   curl http://localhost:3000/users
   ```

## Database Setup

This project uses **Supabase** (PostgreSQL) with Drizzle ORM. You can use either local Supabase for development or remote Supabase for production.

### Local Development with Supabase

1. Start local Supabase:
   ```bash
   supabase start
   ```

2. Configure your `.env` file in the backend directory:
   ```env
   NODE_ENV=development
   APP_PORT=3000
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable
   DATABASE_MIGRATIONS_DIR=./migrations
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. Generate and apply migrations:
   ```bash
   cd backend
   pnpm run db:generate              # Generate Drizzle migrations
   cd ..
   supabase db push                  # Push to Supabase
   ```

### Remote Supabase (Production)

1. Get connection string from Supabase Dashboard → Settings → Database

2. Update your `.env` file:
   ```env
   NODE_ENV=production
   APP_PORT=3000
   DATABASE_URL=your_supabase_connection_string
   DATABASE_MIGRATIONS_DIR=./migrations
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. Apply migrations:
   ```bash
   cd backend
   pnpm run db:generate
   cd ..
   supabase db push
   ```

### Drizzle Studio (Database GUI)

Explore your database with Drizzle Studio:

```bash
cd backend
pnpm run db:studio
```

Opens at `https://local.drizzle.studio`

### Database Scripts

```bash
# In backend directory:
pnpm run db:generate   # Generate migration files from schema
pnpm run db:migrate    # Apply migrations to database
pnpm run db:push       # Push schema directly (dev only)
pnpm run db:studio     # Open Drizzle Studio GUI
pnpm run db:seed-portfolio  # Seed portfolio (requires seed-portfolio.ts; copy from seed-portfolio.example.ts)
```

### Portfolio Data (Supabase)

Portfolio profile and content are stored in Supabase for public-repo safety:

1. Apply migrations: `supabase db push` (or `pnpm run db:push`)
2. Seed portfolio data:
   - Copy `scripts/seed-portfolio.example.ts` to `scripts/seed-portfolio.ts`
   - Edit `seed-portfolio.ts` with your profile data
   - Run `pnpm run db:seed-portfolio`
   - Seeds `portfolio_profile` (id=1) and `content_sections`
   - If `backend/content/` exists, reads .md/.txt files into content_sections
3. **Resume PDF**: Place `ray.manguino.pdf` in `backend/public/` for local fallback, or upload to Supabase Storage bucket `portfolio-files` and set `SUPABASE_URL` plus `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) in `.env`. Use the [secret key](https://supabase.com/docs/guides/api/api-keys) (`sb_secret_...`) for backend access.

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

The project includes comprehensive unit tests using Jest:

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
- ✅ All handler methods (success and error cases)
- ✅ Service layer functionality
- ✅ Input validation
- ✅ Database error handling
- ✅ Edge cases and null scenarios

## API Endpoints

### Health Check
- `GET /` - Health check

### Portfolio (public)
- `GET /portfolio` - Portfolio contact/profile metadata (email, phone, social links, resume filename)
- `GET /resume` - Resume PDF download

### Users
- `GET /users` - List all users
- `GET /users/:id` - Get user by ID
- `POST /users` - Create new user
- `PUT /users/:id` - Update user
- `DELETE /users/:id` - Delete user

### Profiles
- `GET /profiles` - List all profiles
- `GET /profiles/:id` - Get profile by ID
- `GET /users/:userId/profiles` - Get all profiles for a specific user
- `POST /profiles` - Create new profile
- `PUT /profiles/:id` - Update profile
- `DELETE /profiles/:id` - Delete profile

## Project Structure

```text
src/
├── index.ts                 # Main application entry point
├── handlers/                # Request handlers
│   ├── userHandlers.ts
│   └── profileHandlers.ts
├── routes/                  # Route definitions
│   ├── users.ts
│   └── profiles.ts
├── services/                # Business logic layer
│   ├── userService.ts
│   └── profileService.ts
├── plugins/                 # Fastify plugins
│   ├── userService.ts
│   └── profileService.ts
├── database/
│   └── schema.sql          # Database schema
└── __tests__/              # Unit tests
    ├── handlers/
    └── services/
```

## Tech Stack

- **Backend**: Node.js, Fastify, TypeScript
- **Database**: Supabase (PostgreSQL)
- **ORM**: Drizzle ORM
- **Testing**: Jest, ts-jest
- **Containerization**: Podman/Docker
- **Package Manager**: pnpm

## Database Schema

### Users Table
- `id` - Primary key
- `name` - User's full name
- `email` - Unique email address
- `created_at` - Creation timestamp
- `updated_at` - Last update timestamp

### Profiles Table
- `id` - Primary key
- `user_id` - Foreign key to users table
- `name` - Profile name (unique per user)
- `location` - User location
- `additional_context` - Additional profile information
- `resume` - Resume text/data
- `created_at` - Creation timestamp
- `updated_at` - Last update timestamp

## Example Usage

### Create a User
```bash
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "email": "john@example.com"}'
```

### Create a Profile
```bash
curl -X POST http://localhost:3000/profiles \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 1,
    "name": "Software Engineer Profile",
    "location": "San Francisco, CA",
    "additional_context": "Full-stack developer with 5+ years experience"
  }'
```

### Get User's Profiles
```bash
curl http://localhost:3000/users/1/profiles
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Ensure all tests pass: `pnpm test`
5. Submit a pull request

## License

This project is licensed under the ISC License.
