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

- **Deduplication.** Uploading identical bytes again is a no-op. Re-uploading a file whose ingest failed retries it.
- **Corpus version.** `corpus_version` increases whenever the set of ready chunks changes: an ingest finishes or a ready document is deleted. Callers use it as a cache key, and the job hunter will use it to detect stale match scores.
- **Recovery.** Ingestion runs in-process. Each document's status lives in the database, so documents left `pending` or `processing` by a crash are queued again on boot.
- **Failed re-ingest.** If a re-ingest fails, the document is marked `failed` and its previous chunks stay in place.

## API

Every route except `GET /health` requires the `x-knowledge-key` header. The key is never accepted in a query string.

| Method | Path             | Purpose                                                                       |
| ------ | ---------------- | ----------------------------------------------------------------------------- |
| GET    | `/health`        | Liveness (public)                                                             |
| POST   | `/retrieve`      | `{ query, k? }` returns `{ version, chunks[] }`; `k` defaults to 6, max 20     |
| GET    | `/version`       | `{ version }`                                                                 |
| POST   | `/documents`     | Multipart upload with a `file` part (`.pdf`, `.md`, `.txt`). Add `?kind=resume` for a resume. Returns 202, or 200 if a duplicate. |
| GET    | `/documents`     | List documents with status and chunk count                                    |
| GET    | `/documents/:id` | One document                                                                  |
| DELETE | `/documents/:id` | Deletes the document, its chunks and its file (204)                           |

The document endpoints are temporarily behind the service key. A later step replaces that with an owner gate: a Supabase JWT whose `sub` equals `OWNER_AUTH_ID`.

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
pnpm --filter @six7swe/knowledge db:generate   # write a migration from a schema change
pnpm --filter @six7swe/knowledge db:migrate    # apply migrations (uses DATABASE_URL)
```

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

The Postgres integration suite runs only when `KNOWLEDGE_TEST_DATABASE_URL` is set. It writes under a random owner id and cleans up afterwards:

```sh
KNOWLEDGE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm --filter @six7swe/knowledge test
```

## Deploy

The service deploys as its own Railway service, with the config file path set to `knowledge/railway.json`.

- The pre-deploy step runs `db:migrate`.
- Required variables:
  - `DATABASE_URL`
  - `KNOWLEDGE_SERVICE_KEY`
  - `OWNER_AUTH_ID`
  - `OPENROUTER_API_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_SECRET_KEY`
- The `portfolio-files` bucket must exist and be private.
