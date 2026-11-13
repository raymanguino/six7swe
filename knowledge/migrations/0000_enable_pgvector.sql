-- Custom migration: pgvector must exist before the first table that uses it.
-- Supabase keeps extensions in the `extensions` schema, which is on the
-- default search_path, so the unqualified `vector` type resolves.
CREATE SCHEMA IF NOT EXISTS extensions;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
