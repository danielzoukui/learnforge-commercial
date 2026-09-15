# Deploy on Northflank Sandbox (free, always-on)

**Why here:** permanently free plan, **always-on compute with no sleep/cold start**,
commercial use permitted, and a **free PostgreSQL addon in the same project** — the
only shortlisted option that covers a Node service *and* a real database at $0.
Sandbox includes 2 services, 1 database addon and 2 cron jobs.

**Before you start:** Northflank does not publish per-service CPU/RAM ceilings for
Sandbox ("limited compute"); directory listings report ~10 GB/month free egress and
note that a payment card is required to create the account. Confirm both in the
console (Project → Usage) before pointing real traffic at it.

---

## 1. Project and database

1. Create an account and a project (e.g. `learnforge-commercial`).
2. **Add a PostgreSQL addon** with the smallest/free plan. Note the connection
   details on the addon page:
   - `POSTGRES_URI` — full connection string
   - `HOST`, `PORT`, `DATABASE`, `USERNAME`, `PASSWORD`
3. Enable the addon's **external access** if you want to run migrations from your
   laptop (step 4). Internal-only access is fine if you migrate from a job/service
   inside Northflank instead.

## 2. Service from this repository

1. **Create service → Build from Git → `danielzoukui/learnforge-commercial`**,
   branch `main` (or the branch you deploy from).
2. Build type: **Dockerfile**, path `Dockerfile` (repository root).
3. Networking: **public**, internal port **8080**, protocol HTTP.
4. Health check: HTTP `GET /_runtime/health` (liveness only — it never touches the
   database, so a paused database cannot restart-loop your container).
5. Resources: start with the smallest Sandbox size available.

## 3. Environment variables

Create a runtime **secret group** and attach the addon's `POSTGRES_URI` to it
(link it as `DATABASE_URL` if the console offers aliases, otherwise create
`DATABASE_URL` with the value from the addon page). Add:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${POSTGRES_URI}` (or the literal connection string) |
| `PUBLIC_SITE_URL` | `https://<your-domain>` |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | anon / publishable key (`SUPABASE_ANON_KEY` also accepted) |
| `STRIPE_SECRET_KEY` | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from the endpoint created in step 6 |
| `STRIPE_PRICE_FAMILY` | `price_1UEz7K3ItjkrrGb20QhuWGdd` ($3/mo) |
| `STRIPE_PRICE_TEACHER` | `price_1UEz7Q3ItjkrrGb2WzldHDJt` ($5/mo) |
| `NODE_ENV` | `production` |

Optional: `DATABASE_SSL=require` if the addon's TLS chain is not in the image CA
store (the runtime infers this from `?sslmode=` in the URI when present),
`HOST`/`PORT` only if you deviate from 8080.

## 4. Apply the migrations

From your laptop, using the addon's **external** connection string:

```bash
export DATABASE_URL="postgres://user:pass@<external-host>:<port>/<database>"
export DATABASE_SSL=require

npm install
npm run migrate --status   # lists the 3 migrations as pending
npm run migrate            # applies them in version order
```

Repeat `--status` afterwards: all three should report `already-applied`. The
runner records each file in `commercial_schema_migrations`, so re-deploys never
re-apply DDL, and editing an applied file is reported instead of silently skipped.

*Alternative:* create a Northflank job that runs `npm run migrate` with the same
secret group attached, if you prefer migrations to run inside the platform.

## 5. Domain and TLS

Add your custom domain to the service and create the DNS record Northflank shows.
Certificates are issued automatically. Update `PUBLIC_SITE_URL` to the final HTTPS
origin — it is used to build Stripe `success_url`/`cancel_url` and auth email
redirects.

## 6. Point Stripe at the new origin

In the Stripe Dashboard → Developers → Webhooks, add:

```
https://<your-domain>/commercial-api/stripe-webhook
```

Events: `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, `invoice.payment_failed`.

Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy. Then, in
Supabase Auth → URL Configuration, add `https://<your-domain>/auth.html?verified=1`
and your site URL to the allowed redirect list.

## 7. Smoke tests

```bash
curl -sS https://<your-domain>/_runtime/health          # {"ok":true,...,"routes":15}
curl -sS https://<your-domain>/commercial-api/health    # {"ok":true,...,"database":"ready"}
curl -sSI https://<your-domain>/ | head -5              # security headers, gzip
curl -sS -o /dev/null -w '%{http_code}\n' https://<your-domain>/netlify/functions/commercial-health.mts   # 404
```

Then complete one **test-mode** purchase: sign up, checkout, confirm
`/commercial-api/entitlements` shows `learnforge.family`, open the billing portal,
cancel, and confirm the webhook flips entitlements off. Check the service logs for
`[config]` warnings — a clean boot prints none.

## 8. Operating notes

- **Boot log tells you what is missing.** The runtime prints any unset
  `[config]` variables and whether the database is reachable.
- **Egress is the likely first limit** (~10 GB/month reported on Sandbox). The
  runtime already gzips compressible responses; `index.html` is ~6.2 MB raw and
  compresses substantially. If you approach the cap, put Cloudflare (free) in front
  for static asset caching — see the payments caveat in
  [`../HOSTING_OPTIONS.md`](../HOSTING_OPTIONS.md) first.
- **Scaling:** Sandbox is capped at 2 services / 1 database. Beyond that, the same
  image moves to Northflank pay-as-you-go (~$0.0167/vCPU-hour, ~$0.0083/GB-hour)
  with no code change, or to the Oracle runbook.
- **Backups:** Sandbox backups are limited. Schedule `pg_dump` (a free cron job is
  included) to object storage you control, and test a restore before taking live
  payments.
