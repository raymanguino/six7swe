
Rules:
- Domain contains pure business logic only
- Route handlers handle HTTP only and call services
- Services orchestrate use cases and own the side effects
- Database queries live in `backend/src/db/api/`
- Plugins (`backend/src/plugins/`) wire services and `db/api` modules into Fastify as decorators; no business logic
- Known exception: `backend/src/services/portfolioService.ts` still queries Drizzle directly until #88; not a finding

---

## Architectural Rules (Hard Requirements)

- **Domain is pure** (`backend/src/domain/`)
  - No Fastify, MiniMax, Puppeteer, Drizzle, or Node APIs
  - No side effects
  - Must not depend on services, routes, or the database
- **Route handlers are thin** (`backend/src/routes/handlers/`)
  - Validate input, call a service, map the result or error to a response
  - Never query the database (importing a type from `db/schema` is fine)
  - Never call an external provider, the filesystem, or a browser directly
- **Services own the I/O** (`backend/src/services/`)
  - Orchestrate use cases and perform the side effects: external APIs
    (MiniMax, Resend, GitHub), Puppeteer, the filesystem, and the database
  - I/O in a service is the intended design, but input reaching a file path, URL, query, or
    command must still be validated
- **Queries live in `backend/src/db/api/`**
  - Called only from services and plugins; a handler or domain module importing `db/api` is a violation
  - No ad-hoc queries in services that bypass it
- **AI agent logic is isolated**
  - No HTTP or scraping concerns
  - Tooling accessed via MCP abstractions

---

## TypeScript & Coding Style

- `strict: true` always
- No `any` (ever)
- Prefer explicit types for public functions
- Async/await only
- No callbacks or promise chains
- Minimal comments
  - Code should be self-explanatory
  - Use comments only when intent is non-obvious

---

## Error Handling

- Use explicit error types
- Throw errors; do not silently swallow failures
- Provider and database errors should be translated into domain-safe or HTTP-safe errors at boundaries
- No `console.log` for errors

---

## Logging

- Structured logging only
- Use a proper logger (e.g. pino)
- Log meaningful events, not noise
- **Never log secrets**
- AI decisions must log:
  - Input summary
  - Match score
  - Final classification

---

## Formatting & Hygiene

- Prettier for formatting
- ESLint enforced
- Path aliases preferred over deep relative imports
- Dead code discouraged
- TODOs allowed, but must be explicit and actionable

---

## Testing

- Tests required for **core domain logic**
- Service and I/O tests optional
- Prefer fast, deterministic tests
- Avoid mocking domain logic

---

## Database & Data Modeling

- Use **Drizzle**
- The schema in `backend/src/db/schema/` is the source of truth. Migrations are generated
  from it with `pnpm run db:generate` and applied with `pnpm run db:migrate`
- Tables and columns use `snake_case`
- Domain entities must be mapped explicitly from DB models
- Transactions must be explicit (no implicit behavior)
- Constraints that protect invariants belong in the schema (e.g. partial unique indexes),
  not only in application logic

---

## AI Agent & Prompting Rules

- Prompts must be:
  - Structured
  - Deterministic
  - Schema-driven
- Low temperature by default
- Model outputs **must** be validated with Zod
- Prompts live in their own files (not inline strings)
- Agent behavior should be observable and debuggable
- No “chatty” prompts or prose-style instructions

---

## Scraping Rules

- Puppeteer only
- Scraping logic lives in `backend/src/services/jobFetchers/`, isolated from business logic
- No scraping logic inside routes, handlers, or the domain
- Scraped data must be normalized before entering the domain

---

## Configuration & Secrets

- Environment variables only
- Explicit config module
- Validate configuration at startup (Zod)
- Never hardcode secrets
- Never log secrets
- Assume Railway-style deployments

### Secrets in agent context

- Do not read `.env` (or any file containing live secrets) unless the task
  explicitly requires it. Prefer `.env.example`, which contains placeholders.
- Treat secret values as **write-only**: never repeat, quote, log, or write them
  into chat replies, code, comments, tests, commits, or PRs.
- Reference secrets by **variable name** (`MINIMAX_API_KEY`) or a masked form
  (`sk-…abcd`), never by value.
- When asked to "share", "document", or "summarize" config, describe variable
  names and purposes only — never values.
- If a secret value has already appeared in the transcript, tell the user it
  must be rotated.

---

## Pull Request Comments

- Never write `@copilot`, or any other bot mention, in a PR comment, reply, or description.
  A mention starts a Copilot coding agent session.
- Do not end replies with a request for re-review. Reviews come from the QA Review workflow
  (`.github/workflows/qa-review.yml`), which re-runs on every push and on title or description edits.
- Reply to a finding on its own terms: whether it holds, and what changed.

---

## What NOT to Do

- Do not bypass layers
- Do not mix I/O with domain logic
- Do not add unnecessary abstractions
- Do not introduce cleverness at the cost of readability
- Do not generate large files without clear purpose

---

**Default bias:**  
Simple. Explicit. Observable. Boring in the best way.
