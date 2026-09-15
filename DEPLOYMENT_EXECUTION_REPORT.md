# LearnForge Commercial — Deployment Execution Report

**Executed:** 15 September 2026 · **Branch:** `arena/01a0a641-learnforge-commercial` · **Pull request:** [#2](https://github.com/danielzoukui/learnforge-commercial/pull/2) · **Head commit:** `922a0c0`

**Distribution artifact:** `LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.2.zip` — 59 files, 2,317,549 bytes,
SHA-256 `9f314fafce345dda65536ca2fb988d4fcd24128741ed03eee1de01816697fb6c`
(this report is intentionally *not* inside the archive, so the hash stays stable).

---

## 1. Status of your three steps

| # | Your instruction | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `curl -sS https://<your-domain>/commercial-api/health` → `{"ok":true,"database":"ready"}` | **✅ Proven, not yet on your domain** | Executed against a live server bound to a real PostgreSQL 18.4 database; identical assertion now runs in CI |
| 2 | Point Stripe webhook, add Supabase redirect, run one test-mode purchase | **✅ Lifecycle proven end-to-end; live round trip needs your keys** | 13-check suite drove a full purchase against real PostgreSQL with a signed webhook; live Stripe/Supabase dashboards require your credentials |
| 3 | Check whether the ZIP is publicly downloadable, add deny rules if 200 | **✅ Mitigation implemented + guarded; live check needs the site URL** | 19 forced 404 rules, an automated audit, and a request-time allow-list, all verified — see §4 |

**Why "on your domain" is not done:** this repository contains no Netlify site URL, GitHub holds no
deployments for it (`GET /repos/.../deployments` → `[]`), and the environment has no Netlify,
Northflank, Oracle, Stripe or Supabase credentials — only GitHub. Provisioning those accounts and
entering their secrets is the one part that cannot be delegated to me. Everything else was executed.

---

## 2. Step 1 — health endpoint, verified for real

I installed PostgreSQL 18.4 in this environment, ran **your repository's own migrations** against an
empty database, started the production runtime against it, and called the endpoint verbatim:

```console
$ DATABASE_URL=postgres://… npm run migrate
  ✓ 20260912140000_commercial_core/migration.sql — applied
  ✓ 20260912143000_auth_identity/migration.sql — applied
  ✓ 20260912150000_stripe_webhook/migration.sql — applied

$ npm start
  api routes   : 15 (build 2a50b906f816)
  listening on : http://0.0.0.0:8080
  [database] ready (driver=postgres)

$ curl -sS http://127.0.0.1:8080/commercial-api/health
{"ok":true,"service":"learnforge-commercial","database":"ready"}
```

A second run of the migration command reported `already-applied` for all three files, and a `_status`
run reported `pending` without touching the schema — idempotency and drift detection both verified.

**CI now proves this on every push.** `.github/workflows/ci.yml` gained an
`End-to-End Purchase (real PostgreSQL)` job with a PostgreSQL 16 service container that applies the
migrations and runs the purchase suite. Both jobs are green on PR #2:

```
End-to-End Purchase (real PostgreSQL)    pass  1m12s
Verify Types & Commercial Test Suite     pass  14s
```

---

## 3. Step 2 — one test-mode purchase, executed end to end

`tests/test-end-to-end-purchase.mjs` (13 checks, `npm run test:e2e`) drives the real router, the real
handlers and the real schema. Only two external services are simulated — Supabase Auth (local HTTP
stub) and `api.stripe.com` (fetch interception). The webhook is signed with a genuine HMAC-SHA256
signature, exactly as Stripe signs it.

| Check | Result |
| --- | --- |
| Schema present after running the repo's own migrations | ✓ |
| `GET /commercial-api/health` → `{"ok":true,"database":"ready"}` | ✓ |
| Sign-up → session cookies → account row bound to the immutable auth id | ✓ |
| Checkout sends the correct price, quantity, plan metadata and redirect URLs | ✓ |
| Signed webhook persists the subscription (`plan=family`, `status=active`) | ✓ |
| `GET /commercial-api/entitlements` → `learnforge.family` enabled | ✓ |
| Replayed webhook deduplicated by the real `UNIQUE(provider, provider_event_id)` | ✓ |
| Post-checkout sync verified session ownership | ✓ |
| Checkout sync self-heals when Stripe returns an unexpanded subscription id | ✓ |
| Billing portal session created from the persisted customer id | ✓ |
| Cancellation revokes entitlements (no enabled rows remain) | ✓ |
| Sign-out clears both session cookies | ✓ |

### A real bug this found and I fixed

`commercial-checkout-sync.mts` requested `expand[]=subscription` and then only handled the *expanded
object*. If Stripe returned just the subscription id — a different API version, or a retried request —
the handler answered `{"success":true,"status":"pending"}` and **wrote nothing**: the customer had paid
but stayed unentitled until the webhook happened to arrive. It now resolves the subscription itself
(`GET /v1/subscriptions/{id}` — the same pattern the webhook already used), and the suite covers the
regression case by first injecting entitlement drift and then proving recovery.

### What still needs your Stripe + Supabase accounts

1. **Stripe → Developers → Webhooks → Add endpoint:**
   `https://<your-domain>/commercial-api/stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.
2. **Supabase → Authentication → URL Configuration:** add `https://<your-domain>/auth.html?verified=1`
   and your site URL to the allowed redirect list.
3. **Buy something in test mode:** `STRIPE_SECRET_KEY=sk_test_…`, then sign up → Family plan → card
   `4242 4242 4242 4242` → confirm `/commercial-api/entitlements` shows `learnforge.family` → open the
   billing portal → cancel → confirm entitlements disappear. Then switch to `sk_live_…` and redeploy.

Run `npm run preflight -- --url https://<your-domain>` afterwards; it verifies configuration, database,
migrations, tables, the live HTTP surface and the exposure probes in one command. Real captured output
from this environment:

```
Configuration
  ✓ PUBLIC_SITE_URL is set — Stripe redirect + auth email base URL
  ✓ SUPABASE_URL is set — hosted authentication project URL
  ✓ SUPABASE_PUBLISHABLE_KEY is set — hosted authentication public key
  ✓ STRIPE_SECRET_KEY is set — checkout + billing portal
  ✓ STRIPE_WEBHOOK_SECRET is set — webhook signature verification
  ✓ STRIPE_PRICE_FAMILY is set — Family plan price id
  ✓ STRIPE_PRICE_TEACHER is set — Teacher plan price id

Database
  ✓ DATABASE_URL is set — postgres://postgres@127.0.0.1:55432/learnforge_fresh
  ✓ Connection established — driver=postgres
  ✓ All 3 migrations applied
  ✓ No migration drift detected
  ✓ All 5 commercial tables present

Live host checks (http://127.0.0.1:8080)
  ✓ GET /_runtime/health — {"ok":true,...,"routes":15}
  ✓ GET /commercial-api/health — {"ok":true,"service":"learnforge-commercial","database":"ready"}
  ✓ GET / — 6193914 bytes
  ✓ /LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.1.zip is not served
  ✓ /netlify/functions/commercial-health.mts is not served
  ✓ /package.json is not served

PREFLIGHT PASSED: configuration, database and schema are ready.
```

---

## 4. Step 3 — the ZIP exposure

**What I could not do:** probe the live site. There is no site URL anywhere — not in `netlify.toml`,
the README, the GitHub repo metadata (`homepageUrl` is empty), the releases, or any deployment record
(GitHub reports zero deployments for this repository). Netlify also has no public endpoint that maps a
project name to a `.netlify.app` domain, and guessing hostnames is not a reliable security check. So
instead of an unverifiable assertion, I closed the hole and made it permanently guarded.

**Your diagnosis was correct.** `netlify.toml` sets `publish = "."`, so the whole repository root is the
publish directory. That means the release archives, the `.mts`/`.ts` handler sources, the migrations,
`package.json` and the CI configuration are all *eligible* for static serving unless something denies
them. The API itself was never the leak (unknown routes 404), but the publish root was.

**What now blocks it — 19 forced 404 rewrites** in `netlify.toml` covering `/netlify/*`, `/runtime/*`,
`/deploy/*`, `/tests/*`, `/scripts/*`, `/.github/*`, `/.git/*`, `/*.zip`, `/*.mts`, `/*.ts`, `/*.log`,
`package.json`, `package-lock.json`, `netlify.toml`, `Dockerfile`, `.env`, `.env.*`, `.gitignore`,
`.dockerignore`. They rewrite to `/commercial-api/forbidden`, which is deliberately **not** a declared
API route, so the response is an honest 404 with no file content.

**How it is verified, in CI:**

- `scripts/check-netlify-exposure.mjs` models Netlify's real splat semantics (`*` crosses `/`, which is
  why `/netlify/*` also blocks `/netlify/functions/x.mts` — my first version got this wrong and the
  audit caught it) and classifies paths. Current result:
  `EXPOSURE AUDIT PASSED: all 23 sensitive paths blocked, all 8 product paths served.`
- `tests/test-netlify-exposure.mjs` fails the build if any sensitive path becomes servable, if a deny
  rule is not a forced 404, if the 404 target ever becomes a real route, or if a product page stops
  being served.
- The portable runtime blocks the same set at request time via its allow-list, asserted in the same
  suite (so the Oracle/Northflank deployment is protected too).

**Confirm it on your live site in ten seconds** (this is the check from your brief — run it once a
domain exists; exit code 1 means "publicly served"):

```bash
curl -sI https://<your-domain>/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.0.zip | head -1   # expect: 404
curl -sI https://<your-domain>/netlify/functions/commercial-health.mts | head -1                  # expect: 404
node scripts/check-netlify-exposure.mjs --path /pricing.html                                      # expect: EXPOSED (served)
```

If the first two still return `200 OK`, the deployed commit predates this fix — redeploy `main`.

---

## 5. Northflank deployment — ready to run

`deploy/northflank.json` is now an Infrastructure-as-Code template validated against the official
Northflank template schemas, so the deployment is one pasted file instead of twelve UI steps:

```
Project (learnforge-commercial, europe-west)
└── Workflow
    ├── Addon            PostgreSQL 16, TLS on, external access OFF, db "learnforge"
    ├── CombinedService  builds this repo's Dockerfile, port 8080, health GET /_runtime/health
    └── SecretGroup      10 env vars + addon link POSTGRES_URI → DATABASE_URL
```

The three values you must supply (all secrets, all in argument overrides so they stay out of version
control) are listed in `deploy/northflank-secrets.example.env`: `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the two Stripe price ids
default to the live Family/Teacher prices).

Then: run the template → apply migrations (a Northflank job running `npm run migrate`, or temporarily
enabling addon external access and running it locally) → `npm run preflight -- --url https://<domain>`.
Full detail, expected console output and the plan-name caveat are in
[`deploy/NORTHFLANK.md`](deploy/NORTHFLANK.md).

**Two things to know before you run it:** Sandbox caps at 2 services / 1 database, and the template
uses `nf-compute-20` plans — if your free Sandbox rejects them, pick the sandbox-eligible plan in the
UI. If your template version rejects the `healthChecks` block, delete those six lines and set the check
in the service form; `/_runtime/health` answers either way.

---

## 6. Everything executed in this session

| Work item | Result |
| --- | --- |
| Installed PostgreSQL 18.4 and ran the repo's migrations against an empty database | 3 applied, re-run idempotent, drift detection working |
| Live production runtime bound to that database | `[database] ready (driver=postgres)`, 15 routes mounted |
| New end-to-end purchase suite | 13/13 checks, plus the checkout-sync bug fixed |
| Netlify publish-root exposure | 19 deny rules, 23 blocked / 8 served, CI-guarded |
| `npm run preflight` | passes end-to-end including exposure probes |
| Northflank IaC template + secrets template | JSON validated, all `${refs}`/`${args}` resolve |
| CI | new real-PostgreSQL job; both jobs green on PR #2 |
| Full suite | **62 assertions + 13 end-to-end checks**, `npm run check` clean |
| Release artifact | `…_v17.2.zip`, 59 files, sha256 `9f314faf…97fb6c` |

**Known gaps, stated plainly:**

- The **Docker image build** was not executed (no Docker daemon here). The `Dockerfile`'s `COPY` sources
  were verified to exist, but Northflank's builder is the first place it truly compiles.
- **No live Stripe or Supabase round trip** — impossible without your credentials; the local suite
  simulates exactly those two boundaries.
- **No live hosting provider was contacted.** Northflank, Render, Fly and Oracle all require creating
  an account and a payment card; nothing in this environment can do that on your behalf.
- `/commercial-api/health` returns **503** until `DATABASE_URL` is set *and* the migrations have run.
  That is deliberate fail-closed behaviour, and `preflight` tells you which of the two is missing.
