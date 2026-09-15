# Deploy on Northflank Sandbox (free, always-on)

**Why here:** permanently free plan, **always-on compute with no sleep/cold start**,
commercial use permitted, and a **free PostgreSQL addon in the same project** — the
only shortlisted option that covers a Node service *and* a real database at $0.
Sandbox includes 2 services, 1 database addon and 2 cron jobs.

**Before you start:** Northflank does not publish per-service CPU/RAM ceilings for
Sandbox ("limited compute"); directory listings report ~10 GB/month free egress and
note that a payment card is required to create the account. Confirm both in the
console (Project → Usage) before pointing real traffic at it.

Everything in this repository has been verified end-to-end against **PostgreSQL 18.4**
(migrations, purchase lifecycle, entitlement grants/revocations, webhook
idempotency) — see [Verified before you start](#verified-before-you-start).

---

## Fast path: deploy the template

`deploy/northflank.json` is Infrastructure-as-Code for exactly this stack:
PostgreSQL 16 addon → combined service built from this repository's `Dockerfile`
→ secret group with the addon's connection string linked in as `DATABASE_URL`.

1. **Templates → Create template → … → Edit as code.** Paste the contents of
   [`northflank.json`](northflank.json) and save.
2. **Settings → Arguments:** fill `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (use *argument overrides* — they are
   stored outside version control). The two Stripe price ids already default to the
   live Family/Teacher prices. Values and comments:
   [`northflank-secrets.example.env`](northflank-secrets.example.env).
3. **Run the template**, then watch the three nodes finish. The service builds the
   Dockerfile and deploys on port 8080 with health check `/_runtime/health`.
4. **Migrations apply themselves.** The template sets `RUN_MIGRATIONS_ON_BOOT=true`,
   so the service applies the three migrations during boot — idempotently, logged
   line by line — right after the database handshake. The app serves traffic before
   that finishes, but `/commercial-api/health` reports 503 until the schema exists.
   If you would rather run them explicitly, use [Apply the migrations](#apply-the-migrations).
5. **Verify**, then finish the go-live steps — or skip steps 2–5 entirely and use
   [the automation](#go-live-steps--one-command) below.

> **Plan names:** the template uses `nf-compute-20` plans. If your team is on the
> free Sandbox and the run rejects them, pick the sandbox-eligible plan in the UI
> for the addon and the service — nothing else in the template changes.
>
> **Health check block:** if your template version rejects the `healthChecks` array,
> delete those six lines and set the check in the service UI (`GET /_runtime/health`,
> port 8080). The endpoint exists either way.

### Apply the migrations

**Option A — a Northflank job (no local tooling):** create a job in the same
project using the same image, attach the `learnforge-secrets` secret group, set the
command to `npm run migrate`, and run it once. Expected output:

```
  ✓ 20260912140000_commercial_core/migration.sql — applied
  ✓ 20260912143000_auth_identity/migration.sql — applied
  ✓ 20260912150000_stripe_webhook/migration.sql — applied
Schema is up to date.
```

Re-run it any time: already-applied files report `already-applied`, so it is safe
to run on every deploy.

**Option B — from your machine:** temporarily enable **external access** on the
PostgreSQL addon, copy its `POSTGRES_URI`, then:

```bash
export DATABASE_URL="postgres://user:pass@<external-host>:<port>/learnforge?sslmode=require"
npm install
npm run migrate --status   # shows 3 pending migrations
npm run migrate            # applies them
```

Turn external access back off when you are done.

### Verify

```bash
npm run preflight -- --url https://<your-domain>
```

`preflight` checks every required environment variable, database connectivity,
migration state (pending/drifted), the presence of all five commercial tables, and
the live HTTP surface — including that no `.zip`, `.mts` or `package.json` is
publicly downloadable. Expected shape:

```
Configuration
  ✓ PUBLIC_SITE_URL is set — Stripe redirect + auth email base URL
  ...
Database
  ✓ DATABASE_URL is set — postgres://user:***@host:5432/learnforge
  ✓ Connection established — driver=postgres
  ✓ All 3 migrations applied
  ✓ No migration drift detected
  ✓ All 5 commercial tables present
Live host checks (https://your-domain)
  ✓ GET /_runtime/health — {"ok":true,"service":"learnforge-commercial","runtime":"portable",...,"routes":15}
  ✓ GET /commercial-api/health — {"ok":true,"service":"learnforge-commercial","database":"ready"}
  ✓ GET / — 6xxxxxx bytes
  ✓ /LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.2.zip is not served
PREFLIGHT PASSED: configuration, database and schema are ready.
```

Manual equivalents:

```bash
curl -sS https://<your-domain>/commercial-api/health
# {"ok":true,"service":"learnforge-commercial","database":"ready"}
```

A `503 {"ok":false,"database":"unavailable"}` here means the addon's connection
string is not linked into `DATABASE_URL` (check the secret group) or the migrations
from the step above have not run. The service logs print exactly which environment
variables are missing and whether the database answered at boot.

## Manual path (if you prefer clicking through the UI)

1. **Project:** create `learnforge-commercial`.
2. **Addon:** PostgreSQL 16, smallest plan, database name `learnforge`, TLS on,
   external access off.
3. **Service:** Build from Git → `danielzoukui/learnforge-commercial`, branch `main`
   (or the branch you deploy from), build type **Dockerfile**, path `Dockerfile`.
   Public HTTP on port **8080**, health check `GET /_runtime/health`.
4. **Secret group:** add the variables from
   [`northflank-secrets.example.env`](northflank-secrets.example.env), and link the
   addon's `POSTGRES_URI` with the alias `DATABASE_URL`.
5. Continue with *Apply the migrations* and *Verify* above.

## Go-live steps — one command

`npm run golive` performs the whole sequence by API: Northflank project → PostgreSQL
addon → secret group with `DATABASE_URL` linked → combined service → build → wait for
the public URL → Supabase redirect URLs → Stripe webhook endpoint → signing secret
written back into the service → preflight → **a real test-mode purchase**. Every step
looks for the resource by name first, so re-running after a failure resumes instead of
duplicating.

```bash
export NORTHFLANK_API_TOKEN=...      # Northflank → Account settings → API tokens
export SUPABASE_ACCESS_TOKEN=sbp_... # supabase.com/dashboard/account/tokens
export SUPABASE_URL=https://<ref>.supabase.co
export STRIPE_SECRET_KEY=sk_test_... # start in test mode
export STRIPE_PRICE_FAMILY=price_... # optional: the live Family price is the default
export STRIPE_PRICE_TEACHER=price_... # optional

npm run golive -- --dry-run          # rehearse: prints every request, sends nothing
npm run golive                       # run the whole sequence
```

Useful flags: `--phase=infra|supabase|stripe|verify` runs one stage, `--url https://…`
sets the site origin when it is not discoverable, `--project <name>` overrides the
project name, `--branch <name>` builds a different branch, `--skip-purchase` stops
before the purchase, and `--quiet` reduces output to outcomes only.

### The test purchase

`--email/--password` (or `TEST_PURCHASE_EMAIL`/`TEST_PURCHASE_PASSWORD`) point at an
account on the deployment. The automation creates the account if needed, then drives
Stripe's API with `pm_card_visa` — the API equivalent of typing
`4242 4242 4242 4242` — so a genuine `customer.subscription.created` event is
delivered to your live webhook. It then polls `/commercial-api/entitlements` until
`learnforge.family` appears, cancels the subscription, and asserts the entitlement is
gone. Nothing is simulated: the events, the signature, the database writes and the
revocation are all real.

```
✓ created Stripe webhook endpoint (we_…) for https://<domain>/commercial-api/stripe-webhook
✓ test purchase granted learnforge.family
✓ cancellation revoked the entitlement
```

Finish by switching `STRIPE_SECRET_KEY` (and the webhook endpoint) to live keys and
re-running `npm run golive -- --phase=stripe`: creating the live endpoint returns a
new signing secret, which the automation writes into the secret group and restarts
the service for.

### Click-through equivalents

If you prefer the dashboard, the same four steps are:

1. **Domain:** add your custom domain to the service and create the DNS record
   Northflank shows; TLS is automatic. Update `PUBLIC_SITE_URL` to the final HTTPS
   origin — it builds the Stripe `success_url`/`cancel_url` and auth email redirects.
2. **Stripe webhook:** Developers → Webhooks → add
   `https://<your-domain>/commercial-api/stripe-webhook` with events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET` and redeploy.
3. **Supabase:** Auth → URL Configuration → add `https://<your-domain>/auth.html?verified=1`
   and your site URL to the allowed redirect list.
4. **One test-mode purchase:** `STRIPE_SECRET_KEY=sk_test_...`, then sign up → choose
   Family → pay with `4242 4242 4242 4242` → confirm `/commercial-api/entitlements`
   returns `learnforge.family` → open the billing portal → cancel → confirm
   entitlements disappear. Then switch to the live keys and redeploy.

## Verified before you start

These were executed against a real PostgreSQL server in this repository's build
environment — `npm test` (62 checks) plus `npm run test:e2e` (13 checks):

| Verified | Evidence |
| --- | --- |
| All 3 migrations apply to an empty database and are idempotent | `npm run migrate` twice on a fresh database |
| `/commercial-api/health` returns `{"ok":true,...,"database":"ready"}` | real SQL `SELECT 1` through the portable driver |
| Sign-up → account row bound to the immutable auth id | rows in `commercial_accounts`, audit event written |
| Checkout sends the correct price, plan metadata, success/cancel URLs | asserted on the exact Stripe request parameters |
| Signed webhook grants `learnforge.family` | HMAC-SHA256 signature over the real payload, subscription row `active` |
| Replayed webhook is deduplicated | real `UNIQUE(provider, provider_event_id)` constraint |
| Cancellation revokes entitlements | no enabled entitlement rows remain |
| Checkout sync self-heals when Stripe returns an unexpanded subscription id | drift simulated, then recovered |
| Billing portal opens from the persisted customer id | portal session created |

The go-live automation has its own suite — `npm run test:golive` (9 checks). It runs
`scripts/golive.mjs` against mock Northflank/Stripe/Supabase APIs at their documented
endpoints, while the application, the database and the webhook signature check are
real:

| Verified | Evidence |
| --- | --- |
| The pipeline issues the whole resource graph in order | 26 provider calls: project → addon → secrets → service → build → webhook → auth config |
| Payloads match the production contract | PostgreSQL 16 addon, `POSTGRES_URI`→`DATABASE_URL`, port 8080, `GET /_runtime/health`, `/Dockerfile`, branch `main` |
| The Stripe signing secret reaches the service | secret patched onto the secret group, then the service is restarted |
| Supabase receives the deployed origin | `site_url` + `uri_allow_list` updated |
| A test purchase grants and then loses the entitlement | real signup, real webhook delivery, real database rows |
| Re-running is safe | second run creates no duplicate resources and reports `already exists` |
| `--dry-run` sends nothing | zero provider calls, zero side effects |
| Secrets never reach the logs | `sk_…`, `whsec_…` redacted from all output |

Not verifiable without your accounts: the Docker image build on Northflank's builder,
and a live Stripe/Supabase round trip. Both are steps 3–4 above.

## Operating notes

- **Boot log tells you what is missing.** The runtime prints unset `[config]`
  variables and whether the database is reachable.
- **Egress is the likely first limit** (~10 GB/month reported on Sandbox). The
  runtime gzips compressible responses; `index.html` is ~6.2 MB raw. If you approach
  the cap, put Cloudflare (free) in front for static asset caching — read the
  payments caveat in [`../HOSTING_OPTIONS.md`](../HOSTING_OPTIONS.md) first.
- **Scaling:** Sandbox is capped at 2 services / 1 database. Beyond that the same
  image moves to Northflank pay-as-you-go (~$0.0167/vCPU-hour, ~$0.0083/GB-hour)
  with no code change, or to [`ORACLE_CLOUD_ALWAYS_FREE.md`](ORACLE_CLOUD_ALWAYS_FREE.md).
- **Backups:** Sandbox backup coverage is limited. Schedule a `pg_dump` (a free cron
  job is included) to storage you control, and test a restore before taking live
  payments.
- **CI is already wired:** `.github/workflows/ci.yml` runs the typecheck, the full
  suite, the exposure audit, and the PostgreSQL end-to-end purchase job on every push.
