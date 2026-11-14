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
      │          ──► embed (OpenAI text-embedding-3-small, 1536d)
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

Every route declares who may call it: `public`, `service` or `owner` (`src/plugins/serviceAuth.ts`). A route that declares nothing is `service`, so a forgotten declaration fails closed. Both modes take a key in the `x-knowledge-key` header (never in a query string), but each accepts only its own: `service` routes take `KNOWLEDGE_SERVICE_KEY`, and `owner` routes take `KNOWLEDGE_OWNER_KEY`. The service key gets 401 on owner routes and the owner key gets 401 on service routes. Unknown paths answer 401 without the service key and 404 with it.

| Method | Path             | Purpose                                                                                                                           |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`        | Liveness (public)                                                                                                                 |
| POST   | `/retrieve`      | `{ query, k? }` returns `{ version, chunks[] }`; `k` defaults to 6, max 20                                                        |
| GET    | `/version`       | `{ version }`                                                                                                                     |
| POST   | `/documents`     | Multipart upload with a `file` part (`.pdf`, `.md`, `.txt`). Add `?kind=resume` for a resume. Returns 202, or 200 if a duplicate. |
| GET    | `/documents`     | List documents with status and chunk count                                                                                        |
| GET    | `/documents/:id` | One document                                                                                                                      |
| DELETE | `/documents/:id` | Deletes the document, its chunks and its file (204)                                                                               |

The `/documents` endpoints are `owner` routes, temporarily behind the owner key. Step 2 (#83) replaces it with an owner gate: a Supabase JWT whose `sub` equals `OWNER_AUTH_ID`. The auth plugin keeps one authenticator per access mode (`service`, `owner`); that step swaps only the `owner` entry (`buildApp({ authenticators: { owner } })`). Whatever an authenticator returns must be a safe storage-key segment, or the request gets 401. Handlers read the owner per request (`requireOwner(req)`).

The wire contract lives in the shared package [`packages/knowledge-types`](../packages/knowledge-types) (`@six7swe/knowledge-types`) as zod schemas with inferred types (request bodies, the document and chunk DTOs, the retrieve, version and upload responses, and the error body). The backend imports the same package, so both sides share one definition. Inside the service, `src/contract.ts` re-exports it. The package depends on nothing but zod and is compiled to CommonJS in its `dist/`, which `pnpm install` builds; after changing it, run `pnpm --filter @six7swe/knowledge-types build`. The database enums are derived from its `DOCUMENT_KINDS` and `DOCUMENT_STATUSES`.

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
2. Copy `.env.example` to `.env`, then set `KNOWLEDGE_SERVICE_KEY`, `KNOWLEDGE_OWNER_KEY` (a different value) and `OWNER_AUTH_ID`. The example file uses the offline `hashing` embedder and the local file store, so no API key is needed.
3. Apply the migrations: `pnpm --filter @six7swe/knowledge db:migrate`.
4. Start the service on port 3100: `pnpm dev:knowledge`.

To upload a file and query it:

```sh
curl -X POST "localhost:3100/documents?kind=resume" -H "x-knowledge-key: $KNOWLEDGE_OWNER_KEY" \
  -F file=@resume.pdf
curl -X POST localhost:3100/retrieve -H "x-knowledge-key: $KNOWLEDGE_SERVICE_KEY" \
  -H 'content-type: application/json' -d '{"query":"distributed systems experience"}'
```

The `hashing` embedder ranks results by shared words, not by meaning. For realistic retrieval quality, set `EMBEDDER=openai` and `OPENAI_API_KEY` (or `EMBEDDER=openrouter` and `OPENROUTER_API_KEY`; both use the same OpenAI-compatible client).

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

The service is the `@six7swe/knowledge` service in [`.railway/railway.ts`](../.railway/railway.ts), Railway's Infrastructure as Code for this repo. That file sets everything the service needs:

- the Railpack build (`cd knowledge && pnpm build`, from the repository root);
- the start command;
- the pre-deploy migration;
- the `/health` healthcheck, the restart policy and the watch paths;
- the `us-west2` region, next to the backend;
- private networking.

Railway does not read the file during deploys. A change to it (including creating this service) reaches Railway only when you apply it by hand:

```sh
railway config plan    # read-only: what would change
railway config apply   # plans again, asks for confirmation, then applies
```

An apply is declarative: a service, variable or domain that exists in Railway but not in the file is deleted. Read the plan before applying. See DEPLOYMENT.md, "Changing Railway config", for the one-time CLI setup.

> **Windows:** `railway config plan` and `apply` fail with "This version of railway/iac requires Railway CLI 5.42.1 or newer" even on a newer CLI. The SDK checks the version by running `$_` (or `railway`) without a shell, and the npm `railway`/`railway.cmd` shim can't be run that way. Call the native binary instead, or point `$_` at it, as DEPLOYMENT.md shows. This is tracked in #116.

Code pushes to `main` that touch `knowledge/` (or the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `tsconfig.base.json`) redeploy the service as usual.

- **Pre-deploy** runs `pnpm --filter @six7swe/knowledge db:migrate:prod`, the migrator compiled to `dist/db/migrate.js` by the build, run with plain `node`. It needs only runtime dependencies, not tsx, drizzle-kit or dotenv. CI runs the same compiled migrator against an empty database after the build.
- **Networking is private only.** The service has no public domain. The backends reach it at `http://six7sweknowledge.railway.internal:3100`, using plain HTTP: the private network is already encrypted. `HOST=::` is set in `railway.ts`, because older Railway environments resolve private names to IPv6 only. A public domain gets added in step 2 (#83) or step 7 (#89) if browser or Claude-client access needs one.
- **Shutdown.** On SIGTERM the service drains for up to 20 s, inside Railway's default 30 s stop window.

### Railway variables

`railway.ts` lists every variable the service uses. Secrets appear as `preserve()`, which keeps the value set in Railway, so you set their values in the Railway dashboard (or with `railway variables`), never in the file. `NODE_ENV=production`, `PORT=3100` and `HOST=::` are written in the file as literals.

The service validates its whole environment at boot and refuses to start if anything is missing or malformed. The error lists every problem at once, so a failed first deploy tells you exactly what to fix.

**Set these:**

| Variable                | Value                                                                   | Where to get it                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Postgres connection string for the same Supabase project as the backend | Supabase dashboard → **Connect**. Use the IPv4 connection string (Railway has no outbound IPv6). Any mode works (direct, session pooler on 5432, or transaction pooler on 6543), because prepared statements are off. This service only touches the `knowledge` and `knowledge_migrations` schemas. |
| `KNOWLEDGE_SERVICE_KEY` | A random secret, at least 32 characters                                 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Opens the service routes only (`/retrieve`, `/version`). The portfolio and hunter backends will need the same value when they start calling the service (step 3).                                                       |
| `KNOWLEDGE_OWNER_KEY`   | A different random secret, at least 32 characters                       | Same command. Opens the owner routes only (upload, list, delete), until the owner JWT gate replaces it (step 2). Must differ from `KNOWLEDGE_SERVICE_KEY`. Treat it like an admin password.                                                                                                         |
| `OWNER_AUTH_ID`         | Your Supabase auth user id (a UUID)                                     | Supabase dashboard → **Authentication → Users** → your user → **User UID**. Letters, digits, `.`, `_` and `-` only; it becomes the first segment of every storage key.                                                                                                                              |
| `OPENAI_API_KEY`        | An OpenAI API key                                                       | platform.openai.com → **API keys**. Required because `EMBEDDER` defaults to `openai`. Tip: create a dedicated project for this service with a monthly budget cap, and a key scoped to that project, so a runaway ingest can't run up the bill.                                                      |
| `SUPABASE_URL`          | `https://<project-ref>.supabase.co`                                     | Supabase dashboard → **Project Settings → Data API**.                                                                                                                                                                                                                                               |
| `SUPABASE_SECRET_KEY`   | A Supabase secret key (`sb_secret_…`, or the legacy `service_role` key) | Supabase dashboard → **Project Settings → API Keys**. Server-side only: it bypasses RLS. Required because `FILE_STORE` defaults to `supabase`.                                                                                                                                                      |

**Leave these unset.** They are not in `railway.ts`, so an apply would delete them anyway. To change one, add it to `railway.ts` first.

| Variable                   | Default                  | Notes                                                                                                                           |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDER`                 | `openai`                 | `openrouter` (needs `OPENROUTER_API_KEY`) also works; `hashing` is refused in production.                                       |
| `EMBEDDING_MODEL`          | `text-embedding-3-small` | `openai/text-embedding-3-small` with `EMBEDDER=openrouter`. Must output 1536 dimensions to match the `chunks.embedding` column. |
| `FILE_STORE`               | `supabase`               | `local` writes to the container's disk, which Railway wipes on every deploy.                                                    |
| `STORAGE_BUCKET`           | `portfolio-files`        |                                                                                                                                 |
| `MAX_UPLOAD_BYTES`         | `10485760` (10 MB)       | At most 50 MB; uploads are buffered in memory.                                                                                  |
| `RESUME_INGESTION_ON_BOOT` | `true`                   | Re-queues documents a previous instance left pending or processing.                                                             |

Don't set `LOCAL_FILE_STORE_DIR` (local store only) or `KNOWLEDGE_TEST_DATABASE_URL` (tests only).

### First deploy checklist

1. In the Supabase project, check that pgvector 0.8 or later is available (**Database → Extensions → vector**). The first migration enables it in the `extensions` schema, so you don't need to enable it by hand.
2. Create the Storage bucket `portfolio-files` (or your `STORAGE_BUCKET`) and make sure it is **private**. The service doesn't create it.
3. Run `railway config plan` and check that it only adds the `@six7swe/knowledge` service and its variables, with nothing destructive. Then run `railway config apply`.
4. Set the values of the variables in the first table on the new service.
5. Deploy (push to `main`, or redeploy from the dashboard). The pre-deploy step runs the migrations, and Railway waits for `GET /health` to return 200 before switching traffic.
6. Smoke-test from inside the private network. The service has no public domain, so you can't curl it from your laptop, and `railway run` runs commands on your machine, so it can't reach `*.railway.internal` either. Open a shell in the backend's container with `railway ssh` (select the backend service; this needs an SSH key registered with Railway), then run:

   ```sh
   node -e "fetch('http://six7sweknowledge.railway.internal:3100/version', { headers: { 'x-knowledge-key': process.argv[1] } }).then(async (r) => console.log(r.status, await r.text()))" "<KNOWLEDGE_SERVICE_KEY>"
   ```

   It should print `200 {"version":0}`. With the owner key instead, it should print a 401.
