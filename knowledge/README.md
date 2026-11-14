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

| Method | Path                     | Purpose                                                                                                                           |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                | Liveness (public)                                                                                                                 |
| POST   | `/retrieve`              | `{ query, k? }` returns `{ version, chunks[] }`; `k` defaults to 6, max 20                                                        |
| GET    | `/version`               | `{ version }`                                                                                                                     |
| POST   | `/documents`             | Multipart upload with a `file` part (`.pdf`, `.md`, `.txt`). Add `?kind=resume` for a resume. Returns 202, or 200 if a duplicate. |
| GET    | `/documents`             | List documents with status and chunk count                                                                                        |
| GET    | `/documents/:id`         | One document                                                                                                                      |
| GET    | `/documents/:id/text`    | `{ documentId, text }`: the extracted text, for previews; `text` is null until an ingest has extracted it                         |
| PUT    | `/documents/:id/primary` | Makes a ready resume the primary one; 409 for anything else                                                                       |
| DELETE | `/documents/:id`         | Deletes the document, its chunks and its file (204)                                                                               |
| POST   | `/search`                | The same as `/retrieve`, as an owner route, for the Knowledge page's "ask as a visitor" playground                                |
| GET    | `/profile/published`     | `{ profile, resume }`: the published profile and the primary resume (filename, `isPdf`, extracted text); either may be null       |
| GET    | `/resume.pdf`            | The primary resume's file when it is a PDF; 404 otherwise                                                                         |
| GET    | `/profile`               | `{ draft, published, drafting }`: both stages and the last drafting attempt, for the review screen                                |
| PUT    | `/profile/draft`         | `{ data }`: saves the owner's edits as the draft                                                                                  |
| POST   | `/profile/draft`         | Drafts again from the primary resume, in the background (202); 409 when drafting is off                                           |
| DELETE | `/profile/draft`         | Discards the draft (204)                                                                                                          |
| POST   | `/profile/publish`       | `{ draftUpdatedAt }`: publishes the draft the owner reviewed; 409 if it changed since, 404 if there is none                       |
| GET    | `/eval`                  | The chat eval set: settings, questions, the latest run with its diff, and whether a run is in progress                            |
| POST   | `/eval/runs`             | Runs the active eval questions now, in the background (202)                                                                       |
| POST   | `/eval/questions/:id`    | `{ action }`: `pin`, `unpin`, `retire`, `promote`, `off-topic` or `on-topic`; 409 when it cannot apply                            |

`/retrieve`, `/version`, `/profile/published` and `/resume.pdf` are `service` routes; `/documents/*`, `/search`, `/profile`, `/profile/draft`, `/profile/publish` and `/eval/*` are `owner` routes.

`/retrieve` also takes `record: true` with a `sessionId` (see the eval set below); `/search` never records.

## Chat eval set (#85)

A set of 10 active questions the corpus is checked against, which drifts from canned questions toward what visitors actually ask. It lives in `knowledge.eval_questions` (with `eval_question_sessions`), and each run in `eval_runs` and `eval_results`.

- **Recording.** The backend's chat sends `record: true` and the browser's random per-session id (kept in `sessionStorage`) with `/retrieve`, only when the query is the visitor's current question alone (a follow-up's query also carries the previous turn). The question is stored with emails and phone numbers masked, cut to 300 characters. Sessions are stored as SHA-256 hashes; no IP or chat history is stored. Recording runs in the background on its own serial queue, so it never delays or fails the retrieval. A cache hit in the backend still records, with a background `k=1` retrieval.
- **Clustering.** The recorded question reuses the retrieval's query embedding (re-embedded only when redaction changed the text) and is compared with the owner's questions by cosine similarity. At 0.85 or above it joins the nearest one, bumping `hit_count`, `distinct_sessions` and `last_asked_at`; below, it starts a `candidate`.
- **Promotion and eviction.** A candidate asked in 2 distinct sessions, and not off-topic, becomes `active`. When the active set is full, the active, unpinned question asked least recently is `retired` in the same transaction. If every active question is pinned, the candidate waits. A retired question is never promoted automatically.
- **Off-topic.** A new candidate is flagged off-topic when the corpus answered but its best chunk is below `EVAL_OFF_TOPIC_SIMILARITY` (default 0.15). The owner can flag or clear it; flagging an active question retires it.
- **Seeding and purging.** The owner's first eval view, recording or run seeds the 10 canned questions (`src/services/evalSet/canned.ts`) as active. Candidates not asked for 90 days are deleted (checked at most hourly per owner, when recording or viewing).
- **Runs.** A run is queued after every ingest attempt and every delete, and on the owner's request; a corpus-triggered run is skipped when the newest completed run is already at the current corpus version. For each active question it stores the chunk ids retrieved with the question's stored embedding, the top similarity, a gap flag (below `EVAL_GAP_SIMILARITY`, default 0.3, or nothing retrieved) and, with `EVAL_ANSWERER` set, an answer grounded in those chunks. `GET /eval` diffs the latest run against the newest completed run at an older corpus version. Runs are not durable: one cut off by a restart is marked failed on the next boot.
- **Owner controls** are on the Knowledge page, through the backend's `/knowledge/eval*` proxy.
- **`EVAL_ANSWERER`**: `none` (default: retrieval only), `minimax` (the drafter's MiniMax keys; `EVAL_ANSWER_MODEL` overrides the model) or `stub` (offline; refused in production). Production sets `minimax` in `railway.ts`. The thresholds depend on the embedder: the defaults suit text-embedding-3-small, and the offline `hashing` embedder scores differently.

The backend rate-limits the public `/chat` endpoint (`@fastify/rate-limit`, 10 messages a minute per client, keyed by the last `X-Forwarded-For` entry, which Railway's edge appends).

## Profile (#86)

The landing page's structured profile (name, title, location, summary, skills, experience, projects and links) lives here, in `knowledge.profiles`: at most one `draft` and one `published` row per owner. The schema is `ProfileDataSchema` in the shared contract; links must be http(s), so a `javascript:` URL can never reach the public site.

- **Drafting.** When a resume finishes ingesting and is the primary resume, the drafter (`PROFILE_DRAFTER`) writes a new draft from its extracted text, replacing any earlier draft. A resume that finishes but is not primary (an older one re-ingested) does not redraft. Drafting runs on its own serial queue, so a slow model never holds up ingestion, and its failure never fails the ingest. The model's JSON is normalized (empty strings to null, `https://` added to a bare link, invalid links and emails dropped) and then validated; anything else invalid fails the draft with a short reason the owner sees. Drafting is not durable: a restart drops a draft in progress and forgets the last status, and the owner can ask again.
- **Review and publish.** The owner's Knowledge page shows the draft as a field-by-field diff against the published profile, lets the owner edit it, and publishes it. Publishing copies the draft over the published row and deletes the draft, in one transaction, only if the draft is still the one reviewed (`draftUpdatedAt`).
- **The portfolio** (`PORTFOLIO_DATA_SOURCE=knowledge`) reads `/profile/published` and maps it to its `PortfolioData`, so the landing page needs no change. It caches it (stale-while-revalidate) and keeps serving the last good profile while this service is down. Publishing through the backend's proxy busts that cache. `/resume` serves `/resume.pdf`.
- **`PROFILE_DRAFTER`**: `none` (default: drafting off; the owner can still write a profile), `minimax` or `stub` (offline and deterministic, for development and tests; refused in production). Production sets `minimax` in `railway.ts`.
- **MiniMax** is the app's LLM provider; the drafter calls it the way the backend's chat does (`backend/src/services/minimaxService.ts`): `POST https://api.minimax.io/v1/chat/completions` with `max_completion_tokens` 8192 (reasoning shares the budget) and `reasoning_effort: medium`. An error in the 200 body (`base_resp`), a reply cut off at the token limit, and a leading `<think>` block are all handled; a 429 is retried once with `MINIMAX_API_KEY_SECONDARY` when set. The owner sees fixed messages; MiniMax's own details go to the logs. `PROFILE_DRAFT_MODEL` overrides the model (default `MiniMax-M3`). Drafting providers are separate from embedders: MiniMax cannot be an `EMBEDDER`, and embeddings still use `OPENAI_API_KEY`.

**The owner gate lives in the backend (#83).** The service is private-network only, so the browser never calls it. The owner's Knowledge page (`/hunter/knowledge`) calls the backend's `/knowledge/*` proxy (`backend/src/routes/knowledge.ts`). The backend verifies the Supabase JWT as it does for every route, requires `sub === OWNER_AUTH_ID` (403 for any other signed-in user, before the body is read), and forwards the request with `KNOWLEDGE_OWNER_KEY`. It never forwards the user's token. So the owner key stays the service's owner credential, and only the backend holds it.

The service does not verify the JWT again. The owner key is the only thing that opens owner routes, and the backend is its only holder. A second check would need the user's token forwarded and the JWKS configured here, and it would add nothing against a caller that already holds the key. The auth plugin keeps one authenticator per access mode (`service`, `owner`), so a caller with its own credential, such as the MCP adapter (#89), can replace the `owner` entry (`buildApp({ authenticators: { owner } })`). Whatever an authenticator returns must be a safe storage-key segment, or the request gets 401. Handlers read the owner per request (`requireOwner(req)`).

**Choosing the primary resume.** By default the newest ready resume is primary. `PUT /documents/:id/primary` picks another ready resume. That choice holds until another resume finishes ingesting (the newest-ready rule applies again) or the primary is deleted.

**Replacing a document** is done by the Knowledge page. It uploads the new file, waits until the new document is `ready`, and only then deletes the old one, so retrieval never loses the content in between. If the new document fails, or is still processing after 5 minutes, the old one is kept. If the new bytes are identical, the upload returns the existing document and nothing is deleted.

The wire contract lives in the shared package [`packages/knowledge-types`](../packages/knowledge-types) (`@six7swe/knowledge-types`) as zod schemas with inferred types (request bodies, the document and chunk DTOs, the retrieve, version, upload and document-text responses, and the error body). The backend imports the same package, so both sides share one definition. Inside the service, `src/contract.ts` re-exports it. The package depends on nothing but zod and is compiled to CommonJS in its `dist/`. `pnpm install` does not build it (a `prepare` hook would run before Railpack and the backend Dockerfile copy the source); instead the service's `build`, `typecheck` and `test` scripts build it first. Anything else that reads it, such as an editor, needs `pnpm build:types` after a change. The database enums are derived from its `DOCUMENT_KINDS` and `DOCUMENT_STATUSES`.

## Database

The service owns the `knowledge` schema, with these tables:

- `documents`
- `chunks` (embeddings in `vector(1536)`, HNSW cosine index)
- `corpus_state`
- `profiles` (the draft and published structured profile; see Profile above)
- `eval_questions`, `eval_question_sessions`, `eval_runs`, `eval_results` (the chat eval set; see above)

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
4. Start the service on port 3100: `pnpm dev:knowledge`. It listens on `HOST=::` by default, which accepts IPv6 and IPv4. Callers should still use `127.0.0.1` rather than `localhost`: Windows resolves `localhost` to `::1` first, which is refused if `HOST` is set to the IPv4-only `0.0.0.0`.
5. For the Knowledge page, set `OWNER_AUTH_ID`, `KNOWLEDGE_URL=http://127.0.0.1:3100` and `KNOWLEDGE_OWNER_KEY` (the same value) in `backend/.env`, then sign in to `/hunter` as that user. With `AUTH_DEV_BYPASS=true` the subject is `auth-dev-bypass`, so use that as `OWNER_AUTH_ID` on both sides.

To upload a file and query it:

```sh
curl -X POST "127.0.0.1:3100/documents?kind=resume" -H "x-knowledge-key: $KNOWLEDGE_OWNER_KEY" \
  -F file=@resume.pdf
curl -X POST 127.0.0.1:3100/retrieve -H "x-knowledge-key: $KNOWLEDGE_SERVICE_KEY" \
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
- **Networking is private only.** The service has no public domain. The backends reach it at `http://six7sweknowledge.railway.internal:3100`, using plain HTTP: the private network is already encrypted. `HOST=::` is set in `railway.ts`, because older Railway environments resolve private names to IPv6 only. The browser reaches the owner routes through the backend's `/knowledge/*` proxy, so no public domain is needed for it. Step 7 (#89) adds one if Claude-client access needs it.
- **Shutdown.** On SIGTERM the service drains for up to 20 s, inside Railway's default 30 s stop window.

### Railway variables

`railway.ts` lists every variable the service uses. Secrets appear as `preserve()`, which keeps the value set in Railway, so you set their values in the Railway dashboard (or with `railway variables`), never in the file. `NODE_ENV=production`, `PORT=3100` and `HOST=::` are written in the file as literals.

The service validates its whole environment at boot and refuses to start if anything is missing or malformed. The error lists every problem at once, so a failed first deploy tells you exactly what to fix.

**Set these:**

| Variable                    | Value                                                                   | Where to get it                                                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Postgres connection string for the same Supabase project as the backend | Supabase dashboard → **Connect**. Use the IPv4 connection string (Railway has no outbound IPv6). Any mode works (direct, session pooler on 5432, or transaction pooler on 6543), because prepared statements are off. This service only touches the `knowledge` and `knowledge_migrations` schemas. |
| `KNOWLEDGE_SERVICE_KEY`     | A random secret, at least 32 characters                                 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Opens the service routes only (`/retrieve`, `/version`). The portfolio and hunter backends will need the same value when they start calling the service (step 3).                                                       |
| `KNOWLEDGE_OWNER_KEY`       | A different random secret, at least 32 characters                       | Same command. Opens the owner routes only (documents, search). Set the backend's `KNOWLEDGE_OWNER_KEY` to the same value: the backend's owner proxy is its only holder. Must differ from `KNOWLEDGE_SERVICE_KEY`. Treat it like an admin password.                                                  |
| `OWNER_AUTH_ID`             | Your Supabase auth user id (a UUID)                                     | Supabase dashboard → **Authentication → Users** → your user → **User UID**. Letters, digits, `.`, `_` and `-` only; it becomes the first segment of every storage key.                                                                                                                              |
| `OPENAI_API_KEY`            | An OpenAI API key                                                       | platform.openai.com → **API keys**. Required because `EMBEDDER` defaults to `openai`. Tip: create a dedicated project for this service with a monthly budget cap, and a key scoped to that project, so a runaway ingest can't run up the bill.                                                      |
| `SUPABASE_URL`              | `https://<project-ref>.supabase.co`                                     | Supabase dashboard → **Project Settings → Data API**.                                                                                                                                                                                                                                               |
| `SUPABASE_SECRET_KEY`       | A Supabase secret key (`sb_secret_…`, or the legacy `service_role` key) | Supabase dashboard → **Project Settings → API Keys**. Server-side only: it bypasses RLS. Required because `FILE_STORE` defaults to `supabase`.                                                                                                                                                      |
| `MINIMAX_API_KEY`           | A MiniMax API key (the backend's value)                                 | Required because `railway.ts` sets `PROFILE_DRAFTER=minimax`; the service refuses to boot without it. Copy it from the backend service's variables.                                                                                                                                                 |
| `MINIMAX_API_KEY_SECONDARY` | Optional: a second MiniMax key                                          | Tried once when MiniMax answers 429 to the first. Copy it from the backend if set there; leave it empty otherwise.                                                                                                                                                                                  |

**Leave these unset.** They are not in `railway.ts`, so an apply would delete them anyway. To change one, add it to `railway.ts` first.

| Variable                    | Default                  | Notes                                                                                                                           |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDER`                  | `openai`                 | `openrouter` (needs `OPENROUTER_API_KEY`) also works; `hashing` is refused in production.                                       |
| `EMBEDDING_MODEL`           | `text-embedding-3-small` | `openai/text-embedding-3-small` with `EMBEDDER=openrouter`. Must output 1536 dimensions to match the `chunks.embedding` column. |
| `FILE_STORE`                | `supabase`               | `local` writes to the container's disk, which Railway wipes on every deploy.                                                    |
| `STORAGE_BUCKET`            | `portfolio-files`        |                                                                                                                                 |
| `MAX_UPLOAD_BYTES`          | `10485760` (10 MB)       | At most 50 MB; uploads are buffered in memory.                                                                                  |
| `RESUME_INGESTION_ON_BOOT`  | `true`                   | Re-queues documents a previous instance left pending or processing.                                                             |
| `EVAL_GAP_SIMILARITY`       | `0.3`                    | An active eval question whose best chunk scores below this is a knowledge gap.                                                  |
| `EVAL_OFF_TOPIC_SIMILARITY` | `0.15`                   | A new visitor question whose best chunk scores below this is never promoted automatically.                                      |

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

7. Set `OWNER_AUTH_ID` and `KNOWLEDGE_OWNER_KEY` on the backend (the same values as here; `KNOWLEDGE_URL` is written in `railway.ts`), sign in as the owner and open `/hunter/knowledge`.
