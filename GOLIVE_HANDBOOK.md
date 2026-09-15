# LearnForge Commercial — Go-Live Handbook

**Everything needed to take this product from repository to taking real payments.**
Written for one operator at a keyboard, with no prior knowledge of this codebase.

Measured expectation: **about 15 minutes of your attention**, most of it waiting for a
Docker build. Every command below has been executed and verified in this repository's
build environment except the four steps marked **[yours]** — those need an account,
an email inbox and a payment card, which no automation can supply on your behalf.

```
Account creation  →  credentials  →  readiness check  →  deploy  →  verify  →  flip to live
   [yours]            [yours]         npm run golive:check   npm run golive
```

---

## 0. Before anything: two facts that save an hour

1. **The deployment builds the `main` branch**, and `main` does not yet contain the
   container build or the deployment templates (they are in the open pull request).
   Either **merge pull request #2** first, or add
   `--branch arena/01a0a641-learnforge-commercial` to every `golive` command below.
   The readiness check tells you which situation you are in.
2. **Stripe keeps test and live data in separate universes.** The price ids shipped in
   this repository are *live* prices, so a test key cannot use them — Stripe answers
   `No such price`. The automation handles this by creating a matching test-mode price
   tagged `metadata.learnforge_plan`, repointing the service at it, and paying. You do
   not have to do anything, but do not be surprised by the extra line.

---

## 1. [yours] Create the Northflank account

1. Go to **northflank.com** → *Sign up*. Email + password; verify the email.
2. A card goes on file. Sandbox is free forever and always-on (no sleeping, no cold
   starts); the card is for identity, not billing. Confirm your plan says **Sandbox**
   (Team settings → Plans) — the free plan includes 2 services, 1 database addon.
3. **Account settings → API tokens → Create**:
   - Name: `learnforge-golive`
   - Permissions: **project create/write** (full access is fine)
   - Team: the one that owns the Sandbox plan
4. Copy the token once — it is shown a single time:

```bash
export NORTHFLANK_API_TOKEN=nfp_...
```

> No API can create the account for you: Northflank's signup is a browser flow with
> email verification and card entry. That is the only reason any step here is manual.

## 2. [yours] Create the Supabase access token

The Supabase *project* can already exist (this product only needs the project URL and
its publishable key, which the automation fetches).

1. **supabase.com/dashboard/account/tokens → Generate new token** → `sbp_...`
2. Project URL: **Project Settings → API → Project URL**

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
export SUPABASE_URL=https://<your-ref>.supabase.co
```

3. In **Authentication → Providers → Email**, decide about *Confirm email*: the
   automated rehearsal signs a fresh account up and needs the session immediately, so
   either turn confirmation off for the rehearsal, or pre-create and confirm the
   account and pass its credentials with `--email/--password`.

## 3. [yours] Stripe test key

Dashboard → **Test mode ON** (top right) → Developers → API keys → copy the secret key.
Keep the live key for the service only.

```bash
export STRIPE_SECRET_KEY=sk_test_...
```

The two price ids default to the repository's values; override only if you created your
own: `export STRIPE_PRICE_FAMILY=price_... STRIPE_PRICE_TEACHER=price_...`

---

## 4. Readiness check — *before* spending time on a build

```bash
npm install
npm run golive:check
```

This is not a formality: it makes real API calls and tells you in one screen whether
your token has the right permissions, whether your Stripe key is test or live, whether
each price id exists *and in which mode*, and whether your Supabase token can read and
write the auth configuration.

```
① This machine and this checkout
  ✓ Node 22.22.3
  ✓ Dockerfile present in this checkout
② Provider APIs reachable          ✓ Northflank · ✓ Stripe · ✓ Supabase
③ Northflank token                 ✓ Token accepted — 1 project(s) visible
④ Stripe key and prices            ✓ Key accepted — test mode
                                   ✓ STRIPE_PRICE_FAMILY exists — … test price
⑤ Supabase project and auth redirect  ✓ Management token accepted
```

Every ✗ comes with a `↳` line telling you exactly how to fix it. Exit codes: `0` ready,
`1` something needs fixing, `2` the provider APIs are unreachable from this machine
(corporate proxy, VPN, or a sandbox that blocks egress — run it on your own network).

## 5. Rehearse, then deploy

```bash
npm run golive -- --dry-run     # prints every request it would send; sends nothing
npm run golive                  # does it for real (~6–12 min, mostly the build)
```

What the real run does, in order: creates the project → PostgreSQL 16 addon (TLS on,
external access off) → secret group with the addon's `POSTGRES_URI` linked as
`DATABASE_URL` and `RUN_MIGRATIONS_ON_BOOT=true` → combined service (this repo's
Dockerfile, port 8080, health check `/_runtime/health`) → triggers the build → waits for
the public HTTPS URL → sets Supabase `site_url` + redirect URLs → creates the Stripe
webhook endpoint for `/commercial-api/stripe-webhook` → writes the returned signing
secret back into the service and restarts it → runs the preflight → performs the test
purchase.

Expected ending:

```
④ Verification
  ✓ /commercial-api/health → {"ok":true,"service":"learnforge-commercial","database":"ready"}
  ✓ release archive is not publicly downloadable
  ✓ test purchase granted learnforge.family
  ✓ cancellation revoked the entitlement

=== Summary ===
  ✓ infra: ok   ✓ supabase: ok   ✓ stripe: ok   ✓ verify: ok
```

The purchase is real: the automation creates an account, attaches Stripe's
`pm_card_visa` (the API equivalent of typing `4242 4242 4242 4242`), creates a
subscription, waits for your live webhook to grant the entitlement, cancels, and
asserts the entitlement is gone. Only the browser is skipped.

Migrations need no action at all — the service applies them during its first boot.

## 6. Browser sanity check (30 seconds)

Open `https://<your-domain>/pricing.html` → **Family** → pay with
`4242 4242 4242 4242`. Then `https://<your-domain>/auth.html` to see the account, and
`/commercial-api/entitlements` should list `learnforge.family`.

## 7. Flip to live keys

```bash
export STRIPE_SECRET_KEY=sk_live_...
export STRIPE_PRICE_FAMILY=price_1UEz7K3ItjkrrGb20QhuWGdd    # live ids restored
export STRIPE_PRICE_TEACHER=price_1UEz7Q3ItjkrrGb2WzldHDJt

npm run golive -- --phase=infra     # writes the live price ids (idempotent: creates nothing)
npm run golive -- --phase=stripe    # creates the LIVE webhook + signing secret, restarts the service
```

`--phase=verify` deliberately refuses to run with a live key: a rehearsal must never be
able to charge. For the final live proof, make one real $3 purchase in the browser,
confirm the entitlement, then refund it in Stripe.

---

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `unreachable` for all three APIs, exit 2 | this machine cannot reach the provider APIs | Run on your own network; drop VPN/proxy or allow `api.northflank.com`, `api.stripe.com`, `api.supabase.com` |
| `Northflank rejected the token (401/403)` | token lacks project write, or belongs to another team | Recreate it with project create/write on the Sandbox team |
| Build fails almost immediately | `main` predates the container build | Merge PR #2, or re-run with `--branch arena/01a0a641-learnforge-commercial` |
| `plan nf-compute-20 not allowed` | the plan is not Sandbox-eligible | Pick the free plan for addon + service in the UI, then re-run the same command |
| `/commercial-api/health` stays 503 | `DATABASE_URL` not linked, or migrations failed | The service log names the missing variable and whether the database answered |
| `No such price` | a live price met a test key somewhere unexpected | Check `STRIPE_PRICE_FAMILY`; the run normally rewrites it for you |
| Purchase hangs, entitlements stay empty | webhook not reaching the app | Stripe → Developers → Webhooks → your endpoint → check delivery attempts |
| Signup returns `{status:"pending"}` / no session | Supabase *Confirm email* is on | Confirm the account, then re-run with `--email/--password` |
| `typeSpecificSettings` unknown field | Northflank API version difference | `curl -s https://api.northflank.com/v1/swagger-json \| grep -o 'typeSpecific[A-Za-z]*' \| sort -u` and report it |

**Everything is idempotent.** After fixing anything, re-run the same command: existing
resources are reused by name, nothing is duplicated, and the run resumes where it
stopped.

---

## What runs vs. what you run

| Step | Who |
| --- | --- |
| Northflank account, email verification, card | **[yours]** — no API exists for this |
| Supabase access token, Stripe test key | **[yours]** — tokens are secrets only you can mint |
| Readiness check, deploy, migrations, Supabase redirect, Stripe webhook, test purchase, live flip | `npm run golive` |

Nothing in this handbook asks you to paste a secret into a chat window or a config
file that is committed. Credentials live in your shell environment and are written by
the automation into the Northflank secret group, which Northflank stores encrypted.

## Cost and limits to keep in mind

- **Sandbox:** permanently free, always-on, 2 services + 1 database + 2 cron jobs.
  Directory listings report ~10 GB/month egress — `index.html` is ~6 MB raw, so if you
  approach the cap put Cloudflare (free) in front for static asset caching, and read the
  payments caveat in [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md) first.
- **Backups:** Sandbox backup coverage is thin. Before taking live payments, schedule a
  `pg_dump` (a free cron job is included in the plan) to storage you control and test a
  restore.
- **Legal/compliance gates** (from the repository README): COPPA/FERPA review, verified
  backups/restore, and a monitored support channel before onboarding live paid users.

## Reference

| Document | Contents |
| --- | --- |
| [`deploy/NORTHFLANK.md`](deploy/NORTHFLANK.md) | Full runbook: template path, manual click path, verification evidence |
| [`DEPLOYMENT_EXECUTION_REPORT.md`](DEPLOYMENT_EXECUTION_REPORT.md) | What was executed and verified, with raw output |
| [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md) | Why Northflank, and the verified alternatives (Oracle Always Free) |
| [`deploy/northflank-secrets.example.env`](deploy/northflank-secrets.example.env) | Every environment variable, with comments |

*Verified state of the automation when this handbook was written: full suite
62 assertions + 13 end-to-end checks + 15 pipeline checks, all green in CI on the
PostgreSQL job.*
