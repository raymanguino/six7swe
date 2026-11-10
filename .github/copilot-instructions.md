
Rules:
- Routes never access the database directly
- Services orchestrate use cases
- Domain contains pure business logic only
- Infrastructure owns all side effects

---

## Architectural Rules (Hard Requirements)

- **Domain is pure**
  - No Fastify, MiniMax, Puppeteer, Drizzle, or Node APIs
  - No side effects
- **Side effects are infrastructure-only**
  - Database access
  - Network calls
  - Email sending
  - Web scraping
- **AI agent logic is isolated**
  - No HTTP or scraping concerns
  - Tooling accessed via MCP abstractions
- **No layer skipping**
  - Routes must not call infrastructure directly
  - Domain must not depend on services or infrastructure

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
- Infrastructure errors should be translated into domain-safe or HTTP-safe errors at boundaries
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
- Infrastructure tests optional
- Prefer fast, deterministic tests
- Avoid mocking domain logic

---

## Database & Data Modeling

- Use **Drizzle**
- The schema in `backend/src/db/schema/` is the source of truth. Migrations are generated
  from it with `pnpm run db:generate` and applied with `pnpm run db:migrate`
  - Tables and columns use `snake_case`
- Database models live in **infrastructure**
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
- Scraping logic isolated from business logic
- No scraping logic inside routes or services
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

## What NOT to Do

- Do not bypass layers
- Do not mix infrastructure with domain logic
- Do not add unnecessary abstractions
- Do not introduce cleverness at the cost of readability
- Do not generate large files without clear purpose

---

**Default bias:**  
Simple. Explicit. Observable. Boring in the best way.
