# Drizzle ORM Migration Guide

This guide explains how to use the new Drizzle ORM setup alongside the existing database code.

## Overview

The project now supports:
- ✅ **Dual Database Support**: Switch between Postgres and Supabase with one environment variable
- ✅ **Type-Safe Queries**: Use Drizzle for type-safe database operations
- ✅ **Backward Compatibility**: Existing @fastify/postgres code still works
- ✅ **Gradual Migration**: Adopt Drizzle at your own pace

## Quick Start

### 1. Install Dependencies

```bash
cd backend
pnpm install
```

This installs:
- `drizzle-orm` - ORM library
- `drizzle-kit` - Migration tooling
- `postgres` - Database driver for Drizzle

### 2. Configure Environment

Choose your database mode in `.env`:

**Option A: Regular Postgres**
```env
DATABASE_MODE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=67swe
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
```

**Option B: Supabase**
```env
DATABASE_MODE=supabase
SUPABASE_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
```

### 3. Generate Initial Migration

```bash
cd backend
pnpm run db:generate
```

This creates migration files in:
- `supabase/migrations/` (when `DATABASE_MODE=supabase`)
- `backend/migrations/` (when `DATABASE_MODE=postgres`)

### 4. Apply Migrations

**Postgres mode:**
```bash
pnpm run db:migrate
# OR for quick dev:
pnpm run db:push
```

**Supabase mode:**
```bash
cd ..
supabase db push
```

## Using Drizzle in Your Code

### Import the Database Instance

```typescript
import { db } from './db';
import { users, profiles, jobs } from './db/schema';
```

### Example Queries

#### Select All Users
```typescript
import { db, users } from './db';

const allUsers = await db.select().from(users);
```

#### Select User by ID
```typescript
import { db, users } from './db';
import { eq } from 'drizzle-orm';

const user = await db
  .select()
  .from(users)
  .where(eq(users.id, 1));
```

#### Insert User
```typescript
import { db, users, type InsertUser } from './db';

const newUser: InsertUser = {
  name: 'John Doe',
  email: 'john@example.com',
};

const result = await db
  .insert(users)
  .values(newUser)
  .returning();
```

#### Update User
```typescript
import { db, users } from './db';
import { eq } from 'drizzle-orm';

await db
  .update(users)
  .set({ name: 'Jane Doe' })
  .where(eq(users.id, 1));
```

#### Delete User
```typescript
import { db, users } from './db';
import { eq } from 'drizzle-orm';

await db
  .delete(users)
  .where(eq(users.id, 1));
```

#### Join Query (Users with Profiles)
```typescript
import { db, users, profiles } from './db';
import { eq } from 'drizzle-orm';

const usersWithProfiles = await db
  .select({
    userId: users.id,
    userName: users.name,
    profileName: profiles.name,
  })
  .from(users)
  .leftJoin(profiles, eq(users.id, profiles.userId));
```

## Migration Strategy

You can adopt Drizzle gradually:

### Phase 1: Keep Existing Code (Current)
- Continue using `@fastify/postgres` for all queries
- Drizzle is available but not required

### Phase 2: New Code Uses Drizzle
- New features use Drizzle ORM
- Existing code remains unchanged
- Both work side-by-side

### Phase 3: Gradual Migration (Optional)
- Convert existing queries to Drizzle one module at a time
- Test thoroughly after each conversion

## Schema Changes

When you need to modify the database schema:

### 1. Update Schema File

Edit `src/db/schema.ts`:

```typescript
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  // Add new field:
  phoneNumber: varchar('phone_number', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
```

### 2. Generate Migration

```bash
pnpm run db:generate
```

### 3. Review Generated SQL

Check the migration file in `migrations/` or `supabase/migrations/`

### 4. Apply Migration

**Postgres:**
```bash
pnpm run db:migrate
```

**Supabase:**
```bash
cd ..
supabase db push
```

## Drizzle Studio

Explore your database visually:

```bash
pnpm run db:studio
```

Opens at `https://local.drizzle.studio`

Features:
- Browse all tables
- View relationships
- Run queries
- Edit data

## Switching Databases

To switch from Postgres to Supabase (or vice versa):

### 1. Change Environment Variable

```env
# From:
DATABASE_MODE=postgres

# To:
DATABASE_MODE=supabase
SUPABASE_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
```

### 2. Restart Application

```bash
# Stop current app
# Update .env
# Start app
pnpm run dev
```

### 3. That's It!

No code changes required. Your application now uses Supabase.

## Troubleshooting

### Error: "Cannot find module 'drizzle-orm'"

```bash
cd backend
pnpm install
```

### Error: "POSTGRES_* environment variables are required"

Add required variables to `.env`:
```env
DATABASE_MODE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=67swe
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
```

### Error: "SUPABASE_DATABASE_URL is required"

When using Supabase mode, add:
```env
DATABASE_MODE=supabase
SUPABASE_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
```

### Migrations Not Applied

**Postgres mode:**
```bash
cd backend
pnpm run db:push  # Quick dev push
# OR
pnpm run db:migrate  # Apply migrations
```

**Supabase mode:**
```bash
supabase db push
# OR
supabase db reset  # Reset and reapply all
```

## Resources

- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [Drizzle with Supabase Guide](https://orm.drizzle.team/docs/tutorials/drizzle-with-supabase)
- [Supabase CLI Documentation](https://supabase.com/docs/guides/cli)
- [Drizzle Kit CLI Reference](https://orm.drizzle.team/kit-docs/overview)

## File Structure

```
backend/
├── src/
│   ├── db/
│   │   ├── index.ts          # Database connection
│   │   └── schema.ts         # Drizzle schema
│   ├── database/
│   │   ├── api/              # Existing database functions
│   │   └── init.sql          # Original schema (reference)
│   └── ...
├── drizzle.config.ts         # Drizzle Kit configuration
└── .env                      # Environment variables

supabase/
├── migrations/               # Supabase migrations
├── seed.sql                  # Sample data
└── config.toml              # Supabase configuration
```
