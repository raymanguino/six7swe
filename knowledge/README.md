# @six7swe/knowledge

The knowledge service holds the owner's professional background: resumes and supporting documents. The portfolio chat and the job hunter retrieve their context from it.

It replaces two earlier sources:

- the `PORTFOLIO_DATA_SOURCE=mcp` path, which was never wired to a working server;
- the hand-seeded `portfolio_profile` and `content_sections` tables.

## How it works

```
POST /documents ──► file store (Supabase Storage `portfolio-files`)
      │
      ▼  documents row: pending
 serial queue ──► extract text (unpdf for PDF; md/txt decoded)
      │          ──► chunk (markdown by headings; otherwise ~700-token windows, 15% overlap)
      │          ──► embed (OpenRouter text-embedding-3-small, 1536d)
      ▼
 one transaction: replace chunks, mark ready, bump corpus_version

POST /retrieve {query, k} ──► embed query ──► pgvector cosine search (HNSW)
```

- **Deduplication.** Uploading identical bytes of a `ready` document again is a no-op, and never changes which resume is primary. Re-uploading a file that is not ready and not being worked on (its ingest failed, or a crash stranded it in `pending`/`processing`) stores the bytes again and retries it.
- **Corpus version.** `corpus_version` increases whenever the set of chunks retrieval can see changes: an ingest finishes, a ready document is deleted, or a ready document leaves `ready` (a re-ingest starts or fails). Callers use it as a cache key, and the job hunter will use it to detect stale match scores.
- **Recovery.** Ingestion runs in-process. Each document's status lives in the database, so documents left `pending` or `processing` by a crash are queued again on boot. On shutdown the service stops taking requests, drops queued documents (they stay `pending` for the next boot) and waits up to 20 s for the one in progress.
- **Failed re-ingest.** If a re-ingest fails, the document is marked `failed`. Its previous chunks stay in the table but are no longer served, since retrieval only reads `ready` documents. Uploading the file again retries it.
- **Errors.** A failed document's `error` is a short, user-facing reason (for example `Could not parse the PDF.` or `Embedding provider error (status 503)`). Provider responses and stack traces go to the logs only.

## API

Every route declares who may call it: `public`, `service` or `owner` (`src/plugins/serviceAuth.ts`). A route that declares nothing is `service`, so a forgotten declaration fails closed. Today `service` and `owner` both require the `x-knowledge-key` header; the key is never accepted in a query string. Unknown paths answer 401 without the key and 404 with it.

| Method | Path             | Purpose                                                                                                                           |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`        | Liveness (public)                                                                                                                 |
| POST   | `/retrieve`      | `{ query, k? }` returns `{ version, chunks[] }`; `k` defaults to 6, max 20                                                        |
| GET    | `/version`       | `{ version }`                                                                                                                     |
| POST   | `/documents`     | Multipart upload with a `file` part (`.pdf`, `.md`, `.txt`). Add `?kind=resume` for a resume. Returns 202, or 200 if a duplicate. |
| GET    | `/documents`     | List documents with status and chunk count                                                                                        |
| GET    | `/documents/:id` | One document                                                                                                                      |
| DELETE | `/documents/:id` | Deletes the document, its chunks and its file (204)                                                                               |

The `/documents` endpoints are `owner` routes, temporarily behind the service key. A later step replaces that with an owner gate: a Supabase JWT whose `sub` equals `OWNER_AUTH_ID`. Handlers already read the owner per request (`requireOwner(req)`), so only the auth hook changes.

The wire types live in `src/contract.ts`, which depends on nothing but zod so it can move to a shared package. The database enums are derived from its `DOCUMENT_KINDS` and `DOCUMENT_STATUSES`.

## Database

The service owns the `knowledge` schema, with these tables:

- `documents`
- `chunks` (embeddings in `vector(1536)`, HNSW cosine index)
- `corpus_state`

Its migration ledger lives in a separate `knowledge_migrations` schema. Both schemas are kept apart from the backend:

- `drizzle.config.ts` sets `schemaFilter: ['knowledge']`, so drizzle-kit never diffs the backend's `public` tables.
- The backend's `db:reset` drops only `public` and the shared `drizzle` ledger schema, so it cannot touch these schemas.
- The schemas are not exposed through PostgREST, and the `anon` and `authenticated` roles have no `USAGE` on them.

```sh
pnpm --filter @six7swe/knowledge db:generate     # write a migration from a schema change
pnpm --filter @six7swe/knowledge db:migrate      # apply migrations (tsx; reads .env if present)
pnpm --filter @six7swe/knowledge db:migrate:prod # the compiled migrator (after `build`); used by Railway
```

Requirements on the database:

- **pgvector 0.8 or later, in the `extensions` schema, which must be on the `search_path`.** This is Supabase's default. The first migration runs `CREATE EXTENSION vector WITH SCHEMA extensions`, and the later ones use the unqualified `vector` type and operators. On a plain Postgres, run `ALTER DATABASE <db> SET search_path TO "$user", public, extensions` first (CI does this).
- **Iterative HNSW scans.** Search sets `hnsw.iterative_scan = relaxed_order` for its transaction (pgvector 0.8+). Without it, the index returns its nearest `hnsw.ef_search` (40) chunks across all owners and statuses and the filter runs afterwards, so a request could get fewer than `k` results, or none, while matching chunks exist.
- **Any connection mode.** The client disables prepared statements (`prepare: false`), so `DATABASE_URL` may be Supabase's transaction pooler (port 6543), the session pooler or a direct connection.

## Local development

1. Start the local Supabase stack: `supabase start`.
2. Copy `.env.example` to `.env`, then set `KNOWLEDGE_SERVICE_KEY` and `OWNER_AUTH_ID`. The defaults use the offline `hashing` embedder and the local file store, so no API key is needed.
3. Apply the migrations: `pnpm --filter @six7swe/knowledge db:migrate`.
4. Start the service on port 3100: `pnpm dev:knowledge`.

To upload a file and query it:

```sh
curl -X POST "localhost:3100/documents?kind=resume" -H "x-knowledge-key: $KEY" -F file=@resume.pdf
curl -X POST localhost:3100/retrieve -H "x-knowledge-key: $KEY" \
  -H 'content-type: application/json' -d '{"query":"distributed systems experience"}'
```

The `hashing` embedder ranks results by shared words, not by meaning. For realistic retrieval quality, set `EMBEDDER=openrouter` and `OPENROUTER_API_KEY`.

## Tests

```sh
pnpm --filter @six7swe/knowledge test
```

The unit tests use an in-memory repository and need no database.

The Postgres integration suite runs when `KNOWLEDGE_TEST_DATABASE_URL` is set, and is skipped locally otherwise. In CI (`CI` set) it is required: the file throws if the URL is missing, and the CI workflow provides a pgvector service. It writes under random owner ids and cleans up afterwards:

```sh
KNOWLEDGE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @six7swe/knowledge test
```

## Deploy

The service deploys as its own Railway service, with the config file path set to `knowledge/railway.json`.

- The pre-deploy step runs `db:migrate:prod`: the migrator compiled to `dist/db/migrate.js` by the build, run with plain `node`. It needs only runtime dependencies, not tsx, drizzle-kit or dotenv.
- On SIGTERM the service drains for up to 20 s, inside Railway's default 30 s stop window.
- Required variables:
  - `DATABASE_URL`
  - `KNOWLEDGE_SERVICE_KEY`
  - `OWNER_AUTH_ID`
  - `OPENROUTER_API_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_SECRET_KEY`
- The `portfolio-files` bucket must exist and be private.
