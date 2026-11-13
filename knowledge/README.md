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
- **Primary resume.** The owner's newest (by upload time) `ready` resume is primary. A resume becomes primary when its ingest completes, not on upload, so a resume whose ingest fails never displaces a good one. Deleting the primary promotes the next newest ready resume. A primary whose re-ingest fails stays primary until another resume completes or it is deleted.
- **Deleting a queued document** removes it from the queue, so the worker never processes it.
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

The `/documents` endpoints are `owner` routes, temporarily behind the service key. A later step replaces that with an owner gate: a Supabase JWT whose `sub` equals `OWNER_AUTH_ID`. The auth plugin keeps one authenticator per access mode (`service`, `owner`); that step swaps only the `owner` entry (`buildApp({ authenticators: { owner } })`). Whatever an authenticator returns must be a safe storage-key segment, or the request gets 401. Handlers read the owner per request (`requireOwner(req)`).

The wire contract lives in `src/contract.ts` as zod schemas with inferred types (request bodies, the document and chunk DTOs, the retrieve and upload responses, and the error body). It depends on nothing but zod, so it can move to a shared package. The database enums are derived from its `DOCUMENT_KINDS` and `DOCUMENT_STATUSES`.

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
- **Iterative HNSW scans.** Search sets `hnsw.iterative_scan = relaxed_order` for its transaction (pgvector 0.8+). Without it, the index returns its nearest `hnsw.ef_search` (40) chunks across all owners and statuses and the filter runs afterwards, so a request could get fewer than `k` results, or none, while matching chunks exist. `relaxed_order` rather than `strict_order`: strict keeps rows in exact distance order but gives up sooner, so it can return fewer matches; relaxed scans for better recall and may return rows slightly out of order, which search re-sorts in memory (at most 20 rows).
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

The unit tests use an in-memory repository and need no database. One behavioural suite (`src/__tests__/support/repositoryContract.ts`) runs against both the in-memory repository and the Drizzle one, so the test double cannot drift from the real thing.

The Postgres integration suite runs when `KNOWLEDGE_TEST_DATABASE_URL` is set, and is skipped locally otherwise. In CI (`CI` set) it is required: the file throws if the URL is missing, and the CI workflow provides a pgvector service. Each test writes under its own random owner id, and the rows are removed afterwards:

```sh
KNOWLEDGE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @six7swe/knowledge test
```

## Deploy

The service deploys as its own Railway service. Two settings matter, because `railway.json` assumes them:

- **Root directory: the repository root**, not `knowledge/`. The build and start commands begin with `cd knowledge`, `pnpm install` needs the workspace root (`pnpm-workspace.yaml`, the lockfile), and `knowledge/tsconfig.json` extends `../tsconfig.base.json`.
- **Config file path: `knowledge/railway.json`.**

### Railway variables

The service validates its whole environment at boot and refuses to start if anything is missing or malformed. The error lists every problem at once, so a failed first deploy tells you exactly what to fix.

**Set these:**

| Variable                | Value                                                                   | Where to get it                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`              | `production`                                                            | Set explicitly. It defaults to `development`, and only `production` refuses the offline `hashing` embedder.                                                                                                                                                                                         |
| `DATABASE_URL`          | Postgres connection string for the same Supabase project as the backend | Supabase dashboard → **Connect**. Any mode works (direct, session pooler on 5432, or transaction pooler on 6543), because prepared statements are off. You can reuse the backend's value; this service only touches the `knowledge` and `knowledge_migrations` schemas.                             |
| `KNOWLEDGE_SERVICE_KEY` | A random secret, at least 32 characters                                 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The portfolio and hunter backends will need the same value when they start calling the service (step 3). Until the owner JWT gate lands (step 2), it also grants upload and delete, so treat it like an admin password. |
| `OWNER_AUTH_ID`         | Your Supabase auth user id (a UUID)                                     | Supabase dashboard → **Authentication → Users** → your user → **User UID**. Letters, digits, `.`, `_` and `-` only; it becomes the first segment of every storage key.                                                                                                                              |
| `OPENROUTER_API_KEY`    | An OpenRouter API key                                                   | openrouter.ai → **Keys**. Required because `EMBEDDER` defaults to `openrouter`.                                                                                                                                                                                                                     |
| `SUPABASE_URL`          | `https://<project-ref>.supabase.co`                                     | Supabase dashboard → **Project Settings → Data API**.                                                                                                                                                                                                                                               |
| `SUPABASE_SECRET_KEY`   | A Supabase secret key (`sb_secret_…`, or the legacy `service_role` key) | Supabase dashboard → **Project Settings → API Keys**. Server-side only: it bypasses RLS. Required because `FILE_STORE` defaults to `supabase`.                                                                                                                                                      |

**Leave these unset** unless you want to change the default:

| Variable                   | Default                         | Notes                                                                        |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `PORT`                     | `3100`                          | Railway injects `PORT`, and the service listens on it.                       |
| `HOST`                     | `0.0.0.0`                       | Needed for Railway's network; don't change.                                  |
| `EMBEDDER`                 | `openrouter`                    | `hashing` is refused in production.                                          |
| `EMBEDDING_MODEL`          | `openai/text-embedding-3-small` | Must output 1536 dimensions to match the `chunks.embedding` column.          |
| `FILE_STORE`               | `supabase`                      | `local` writes to the container's disk, which Railway wipes on every deploy. |
| `STORAGE_BUCKET`           | `portfolio-files`               |                                                                              |
| `MAX_UPLOAD_BYTES`         | `10485760` (10 MB)              | At most 50 MB; uploads are buffered in memory.                               |
| `RESUME_INGESTION_ON_BOOT` | `true`                          | Re-queues documents a previous instance left pending or processing.          |

Don't set `LOCAL_FILE_STORE_DIR` (local store only) or `KNOWLEDGE_TEST_DATABASE_URL` (tests only).

### First deploy checklist

1. In the Supabase project, check that pgvector 0.8 or later is available (**Database → Extensions → vector**). The first migration enables it in the `extensions` schema, so you don't need to enable it by hand.
2. Create the Storage bucket `portfolio-files` (or your `STORAGE_BUCKET`) and make sure it is **private**. The service doesn't create it.
3. Create the Railway service with the root directory and config path above, and set the variables in the first table.
4. Deploy. The pre-deploy step runs the migrations; then `GET /health` should return 200.
5. Smoke-test with the key: `curl -H "x-knowledge-key: $KNOWLEDGE_SERVICE_KEY" https://<service>/version` should return `{"version":0}`.

### Runtime behaviour

- The pre-deploy step runs `db:migrate:prod`: the migrator compiled to `dist/db/migrate.js` by the build, run with plain `node`. It needs only runtime dependencies, not tsx, drizzle-kit or dotenv. CI runs the same compiled migrator against an empty database after the build.
- On SIGTERM the service drains for up to 20 s, inside Railway's default 30 s stop window.
