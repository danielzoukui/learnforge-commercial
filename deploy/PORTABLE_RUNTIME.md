# Portable Runtime — run LearnForge Commercial on any Node host

The commercial API was written for Netlify but only ever used two
platform-specific primitives. Both are now shimmed, so the same source tree runs
on Netlify **and** on any Docker/Node host:

| Netlify primitive | Portable equivalent |
| --- | --- |
| `Netlify.env.get("X")` | `runtime/env.mjs` installs a `Netlify.env` global backed by `process.env` |
| `getDatabase()` from `@netlify/database` | `runtime/database.mjs`, mapped in by `runtime/loader.mjs`; `db.sql` tagged template over `pg` |

Nothing under `netlify/functions/**` is rewritten — the same files, with the same
route declarations, are deployed to both targets.

## Quick start (local)

```bash
npm install

# 1. Point at any PostgreSQL. `DATABASE_URL` is the canonical name; the runtime
#    also accepts POSTGRES_URI, NETLIFY_DATABASE_URL, POSTGRES_URL or PG_CONNECTION_STRING.
export DATABASE_URL="postgres://user:pass@localhost:5432/learnforge"

# 2. Apply the three commercial migrations (idempotent, tracked in
#    commercial_schema_migrations).
npm run migrate --status     # dry run: what is pending
npm run migrate              # apply

# 3. Configure the app (all values the Netlify build would use).
export PUBLIC_SITE_URL="http://localhost:8080"
export SUPABASE_URL="https://<project>.supabase.co"
export SUPABASE_PUBLISHABLE_KEY="<anon-or-publishable-key>"
export STRIPE_SECRET_KEY="sk_test_..."
export STRIPE_WEBHOOK_SECRET="whsec_..."
export STRIPE_PRICE_FAMILY="price_..."
export STRIPE_PRICE_TEACHER="price_..."

# 4. Serve.
npm start        # → http://0.0.0.0:8080
```

`PORT` and `HOST` are honoured (`HOST` defaults to `0.0.0.0`, which is what
container platforms and preview proxies need).

## Docker

```bash
docker build -t learnforge-commercial .
docker run --rm -p 8080:8080 --env-file .env learnforge-commercial
```

The image copies only public assets, `netlify/` and `runtime/` — no release
archives, tests or CI configuration — and runs as the unprivileged `node` user.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` `/pricing.html` `/auth.html` `/support.html` `/privacy.html` `/terms.html` | Product pages (extensionless paths such as `/auth` also resolve) |
| `/commercial-api/health` | Database readiness — 200 when PostgreSQL answers, 503 otherwise |
| `/_runtime/health` | Liveness only, never touches the database — use this for container health checks |
| `/commercial-api/*` | The 15 handlers, mounted from their own `config.path` declarations |

## Behaviour parity with Netlify

| Aspect | Status |
| --- | --- |
| Route paths, methods, status codes, JSON bodies, cookies | Identical — same handler code |
| Security headers (`nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`) | Replicated from `netlify.toml` |
| `index.html` cache policy | Replicated (`no-cache, no-store, must-revalidate`); other `.html` → `no-cache` |
| Extra | gzip for compressible responses ≥ 1 KB, strong `ETag` + `304`, optional `SSE`-free streaming file sends |
| Unhandled exception → response | Portable runtime returns **500 JSON** and logs the handler name. Netlify returns its own 502 for the same failure — inspect your logs there rather than relying on a code path |
| Thrown `Response` from a handler (auth failures) | Served as-is with its real status. Verify Netlify's behaviour separately; the portable path is the one that is asserted by tests |

## Configuration mapping

| Netlify | Portable / container | Notes |
| --- | --- | --- |
| Netlify DB (provisioned) | `DATABASE_URL` / `POSTGRES_URI` | Any PostgreSQL 13+ |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY` | Same names | Unchanged |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FAMILY`, `STRIPE_PRICE_TEACHER` | Same names | Unchanged |
| `PUBLIC_SITE_URL` | Same name | Strongly recommended; falls back to the request `Origin` |
| — | `DATABASE_SSL=require` \| `disable` \| `verify-full` | Overrides TLS inference from `?sslmode=` in the connection string |
| — | `LEARNFORGE_DB_DRIVER=mock` | **Test suite only.** In-memory stub; never use to serve traffic |

## Tests

```bash
npm test         # 62 assertions: Netlify, Stripe signatures, exposure audit, portable runtime
npm run test:e2e # 13 checks against a real PostgreSQL (skips if DATABASE_URL is unset)
npm run check    # TypeScript check of the shared handler sources
npm run preflight -- --url https://your-domain   # go-live readiness check
```

The portable suite boots the real server against a stub Supabase instance and
verifies routing, session cookies, Stripe HMAC verification, fail-closed 503s,
migration idempotency, path traversal and archive exposure. The end-to-end suite
additionally drives a complete purchase against real PostgreSQL with a simulated
Stripe API: migrations → sign-up → checkout → signed webhook → entitlements →
replay deduplication → checkout sync → billing portal → cancellation.

## Static file policy

`runtime/router.mjs` serves an allow-list (known web extensions) and refuses
dotfiles, `.zip` archives, `.ts`/`.mts` sources, and the `netlify/`, `runtime/`,
`tests/`, `scripts/`, `deploy/` and `docs/` directories. Requests are resolved
inside the repository root, so `../` traversal cannot escape it. If you add an
asset type, add it to `PUBLIC_EXTENSIONS` in that file.
