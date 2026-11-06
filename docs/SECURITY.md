# Security: Credential Rotation Checklist

> **Status:** Required action. Six live credentials were exposed through an
> unauthenticated endpoint and were read into an AI assistant session.
> Rotate every item below before deploying.

---

## 1. Background

The backend health check route (`GET /`) previously returned the full
`process.env` object. The route was unauthenticated and internet-reachable in
production, so anyone who requested it received live credentials.

**Fixed in code:**
- `backend/src/config/env.ts` — explicit allowlist (`NODE_ENV`, `PORT`, `HOST`)
- `backend/src/index.ts` — health route returns only `getSafeEnv()`
- `backend/src/index.ts` — Pino `redact` for sensitive request headers
- `backend/src/util/redact.ts` — masks secret formats in upstream error bodies
- `backend/src/__tests__/env.test.ts` — regression test locking the behaviour

**Still required:** rotating the credentials themselves. A code fix does not
invalidate a value that has already been disclosed.

---

## 2. Rotation checklist

| # | Variable | Scope | Rotate at | Update where |
|---|---|---|---|---|
| 1 | `MINIMAX_API_KEY` | minimax.io | Account → API keys → revoke + regenerate | `backend/.env`, Railway backend variables |
| 2 | `RESEND_API_KEY` | resend.com | Account → API Keys → revoke + regenerate | `backend/.env`, Railway backend variables |
| 3 | `SUPABASE_SECRET_KEY` | Supabase project | Project → Settings → API Keys | `backend/.env`, Railway backend variables |
| 4 | `DATABASE_URL` (password) | Supabase project | Project → Settings → Database → reset password | `backend/.env`, Railway backend variables |
| 5 | Second Supabase project password | Supabase project (us-west-2) | Project → Settings → Database → reset password | `backend/.env` (remove if unused) |
| 6 | MCP `x-brain-key` | MCP edge function | Open-brain MCP server → key management | `backend/.env` (`MCP_PORTFOLIO_HEADERS_JSON`, `MCP_PORTFOLIO_ARGS_JSON`) |

> Only one `DATABASE_URL` may be active in `backend/.env`. `dotenv` resolves
> duplicates by **last occurrence wins**, so a stale line silently overrides
> the intended one.

### Unused variables that still hold live values

`backend/.env` contains `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and
`SUPABASE_STORAGE_BUCKET`. **No code path reads them** — `@supabase/supabase-js`
is not a dependency, and the resume is served from `backend/public/` on the
local filesystem. `DEPLOYMENT.md` previously described a Storage-based resume
flow that does not exist in the code.

Rotate `SUPABASE_SECRET_KEY` along with the items above, and either remove these
variables or implement the Storage path before relying on them.

### Environment file layout

| File | Tracked | Purpose |
|---|---|---|
| `backend/.env.example` | ✅ | Template with placeholder values |
| `backend/.env` | ❌ | Local development (local database) |
| `backend/.env.remote` | ❌ | Copy pointing at the remote database |

Switch target with `DOTENV_CONFIG_PATH=.env.remote <command>`. Never commit a
populated env file, and never keep more than one active `DATABASE_URL` in a
single file.

---

## 3. Audit for misuse

- [ ] Check Railway **access logs** for requests to `GET /` before the fix
- [ ] Check Railway **deploy logs** for environment dumps
- [ ] Review Supabase project → Logs for unexpected connections
- [ ] Review minimax.io / resend.com usage dashboards for unexpected call volume
- [ ] Confirm no secret values were committed to git history:
      `git log -p --all -S 'sk-' -- backend/.env`

> `backend/.env` is gitignored (`.gitignore` → `.env`, `.env.*`,
> `!.env.example`), but verify history if the file was ever tracked.

---

## 4. Preventive controls in place

| Control | Location | Purpose |
|---|---|---|
| Safe env allowlist | `backend/src/config/env.ts` | Prevents secrets reaching the health route |
| Pino redaction | `backend/src/index.ts` | Removes sensitive headers from logs |
| Secret masking | `backend/src/util/redact.ts` | Masks secret formats in upstream error bodies |
| Regression test | `backend/src/__tests__/env.test.ts` | Fails if a secret becomes exposed |
| Agent guidance | `.github/copilot-instructions.md` | Stops agents from repeating secrets in output |
| Editor guard | `.vscode/settings.json` | Excludes `.env` from agent search and file listing |

> The editor guard is a guardrail, not a control — an explicitly targeted read
> can still open the file. Rotation remains the real mitigation.

---

## 5. Reporting a suspected leak

1. Rotate the affected credential first (containment before investigation).
2. Check the audit steps in section 3.
3. Record what was exposed, where it went, and when it was rotated.
4. Update this document with the outcome.
