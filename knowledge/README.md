# @six7swe/knowledge

The knowledge service holds the owner's professional background: resumes and supporting documents. It is the only source of that background: the portfolio chat, the fit check and the job hunter all retrieve their context from it, and the backend's `/resume` serves its primary resume. Everything uploaded is meant to answer a prospective employer's questions.

It replaced the earlier sources: an open-brain MCP path that was never wired to a working server, the hand-seeded portfolio tables, and a structured profile drafted from the resume and published by the owner (removed in #213).

## How it works

```
POST /documents ──► file store (Supabase Storage `portfolio-files`)
      │
      ▼  documents row: pending
 serial queue ──► extract text (unpdf for PDF; md/txt decoded)
      │          ──► risk scan (patterns + MiniMax; see Risk scan below)
      │          ──► chunk (markdown by headings; otherwise ~700-token windows, 15% overlap)
      │          ──► embed (OpenAI text-embedding-3-small, 1536d)
      ▼
 one transaction: replace chunks, store findings,
                  no findings: mark ready, bump corpus_version
                  any finding: mark needs_review (not served until the owner approves)

POST /retrieve {query, k} ──► embed query ──► pgvector cosine search (HNSW)
```

- **Deduplication.** Uploading identical bytes of a `ready` document again is a no-op, and never changes which resume is primary. Re-uploading a file that is not ready and not being worked on (its ingest failed, or a crash stranded it in `pending`/`processing`) stores the bytes again and retries it.
- **Corpus version.** `corpus_version` increases whenever the set of chunks retrieval can see changes: an ingest finishes, a ready document is deleted, or a ready document leaves `ready` (a re-ingest starts or fails). Callers use it as a cache key (every background cache in the backend is keyed to it, so a change reaches every backend replica without a cache bust), and the job hunter uses it to detect stale match scores.
- **Recovery.** Ingestion runs in-process. Each document's status lives in the database, so documents left `pending` or `processing` by a crash are queued again on boot. On shutdown the service stops taking requests, drops queued documents (they stay `pending` for the next boot) and waits up to 20 s for the one in progress.
- **Failed re-ingest.** If a re-ingest fails, the document is marked `failed`. Its previous chunks stay in the table but are no longer served, since retrieval only reads `ready` documents. Uploading the file again retries it.
- **Primary resume.** The owner's newest (by upload time) `ready` resume is primary. A resume becomes primary when its ingest completes, not on upload, so a resume whose ingest fails never displaces a good one. Deleting the primary promotes the next newest ready resume. A primary whose re-ingest fails stays primary until another resume completes or it is deleted.
- **Deleting a queued document** removes it from the queue, so the worker never processes it.
- **Errors.** A failed document's `error` is a short, user-facing reason (for example `Could not parse the PDF.` or `Embedding provider error (status 503)`). Provider responses and stack traces go to the logs only.

## API

Every route declares who may call it: `public`, `service`, `owner` or `mcp` (`src/plugins/serviceAuth.ts`). A route that declares nothing is `service`, so a forgotten declaration fails closed. `service` and `owner` take a key in the `x-knowledge-key` header (never in a query string), but each accepts only its own: `service` routes take `KNOWLEDGE_SERVICE_KEY`, and `owner` routes take `KNOWLEDGE_OWNER_KEY`. The service key gets 401 on owner routes and the owner key gets 401 on service routes. `mcp` takes its own key as `Authorization: Bearer` instead (see MCP adapter below). Unknown paths answer 401 without the service key and 404 with it.

| Method | Path                      | Purpose                                                                                                                                  |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                 | Liveness (public)                                                                                                                        |
| POST   | `/retrieve`               | `{ query, k? }` returns `{ version, chunks[] }`; `k` defaults to 6, max 20                                                               |
| GET    | `/version`                | `{ version }`                                                                                                                            |
| POST   | `/documents`              | Multipart upload with a `file` part (`.pdf`, `.md`, `.txt`). Add `?kind=resume` for a resume. Returns 202, or 200 if a duplicate.        |
| GET    | `/documents`              | List documents with status and chunk count                                                                                               |
| GET    | `/documents/:id`          | One document                                                                                                                             |
| GET    | `/documents/:id/text`     | `{ documentId, text }`: the extracted text, for previews; `text` is null until an ingest has extracted it                                |
| GET    | `/documents/:id/findings` | `{ document, findings[] }`: the last risk scan's findings (category, excerpt, reason, location)                                          |
| POST   | `/documents/:id/approve`  | Approves the findings as they are: `needs_review` becomes `ready`; a backfill-flagged ready document records the approval. 409 otherwise |
| PUT    | `/documents/:id/primary`  | Makes a ready resume the primary one; 409 for anything else                                                                              |
| DELETE | `/documents/:id`          | Deletes the document, its chunks and its file (204)                                                                                      |
| POST   | `/search`                 | The same as `/retrieve`, as an owner route, for the Knowledge page's "ask as a visitor" playground                                       |
| GET    | `/resume.pdf`             | The primary resume's file when it is a PDF; 404 otherwise                                                                                |
| GET    | `/eval`                   | The chat eval set: settings, questions, the latest run with its diff, and whether a run is in progress                                   |
| POST   | `/eval/runs`              | Runs the active eval questions now, in the background (202)                                                                              |
| POST   | `/eval/questions/:id`     | `{ action }`: `pin`, `unpin`, `retire`, `promote`, `off-topic` or `on-topic`; 409 when it cannot apply                                   |
| POST   | `/eval/example-clicks`    | `{ question }`: a chat visitor clicked that example question; bumps its `example_clicks` only (exact example texts; 400 otherwise)       |

`/retrieve`, `/version`, `/resume.pdf` and `/eval/example-clicks` are `service` routes; `/documents/*`, `/search` and the other `/eval/*` routes are `owner` routes; `/mcp` is an `mcp` route (`KNOWLEDGE_MCP_KEY`).

`/retrieve` also takes `record: true` with a `sessionId` (see the eval set below); `/search` never records.

## Risk scan (#212)

Everything uploaded is treated as public: the chat answers from it and quotes it. So every ingest scans the extracted text before the document can be searched (`src/services/risk/`).

- **Deterministic checks** always run: email addresses and phone numbers (the eval set's masking patterns, `services/evalSet/redact.ts`), street addresses (a number, capitalised words and a capitalised suffix, so prose like "drive adoption" does not match), PO boxes, Canadian postal codes and US "City, ST 12345", credential shapes (PEM key headers, AWS access key ids, GitHub tokens, `sk-` keys, and `password`/`secret`/`api_key`/`access_token`/`auth_token`/`token` assigned a value on the same line, quoted or not), and text aimed at the scan itself ("ignore/disregard/forget/override ... previous/above/earlier ...", an order about the system prompt, a `findings: [` answer), matched on an NFKC-normalised copy with zero-width characters removed. The model reads the document, so the document can try to talk it out of a finding; these checks cannot be talked out of anything. The model's prompt also restates the task after the document. Every pattern is bounded or anchored, so each runs in linear time over the whole text. Credentials, from either pass, are stored masked: a short prefix and the length (`AKIA[redacted, 20 chars]`), or the key with its value redacted (`password: [redacted, 8 chars]`).
- **The model pass** (`RISK_SCANNER`) asks MiniMax for personal contact details, a home address, compensation or salary expectations, references' personal details, employer-confidential or NDA material, health, family or immigration details, credentials or keys, and negative remarks about named people. Long text is read in 20,000-character windows (at most 8); the whole pass gives up after 5 minutes.
- **Findings** (category, source, excerpt, reason, and location: a character offset into the extracted text; `page` is null because PDF pages are merged on extraction) are stored with the document (`documents.risk_findings`). None: the document becomes `ready`. Any: it becomes `needs_review`, which retrieval never serves, and a resume in review is never primary (so `/resume.pdf` cannot serve it).
- **A scan that cannot finish** (provider down, timeout, an answer cut off or not in the expected shape) adds a `scan_failed` finding, so the document is held for review. It never becomes `ready` unscanned. Uploading the same file again rescans it, as the finding says. Text too long to read in full, and findings past the cap of 100, add a note instead (category `other`, source `scan`), since a rescan would not change them. A model finding that quotes no excerpt is kept with an empty one.
- **Review.** The Knowledge page lists flagged documents with their findings. **Approve as is** (`POST /documents/:id/approve`) makes a held document `ready` and records `approved_at`; whether the approval made it searchable is decided under the owner lock, so two approvals never both start an eval run. **Replace file** uses the page's replace flow, which uploads the new file (scanned again); see Replacing a document below. There is no in-app editing, so the stored file and its searchable text never diverge. Re-uploading the same bytes of a held document is a no-op, like a ready one, unless its scan failed.
- **Backfill.** On boot, ready documents never scanned (everything ingested before the scan existed) are scanned once on their own serial queue. They stay `ready` and searchable whatever is found, so the live chat loses nothing; their findings show on the Knowledge page until the owner approves them (which records `approved_at`) or replaces the file. A scan whose model pass could not finish, or that a restart cut off, records nothing and is redone on the next boot. With no `RISK_SCANNER` model configured the backfill does not run, so nothing is marked scanned on the pattern checks alone.
- **`RISK_SCANNER`**: `minimax` (the MiniMax keys; see MiniMax below; `RISK_SCAN_MODEL` overrides the model), `stub` (offline, flags lines mentioning salary, credentials or NDAs; refused in production) or `none` (patterns only; refused in production). Unset, it is `minimax` when `MINIMAX_API_KEY` is set and `none` otherwise. Production sets `minimax` in `railway.ts`. Only finding counts are logged, never excerpts.

## MCP adapter (#89)

This is the owner's private MCP server. The public one, which anyone's MCP client can use without a key, is the backend's `POST /mcp/public` (#205; see `docs/architecture.md`), which reaches this service with the service key only. This service has no public domain.

`POST /mcp` is a stateless streamable-HTTP MCP endpoint for your own Claude clients. Each request builds a new `McpServer` and transport (nothing is shared between requests), and `GET`/`DELETE` answer 405. It is a thin adapter over the same service functions as the routes above, and acts for `OWNER_AUTH_ID`.

| Tool                | What it does                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_background` | `{ query, k? }`: the same retrieval as `/search` (never recorded in the eval set)                                                                   |
| `list_documents`    | The documents with kind and status                                                                                                                  |
| `get_resume_pdf`    | The primary resume PDF as an embedded `resource` content block (`application/pdf`, base64 `blob`); a tool error if there is none or it is over 5 MB |

**Auth.** It is the `mcp` access mode: its own key, `KNOWLEDGE_MCP_KEY` (at least 32 characters, different from the other two), as `Authorization: Bearer <key>`, because that is what MCP clients send. The service key, the owner key and the `x-knowledge-key` header do not open it, and the MCP key opens nothing else. If `KNOWLEDGE_MCP_KEY` is unset, `/mcp` is disabled and every request gets 401; the service still boots. Any query string gets 401, so a key in the URL never works. The service is private-network only, so reach it through your own private route (for example a tunnel or VPN into Railway's network), not a public domain.

Add it to Claude Code:

```sh
claude mcp add --transport http six7swe-knowledge http://<knowledge-host>:3100/mcp   --header "Authorization: Bearer $KNOWLEDGE_MCP_KEY"
```

## Chat eval set (#85)

A set of 10 active questions the corpus is checked against. It starts from canned questions; the owner steers it toward what visitors actually ask by promoting their questions. It lives in `knowledge.eval_questions` (with `eval_question_sessions`), and each run in `eval_runs` and `eval_results`.

- **Recording.** The backend's chat sends `record: true` and the browser's random per-session id (kept in `sessionStorage`) with `/retrieve`, only when the query is the visitor's current question alone (a follow-up's query also carries the previous turn). The backend's public MCP endpoint (#205) records only a few `search_background` queries a day (the first `PUBLIC_MCP_CLIENT_DAILY_RECORD_CAP` per client, up to `PUBLIC_MCP_DAILY_RECORD_CAP` overall), each under the client's stable session id (an HMAC of its client key with a per-process secret), so one client asking the same thing twice counts as one session; a backend restart gives every client a new id. The question is stored with emails, links, @handles and phone numbers masked, cut to 300 characters. Sessions are stored as SHA-256 hashes; no IP or chat history is stored. Recording runs in the background on its own serial queue (at most 100 waiting), so it never delays or fails the retrieval. A cache hit in the backend still records, with a background `k=1` retrieval. The owner's `/search` is strict and never records.
- **Clustering.** The recorded question reuses the retrieval's query embedding (re-embedded only when redaction changed the text) and is compared with the owner's candidate and active questions by cosine similarity. At 0.85 or above it joins the nearest one, bumping `hit_count`, `distinct_sessions` and `last_asked_at`; below, it starts a `candidate`. Retired questions are never matched, so a question like a retired one starts a fresh candidate.
- **Promotion is the owner's.** Recording never changes a question's status: session ids are chosen by the client, so counts can be gamed. A candidate asked in 2 or more distinct sessions, and not off-topic, is only marked _suggested_ on the Knowledge page. The owner promotes; that retires the active, unpinned questions asked least recently, in the same transaction, until the new one fits (one, unless the set was over its size). If every active question is pinned, the promotion is refused (409). Owner actions on a question are status-guarded under the same per-owner lock as promotion, so a pin never lands on a question a promotion just retired.
- **Off-topic.** A new candidate is flagged off-topic when the corpus answered but its best chunk is below `EVAL_OFF_TOPIC_SIMILARITY` (default 0.15). The owner can flag or clear it; flagging an active question retires it. An off-topic candidate is never suggested; the owner can still promote it.
- **Example questions (#205).** Each of the chat widget's example questions (`CHAT_EXAMPLE_QUESTIONS` in `@six7swe/knowledge-types`, at most 6, of which the widget shows a random 3 or 4) is seeded once as an active, pinned question of origin `example`, retiring the least recently asked unpinned active questions to make room, so every run checks that each suggestion gets a good answer. An example that cannot fit (every other active question is pinned), or cannot be embedded, is skipped and logged, and tried again at most once a minute (`SEED_RETRY_MS`), so it is seeded soon after the owner frees a slot or the embedder is back. The pool has to stay at or below the active size minus 4 (a test enforces it): pinned questions are never evicted, so a larger pool would block promotions. A clicked example is not recorded as a question: the backend's `/chat` sees `example: true` on an exact example text, leaves out the session id, and calls `POST /eval/example-clicks`, which bumps `example_clicks` on the example with exactly that text (no embedding, no clustering, no candidate, no `hit_count` or session). The Knowledge page shows the click count apart from the typed counts, and suggestions still come from typed and MCP questions only. A typed question can still join an example's cluster like any active question. Changing an example's text seeds a new question, and the next seeding retires and unpins the old one. A click never seeds: an example with no question yet is simply not counted.
- **Seeding and purging.** The owner's first eval view, recording or run seeds the canned questions (`src/services/evalSet/canned.ts`) as active, as many as the examples leave room for. Candidates not asked for 90 days, and visitor questions retired more than 90 days ago, are deleted (canned and example questions never are). Retirement is timed by `retired_at` (set when a question is retired or evicted, cleared when it comes back), not by the last ask, so a retired question stays listed, and can be promoted again, for the full 90 days (checked at most hourly per owner, when recording or viewing; a failure is logged and retried next time, never failing either). An owner keeps at most 500 candidates; the least recently asked go first.
- **Runs.** A run is queued after every ingest attempt and every delete, and on the owner's request; a corpus-triggered run is skipped when the newest completed run is already at the current corpus version. Up to 3 questions are worked on at once, results in order. For each active question it stores the chunk ids retrieved with the question's stored embedding, the top similarity, a gap flag (below `EVAL_GAP_SIMILARITY`, default 0.3, or nothing retrieved) and, with `EVAL_ANSWERER` set, an answer grounded in those chunks (given up after 60 s, recording retrieval only). `GET /eval` diffs the latest run against the newest completed run at an older corpus version: a result is `changed` when its chunks, gap flag or top similarity moved; a reworded answer is reported but never makes a result `changed`, since model answers vary. Runs are not durable: one cut off by a restart is marked failed on the next boot, and the old instance can no longer close it.
- **Owner controls** are on the Knowledge page, through the backend's `/knowledge/eval*` proxy.
- **`EVAL_ANSWERER`**: `none` (default: retrieval only), `minimax` (the MiniMax keys; `EVAL_ANSWER_MODEL` overrides the model) or `stub` (offline; refused in production). Production sets `minimax` in `railway.ts`. The thresholds depend on the embedder: the defaults suit text-embedding-3-small, and the offline `hashing` embedder scores differently.

The backend rate-limits the public `/chat` endpoint (`@fastify/rate-limit`, 10 messages a minute per client, keyed by the last `X-Forwarded-For` entry, which Railway's edge appends).

## MiniMax

MiniMax is the app's LLM provider. The risk scan's model pass and the eval answerer call it the way the backend's chat does (`backend/src/services/minimaxService.ts`, shared client in `src/services/llm/minimax.ts`): `POST https://api.minimax.io/v1/chat/completions` with `max_completion_tokens` 8192 (reasoning shares the budget) and `reasoning_effort: medium`. An error in the 200 body (`base_resp`), a reply cut off at the token limit, and a leading `<think>` block are all handled; a 429 is retried once with `MINIMAX_API_KEY_SECONDARY` when set. The owner sees fixed messages; MiniMax's own details go to the logs. Chat model providers are separate from embedders: MiniMax cannot be an `EMBEDDER`, and embeddings still use `OPENAI_API_KEY`.

## The backend

- **Chat** retrieves for each question (and the last user turn), cached by `(corpus version, question)`; the version is re-read at most every 30 s.
- **Fit check** retrieves with the job description as the query, through the same cache.
- **Job hunter** retrieves with each job description, plus one fixed overall-background query cached by corpus version.
- **`/resume`** serves `/resume.pdf`, cached by corpus version.

None of them keep a copy of the background outside these version-keyed caches, so an upload or delete reaches them without a restart.

**The owner gate lives in the backend (#83).** The service is private-network only, so the browser never calls it. The owner's Knowledge page (`/hunter/knowledge`) calls the backend's `/knowledge/*` proxy (`backend/src/routes/knowledge.ts`). The backend verifies the Supabase JWT as it does for every route, requires `sub === OWNER_AUTH_ID` (403 for any other signed-in user, before the body is read), and forwards the request with `KNOWLEDGE_OWNER_KEY`. It never forwards the user's token. So the owner key stays the service's owner credential, and only the backend holds it.

The service does not verify the JWT again. The owner key is the only thing that opens owner routes, and the backend is its only holder. A second check would need the user's token forwarded and the JWKS configured here, and it would add nothing against a caller that already holds the key. The auth plugin keeps one authenticator per access mode (`service`, `owner`, `mcp`), so a caller with its own credential, can replace the `owner` entry (`buildApp({ authenticators: { owner } })`). Whatever an authenticator returns must be a safe storage-key segment, or the request gets 401. Handlers read the owner per request (`requireOwner(req)`).

**Choosing the primary resume.** By default the newest ready resume is primary. `PUT /documents/:id/primary` picks another ready resume. That choice holds until another resume finishes ingesting (the newest-ready rule applies again) or the primary is deleted.

**Replacing a document** is done by the Knowledge page. It uploads the new file, waits until the new document is `ready`, and only then deletes the old one, so retrieval never loses the content in between. If the risk scan holds the new document in `needs_review`, a searchable old one is kept until the owner approves the new one on the page, which then deletes it (after a reload, the owner deletes it by hand); an old one that is itself in review is deleted straight away. If the new document fails, or is still processing after 5 minutes, the old one is kept. If the new bytes are identical, the upload returns the existing document and nothing is deleted.

The wire contract lives in the shared package [`packages/knowledge-types`](../packages/knowledge-types) (`@six7swe/knowledge-types`) as zod schemas with inferred types (request bodies, the document and chunk DTOs, the retrieve, version, upload and document-text responses, and the error body). The backend imports the same package, so both sides share one definition. Inside the service, `src/contract.ts` re-exports it. The package depends on nothing but zod and is compiled to CommonJS in its `dist/`. `pnpm install` does not build it (a `prepare` hook would run before Railpack and the backend Dockerfile copy the source); instead the service's `build`, `typecheck` and `test` scripts build it first. Anything else that reads it, such as an editor, needs `pnpm build:types` after a change. The database enums are derived from its `DOCUMENT_KINDS` and `DOCUMENT_STATUSES`.

## Database

The service owns the `knowledge` schema, with these tables:

- `documents`
- `chunks` (embeddings in `vector(1536)`, HNSW cosine index)
- `corpus_state`
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
| `KNOWLEDGE_SERVICE_KEY`     | A random secret, at least 32 characters                                 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Opens the service routes only (`/retrieve`, `/version`, `/resume.pdf`). The backend needs the same value: it is required there in production.                                                                           |
| `KNOWLEDGE_OWNER_KEY`       | A different random secret, at least 32 characters                       | Same command. Opens the owner routes only (documents, search). Set the backend's `KNOWLEDGE_OWNER_KEY` to the same value: the backend's owner proxy is its only holder. Must differ from `KNOWLEDGE_SERVICE_KEY`. Treat it like an admin password.                                                  |
| `KNOWLEDGE_MCP_KEY`         | Optional: a third random secret, at least 32 characters                 | Same command. Opens `/mcp` only, as a bearer token, for your own Claude clients. Unset disables `/mcp`. Must differ from the other two keys. A change to `railway.ts` needs `railway config plan` then `apply` by hand.                                                                             |
| `OWNER_AUTH_ID`             | Your Supabase auth user id (a UUID)                                     | Supabase dashboard → **Authentication → Users** → your user → **User UID**. Letters, digits, `.`, `_` and `-` only; it becomes the first segment of every storage key.                                                                                                                              |
| `OPENAI_API_KEY`            | An OpenAI API key                                                       | platform.openai.com → **API keys**. Required because `EMBEDDER` defaults to `openai`. Tip: create a dedicated project for this service with a monthly budget cap, and a key scoped to that project, so a runaway ingest can't run up the bill.                                                      |
| `SUPABASE_URL`              | `https://<project-ref>.supabase.co`                                     | Supabase dashboard → **Project Settings → Data API**.                                                                                                                                                                                                                                               |
| `SUPABASE_SECRET_KEY`       | A Supabase secret key (`sb_secret_…`, or the legacy `service_role` key) | Supabase dashboard → **Project Settings → API Keys**. Server-side only: it bypasses RLS. Required because `FILE_STORE` defaults to `supabase`.                                                                                                                                                      |
| `MINIMAX_API_KEY`           | A MiniMax API key (the backend's value)                                 | Required because `railway.ts` sets `RISK_SCANNER=minimax` and `EVAL_ANSWERER=minimax`; the service refuses to boot without it. Copy it from the backend service's variables.                                                                                                                        |
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
| `EVAL_OFF_TOPIC_SIMILARITY` | `0.15`                   | A new visitor question whose best chunk scores below this is flagged off-topic (never suggested).                               |

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
