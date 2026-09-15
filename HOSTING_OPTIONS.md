# LearnForge Commercial — Production Hosting Options (Free Tiers)

**Question answered:** where can this monetization platform run in production, for $0, other than Netlify?

**Verified:** 15 September 2026. Every limit in the tables below was checked against
current provider documentation or primary sources on that date — free tiers in this
market change several times a year, so re-check before you commit budget.

---

## TL;DR — the recommendation

> **Run this repository unchanged on [Northflank](https://northflank.com) Sandbox (free, always-on), keep Supabase Auth, and use the free PostgreSQL in the same project.**
>
> Northflank Sandbox is the only candidate that is **permanently free**, has **no cold-start sleep**, allows **commercial use**, and can host **a Node service plus a real PostgreSQL** in one place. The portable runtime in this repo ([`deploy/PORTABLE_RUNTIME.md`](deploy/PORTABLE_RUNTIME.md)) makes the move a configuration change, not a rewrite. Runbook: [`deploy/NORTHFLANK.md`](deploy/NORTHFLANK.md).

**Second choice — maximum headroom, more ops work:** Oracle Cloud **Always Free** VM
(2 OCPU / 12 GB ARM, 200 GB storage, 10 TB egress) running the same Docker image.
Runbook: [`deploy/ORACLE_CLOUD_ALWAYS_FREE.md`](deploy/ORACLE_CLOUD_ALWAYS_FREE.md).

**Do not build a payments product on the two most-recommended "free" platforms:**

| Platform | Why it is the wrong answer here |
| --- | --- |
| **Vercel Hobby** | Vercel's Fair Use Guidelines restrict Hobby to **personal, non-commercial** projects; any deployment tied to financial gain requires Pro ($20/seat/month). LearnForge charges subscriptions — this is an eligibility breach, not a traffic question. |
| **Fly.io** | **No free tier for new organisations** since 7 Oct 2024. New accounts pay metered usage from the first running machine-second; the "3 free VMs" everyone quotes is legacy-grandfathered only. |

---

## Corrections to the earlier shortlist

The list this repo was handed contained five claims that were wrong, stale, or
materially incomplete as of today:

| Claim in the earlier list | Reality (verified 15 Sep 2026) |
| --- | --- |
| "Fly.io: free allowance of up to 3 shared-cpu-1x VMs" | Free allowances were retired for new accounts on 7 Oct 2024; only a one-time trial (~2 machine-hours / 7 days) applies. Existing legacy orgs are grandfathered. |
| "Vercel: closest direct equivalent to Netlify" | Technically true, contractually disqualified: Vercel Hobby is **non-commercial only**, and commercial usage includes "any deployment tied to financial gain for anyone involved", including a paid contractor writing the code. |
| "Render: free managed PostgreSQL (1 GB storage)" | The free database **expires 30 days after creation** (was 90 days before May 2024) and its data is then deleted; the free web service also sleeps after 15 idle minutes and is capped at 750 instance-hours/month. |
| "Supabase free tier is production-suitable alongside Cloudflare" | Supabase's free tier **auto-pauses a project after 7 days with no API requests** until a human resumes it. A quiet week takes your checkout offline. |
| "Oracle Always Free: 4 OCPU / 24 GB" | Halved in June 2026 for **new non-PAYG tenancies** (2 OCPU / 12 GB); PAYG tenancies still get 4/24 within the free allowance, and 200 GB storage + 10 TB egress are unchanged. Verify in your own tenancy console before sizing. |
| "Cloudflare Pages is the top recommendation" | Functionally generous, but the Cloudflare Self-Serve Subscription Agreement §2.2.1(h) forbids **"process or collect personal or business credit card information on any web property that is receiving Free Services."** See the caveat below. |

---

## Free-tier facts, side by side

| Option | Static hosting | Serverless / compute | PostgreSQL | Cold starts | Commercial use | Verdict for this repo |
| --- | --- | --- | --- | --- | --- | --- |
| **Northflank Sandbox** | Same service | 2 services + 2 cron jobs, **always-on** (no sleeping) | **1 free database addon** in-project | None | Not restricted on the free plan | ✅ **Recommended** |
| **Oracle Cloud Always Free** | Same VM | 2 OCPU / 12 GB ARM, 200 GB disk, 10 TB egress | Self-hosted container, or Neon/Supabase | None | Not restricted | ✅ Best headroom, most ops work |
| Cloudflare Workers/Pages Free | **Unlimited** static requests, 20k files, 25 MiB/file, 500 builds/mo | 100,000 req/**day** shared with Workers, **10 ms CPU**, 128 MB | None (bring Neon/Supabase/D1) | None | Allowed, **but §2.2.1(h) is a payments caveat** | ⚠️ Front door only, read caveat |
| Netlify Free (incumbent) | Unlimited static | 125k function invocations/mo, 100 h runtime | Netlify DB | ~None | Allowed | ⚠️ Works today, per-IP/usage risk at scale |
| Neon Free | — | — | 0.5 GB, 100 CU-hours/project, 5 GB egress; scale-to-zero forced | ~300–500 ms wake | Allowed | ✅ Best free **database only** |
| Supabase Free | — | 500k edge invocations/mo | 500 MB, 50k MAU | — | Allowed | ⚠️ Auth yes (already integrated), DB pauses after 7 idle days |
| Render Free | 100 GB/mo | Web service sleeps after 15 min; 750 h/mo | **Deleted after 30 days** | 1 min wake | Allowed | ❌ Not production-free |
| Vercel Hobby | 100 GB/mo | 1M invocations/mo | Vercel Postgres (Neon) | None | ❌ **Prohibited** | ❌ Disqualified |
| Fly.io | — | Trial credits only for new orgs | Fly Postgres (paid) | None | Allowed | ❌ No free tier |
| Railway | — | $5 one-off trial credit | Paid | None | Allowed | ❌ No permanent free tier |

**Cost of the first paid step, if you outgrow free:** Northflank is pure
pay-as-you-go with no seat fee (~$0.0167/vCPU-hour, ~$0.0083/GB-hour), so a small
always-on configuration runs in the low single-digit dollars per month; Oracle
Always Free has no upgrade path because it never expires; Cloudflare Workers Paid
is $5/month for 10M requests; Render's realistic production floor is $7 (service)
+ $6 (database).

---

## The Cloudflare caveat, in full

Cloudflare's free plans are the most generous way to serve 6 MB of static product
pages — static asset requests are free and unlimited. But before pointing a
payments-enabled domain at Cloudflare Free, read §2.2.1(h) of the
[Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) (last updated 12 Sep 2025):

> "(h) process or collect personal or business credit card information on any web
> property that is receiving Free Services"

LearnForge never touches card data: Checkout and the Billing Portal are
Stripe-hosted pages on `checkout.stripe.com`, and this codebase only stores Stripe
IDs and subscription status. On a literal reading the clause is not triggered —
but it is a payments-specific restriction that Vercel does not have and Northflank
does not have, and it is the reason Cloudflare is **not** this document's primary
recommendation. Get a legal opinion before you rely on it for a live store.

If you do want Cloudflare, use it as a **cache/edge layer in front of** the
Northflank service (proxied DNS, cache static assets), not as the origin for the
checkout domain — that keeps the free-tier benefit and keeps the payments boundary
on infrastructure without that clause.

---

## What was built to make this possible

Netlify was previously the only host because the API handlers used two
platform-specific primitives (`Netlify.env`, `getDatabase()` from `@netlify/database`).
Both are now shimmed, so **the 15 handlers in `netlify/functions/` are unchanged
and portable**:

| Component | Purpose |
| --- | --- |
| `runtime/server.mjs` | Production HTTP server: static pages + all `/commercial-api/*` routes on any Node 22.18+ host |
| `runtime/loader.mjs` | Maps `@netlify/database` → portable driver and resolves Netlify-style extensionless imports |
| `runtime/database.mjs` | `db.sql` tagged-template contract over `pg`, connection-string discovery, TLS policy, migration engine |
| `runtime/router.mjs` | Route table derived from each function's `export const config = { path }`, static allow-list, netlify.toml header/cache parity, gzip |
| `runtime/migrate.mjs` | Applies the existing `netlify/database/migrations/*/migration.sql` files to any PostgreSQL, tracked and idempotent |
| `Dockerfile` | Production image that copies **only** public assets + `netlify/` + `runtime/` |
| `tests/test-portable-runtime.mjs` | 30 end-to-end checks: routing, cookies, Stripe HMAC, 503 fail-closed paths, migration idempotency, path-traversal and archive-exposure defences |
| `tests/test-end-to-end-purchase.mjs` | 13 checks against a **real PostgreSQL**: migrate → sign-up → checkout → signed webhook → entitlements → replay → sync → portal → cancel |
| `tests/test-netlify-exposure.mjs` + `scripts/check-netlify-exposure.mjs` | Proves the `publish = "."` exposure is closed on Netlify and that the portable runtime blocks the same paths |
| `scripts/preflight-deploy.mjs` | Go-live preflight: env completeness, DB connectivity, migration state, live HTTP surface, and an exposure probe (`npm run preflight -- --url https://…`) |
| `deploy/northflank.json` | Northflank Infrastructure-as-Code template: project + PostgreSQL addon + service + secret group |

Verification (`npm test`): 62 assertions pass — 19 original Netlify, 5 Stripe
signature, 7 Netlify-exposure, 30 portable-runtime — plus a 13-check end-to-end
purchase suite (`npm run test:e2e`) executed against a **real PostgreSQL 18.4**
server: migrations applied to an empty database, `/commercial-api/health`
returning `{"ok":true,"database":"ready"}`, sign-up → account row, checkout request
parameters, signed webhook granting `learnforge.family`, replay deduplication on
the real unique constraint, checkout-sync self-healing, billing portal, and
cancellation revoking entitlements. CI runs that suite against a PostgreSQL 16
service container on every push (`.github/workflows/ci.yml`).

**Still not verified:** the Docker image build (no daemon in the build environment)
and a live Stripe/Supabase round trip. Both are covered by the runbooks.

---

## Deployment paths

| Path | When to choose it | Runbook |
| --- | --- | --- |
| **A. Northflank Sandbox** | You want $0, no cold starts, managed Postgres, and the least operational work | [`deploy/NORTHFLANK.md`](deploy/NORTHFLANK.md) |
| **B. Oracle Cloud Always Free** | You want the most compute for $0 and are comfortable with Docker + TLS + backups | [`deploy/ORACLE_CLOUD_ALWAYS_FREE.md`](deploy/ORACLE_CLOUD_ALWAYS_FREE.md) |
| **C. Anywhere else** (Render paid, Fly, Railway, Kubernetes, your own box) | The runtime is host-agnostic; only env vars differ | [`deploy/PORTABLE_RUNTIME.md`](deploy/PORTABLE_RUNTIME.md) |

### Launch checklist (applies to every path)

1. **Database:** create PostgreSQL, set `DATABASE_URL` (or `POSTGRES_URI`), then `npm run migrate --status` → `npm run migrate`.
2. **Environment variables:** `PUBLIC_SITE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FAMILY`, `STRIPE_PRICE_TEACHER`. The runtime prints exactly which are missing at boot.
3. **Stripe:** add `https://<your-domain>/commercial-api/stripe-webhook` as a webhook endpoint (events: `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`) and copy the new signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Supabase:** add `https://<your-domain>/auth.html?verified=1` and your production URL to the allowed redirect URLs.
5. **DNS/TLS:** point the domain at the service, let the platform issue the certificate, then re-run a real test-mode checkout end to end.
6. **Monitoring:** watch `/_runtime/health` (liveness, no database access) and `/commercial-api/health` (database readiness). Both are cheap to poll from any uptime monitor.
7. **Egress:** reported at ~10 GB/month on Northflank Sandbox and 100 GB/month on Render free. `index.html` is 6.2 MB, so gzip is already enabled by the runtime — keep it, and add Cloudflare caching in front if you approach the cap.

---

## Security note that applies to the current Netlify deployment

`netlify.toml` sets `publish = "."`, which means the **whole repository root is the
publish directory**. That makes the two committed release archives
(`LearnForge_COMMERCIAL_*.zip`, ~2.2 MB each), `netlify/functions/*.mts` sources,
`README.md` and CI configuration *eligible* for static serving. Verify what is
actually reachable on the live site (`curl -I https://<site>/LearnForge_COMMERCIAL_MONETIZATION_COMPLETE_v17.0.zip`)
and, if it responds 200, add deny rules or move the archives out of the publish root.

The portable runtime does not have that problem: `runtime/router.mjs` serves an
**extension/segment allow-list** and returns 404 for source files, archives, dotfiles
and repository metadata. This is asserted by the test suite.
