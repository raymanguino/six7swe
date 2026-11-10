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
| 3 | `SUPABASE_SECRET_KEY` | Supabase project | Project → Settings → API Keys | Railway backend variables (if still set) |
| 4 | `DATABASE_URL` (password) | Supabase project | Project → Settings → Database → reset password | `backend/.env`, Railway backend variables |
| 5 | Second Supabase project password | Supabase project (us-west-2) | Project → Settings → Database → reset password | `backend/.env` (remove if unused) |
| 6 | MCP `x-brain-key` | MCP edge function | Open-brain MCP server → key management | `backend/.env` (`MCP_PORTFOLIO_HEADERS_JSON`, `MCP_PORTFOLIO_ARGS_JSON`) |

> Only one `DATABASE_URL` may be active in `backend/.env`. `dotenv` resolves
> duplicates by **last occurrence wins**, so a stale line silently overrides
> the intended one.

### Variables that were removed

`SUPABASE_SECRET_KEY` and `SUPABASE_STORAGE_BUCKET` used to sit in
`backend/.env` and **nothing read them** — `@supabase/supabase-js` is not a
dependency, and the resume is served from `backend/public/` on the local
filesystem. `DEPLOYMENT.md` previously described a Storage-based resume flow
that does not exist in the code.

They have been removed from `backend/.env`, `backend/.env.remote` and
`backend/.env.example`. `SUPABASE_SECRET_KEY` still has to be rotated, because
it was exposed, and it may still be set on Railway.

`SUPABASE_URL` stays. It is not a secret, and `backend/src/config/auth.ts` reads
it to fetch the JWKS that verifies the Supabase JWTs.

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

## 4. Database access lockdown

> **Status:** Confirmed exposure, now fixed. The anon key could read the
> portfolio table (resume, email address, phone number) and could write to
> every application table over the PostgREST API. Fixed on both the local and
> the hosted database on 2026-11-08.

### The problem

Supabase grants the `anon` and `authenticated` roles full privileges on every
table in the `public` schema, and row level security is **off** unless it is
turned on. Tables created by a migration do not get RLS automatically.

The frontend ships `VITE_SUPABASE_ANON_KEY` in the JavaScript bundle, and
`supabase/config.toml` exposes the `public` schema to PostgREST. The result
was that anyone with the anon key could read `portfolio_profile` (the full
resume, the email address and the phone number) and read, insert, update or
delete rows in `users`, `profiles`, `jobs`, `profile_jobs` and
`refresh_status`, without authenticating.

### The fix

Row level security is enabled on every application table, and the `anon` and
`authenticated` grants are revoked. No policies are created, so the default
is to deny every row. The default privileges are revoked as well, so a table
created later by a migration does not inherit the grants back.

Function execution is revoked too, including the default privilege. A function
in an exposed schema is an RPC endpoint for PostgREST, so one left executable
would be callable by the anon key. Note that the default grants EXECUTE to
`PUBLIC`, which `anon` inherits — revoking it from the named roles alone
leaves the function callable, so it has to be revoked from `PUBLIC`. That
revoke must use the **global** `ALTER DEFAULT PRIVILEGES` form; the
schema-scoped form leaves the built-in EXECUTE privilege in place.

The backend is unaffected: it connects as the table owner, and an owner
bypasses RLS.

### Running it

```bash
pnpm run db:secure                # local database
pnpm run db:secure -- --remote    # the hosted database
```

**This must run after every migration.** The Drizzle schema is the
source of truth for the tables, but Drizzle ORM 0.33 cannot express row level
security or role grants, so the rules live in `backend/src/db/security.ts`
and have to be applied separately. `db:reset` applies them automatically, and
the Railway `preDeployCommand` runs `db:migrate` followed by `db:secure`.

### Verifying it

```bash
curl "https://<project-ref>.supabase.co/rest/v1/portfolio_profile?select=email" \
  -H "apikey: <anon-key>"
```

A closed table returns `permission denied for table portfolio_profile`.

The regression test is `backend/src/__tests__/db/security.test.ts`.

### What is deliberately left alone

| Object | Why it is safe |
|---|---|
| `auth.*` | Supabase-managed. `anon` has no grant and PostgREST does not expose the schema. |
| `storage.*` | Supabase-managed and covered by its own row level security policies. The `portfolio-files` bucket is private (`public = false`), so the resume PDF is not readable by the anon key. |
| `realtime.*` | Supabase-managed service tables. Not exposed through PostgREST. |
| `graphql_public` | Exposed to PostgREST but holds no tables. |
| `supabase_admin` default privileges | Only apply to objects that role creates. The `postgres` role cannot alter another role's defaults, and nothing in this project creates objects as `supabase_admin`. |

The `supabase_read_only_user` and `supabase_etl_admin` roles can read the
tables. They are internal Supabase service roles and are not reachable from
a browser: PostgREST authenticates a request as `anon`, `authenticated` or
`service_role` only.

---

## 5. Preventive controls in place

| Control | Location | Purpose |
|---|---|---|
| Safe env allowlist | `backend/src/config/env.ts` | Prevents secrets reaching the health route |
| Pino redaction | `backend/src/index.ts` | Removes sensitive headers from logs |
| Secret masking | `backend/src/util/redact.ts` | Masks secret formats in upstream error bodies |
| Regression test | `backend/src/__tests__/env.test.ts` | Fails if a secret becomes exposed |
| Agent guidance | `.github/copilot-instructions.md` | Stops agents from repeating secrets in output |
| Editor guard | `.vscode/settings.json` | Excludes `.env` from agent search and file listing |
| Database lockdown | `backend/src/db/security.ts` | Revokes anon/authenticated grants and enables RLS |
| Lockdown regression test | `backend/src/__tests__/db/security.test.ts` | Fails if the access rules are weakened |

> The editor guard is a guardrail, not a control — an explicitly targeted read
> can still open the file. Rotation remains the real mitigation.

---

## 6. Reporting a suspected leak

1. Rotate the affected credential first (containment before investigation).
2. Check the audit steps in section 3.
3. Record what was exposed, where it went, and when it was rotated.
4. Update this document with the outcome.
