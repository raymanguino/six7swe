# API collections

[Bruno](https://www.usebruno.com/) collections with a small, runnable example for every
route of the two HTTP services:

| Collection | Service | Default URL | Requests |
| --- | --- | --- | --- |
| [`backend/`](./backend) | Backend (portfolio, job hunter, knowledge owner proxy) | `http://127.0.0.1:3000` | 40 |
| [`knowledge/`](./knowledge) | Knowledge service (private network only in production) | `http://127.0.0.1:3100` | 25 |

Each collection stands alone. Open one folder in Bruno (**Open Collection**), or run it
headlessly. Use `127.0.0.1`, not `localhost`: Windows resolves `localhost` to `::1` first,
which fails when a service listens on IPv4 only.

Every request has a `docs` tab with its access mode and notable status codes, and a few
assertions on the response. Create requests store ids in collection variables (`profileId`,
`documentId`, `evalQuestionId`, ...) that the requests after them use, so run a folder top to
bottom.

## Prerequisites

1. Local database up and migrated (see [SETUP.md](../SETUP.md)): `supabase start`, then
   `pnpm --filter @six7swe/backend db:migrate` and
   `pnpm --filter @six7swe/knowledge db:migrate`.
2. The knowledge service on 3100: `pnpm dev:knowledge`.
3. The backend on 3000: `pnpm dev`.

The knowledge service can run offline with `EMBEDDER=hashing` and `FILE_STORE=local`.

## Credentials

Secrets are declared as `vars:secret` and committed empty. Fill them in Bruno
(**Environments**). Bruno keeps secret values in its own local store, not in the `.bru`
files, so they are not committed. Never paste a real key into an environment file.

### Backend (`accessToken`)

| Route group | Credential |
| --- | --- |
| Portfolio (`/`, `/resume`, `/chat`, `/fitcheck`, `/contact`) | none |
| Job hunter (`/job-hunt/*`) | `Authorization: Bearer {{accessToken}}`, a Supabase JWT |
| Knowledge proxy (`/knowledge/*`) | the same JWT; owner routes also need `sub === OWNER_AUTH_ID` (403 otherwise) |

With `AUTH_DEV_BYPASS=true` the backend authenticates every request as the local dev user
(`auth-dev-bypass`) before it reads the header, so `accessToken` can stay empty. To use the
owner routes that way, also set `OWNER_AUTH_ID=auth-dev-bypass` on **both** services. The
requests always send the bearer header, so the same files work against a real deployment
with a real token. The bypass is refused when `NODE_ENV=production`.

### Knowledge service (`serviceKey`, `ownerKey`, `mcpKey`)

There is no bypass here. Each route accepts only its own key, and the wrong one is a 401.

| Route group | Credential | Service setting |
| --- | --- | --- |
| `/health` | none | |
| Service: `/retrieve`, `/version`, `/profile/published`, `/resume.pdf` | `x-knowledge-key: {{serviceKey}}` | `KNOWLEDGE_SERVICE_KEY` |
| Owner: `/documents`, `/search`, `/profile`, `/eval` | `x-knowledge-key: {{ownerKey}}` | `KNOWLEDGE_OWNER_KEY` |
| `/mcp` | `Authorization: Bearer {{mcpKey}}` | `KNOWLEDGE_MCP_KEY` |

The backend's `KNOWLEDGE_OWNER_KEY` must equal the service's, and the backend's
`KNOWLEDGE_SERVICE_KEY` likewise. `/mcp` rejects any query string and is closed when no MCP
key is configured.

## Side effects

Requests that cost money, send email, call a model, or change the owner's data are **skipped**
unless the `allowSideEffects` environment variable is `true`. Those are `/chat`, `/fitcheck`,
`/contact`, starting a refresh or rescore, document upload, set-primary and delete, saving,
publishing, discarding and redrafting the profile, and the eval set: reading it, running it,
and the question actions.

The default run is read-only apart from creating and deleting a throwaway job profile.
Turn the variable on only against a database you are happy to change. Publishing
changes what the public portfolio shows.

`GET /eval` is on that list even though it is a GET. The service seeds the owner's canned
questions the first time the eval set is read, and it purges stale candidates and retired
visitor questions while answering, which deletes those rows for good. The owner's own
Knowledge page reads it on every visit, so nothing is lost that would not be lost anyway,
but a collection run can trigger the purge against a database the owner did not mean to
change.

## Running headlessly

```sh
npx @usebruno/cli run --env Local            # run from api/backend or api/knowledge
npx @usebruno/cli run --env Local --env-var allowSideEffects=true
npx @usebruno/cli run "03 Knowledge Proxy (owner)" --env Local
```

Pass secrets with `--env-var accessToken=...`; do not write them into a file.

Some requests accept more than one status because it depends on setup: `/resume` and
`/resume.pdf` are 404 until a resume is ready, redraft is 409 while `PROFILE_DRAFTER=none`,
and set-primary is 409 for a supporting document.

A few requests are skipped when the id they need was never produced, rather than being
sent with an empty one: the job lookup needs a job, and the document requests need the
upload above them. Run the folders top to bottom so the ids exist.

## Production

`backend/environments/Production.bru` has a placeholder host. Replace it locally; the
knowledge service is not reachable from outside Railway's private network, so it has no
production environment.
