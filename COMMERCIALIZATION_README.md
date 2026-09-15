# LearnForge Commercial Netlify Package

This package keeps the current LearnForge single-file deployment as the product front end and adds a Netlify-native commercial backend scaffold.

## Included
- Existing working `index.html` with the 23,400+ skill learning engine preserved.
- Netlify security and cache headers (`netlify.toml`).
- Netlify Database migrations for commercial accounts, subscriptions, entitlements, webhook idempotency, and audit events.
- Commercial API routes:
  - `/commercial-api/health` — Database and service health check
  - `/commercial-api/account` — Authenticated commercial account sync
  - `/commercial-api/entitlements` — Real-time entitlement and active subscription query
  - `/commercial-api/checkout` — Authenticated Stripe Checkout session creation
  - `/commercial-api/checkout-sync` — Immediate post-checkout session verification and entitlement sync
  - `/commercial-api/portal` — Self-service Stripe Billing Customer Portal (invoices, card updates, plan changes, cancellation)
  - `/commercial-api/stripe-webhook` — Cryptographically verified webhook synchronization with idempotency tracking
  - `/commercial-api/auth/*` — Hosted session proxy (signup, signin, signout, refresh, recover, update-password, adopt-session)
- Front-end pages:
  - `pricing.html` — Full commercial tier comparison (Family $3/mo, Teacher $5/mo, School enterprise), active subscription recognition, portal launch, and post-checkout return handling.
  - `auth.html` — Hosted account creation, sign-in, recovery, and session adoption.
  - `support.html` — Multi-channel customer support, billing help, and technical guidance.
  - `privacy.html` — Data privacy draft and local-first data disclosures.
  - `terms.html` — Commercial terms of service launch draft.

## Billing configuration required before checkout works
Set these production environment variables in Netlify:
- `PUBLIC_SITE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_FAMILY`
- `STRIPE_PRICE_TEACHER`
- `STRIPE_WEBHOOK_SECRET`

No prices are hard-coded in this package.

## Important launch gates
This package is not a claim of legal, security, COPPA/FERPA, accessibility, or payment-compliance certification. Before taking paid customers, complete production authentication, hosted account recovery, Stripe webhook entitlement synchronization, hosted data export/deletion, child/school consent flows, legal review, monitoring, backup/restore tests, accessibility testing, and incident-response/support operations.

## Deployment
This source tree supports two production targets. A simple drag-and-drop static deploy is not one of them: it would serve the HTML pages without the API, authentication, or entitlement logic.

1. **Netlify** — requires a Netlify build so Functions and Database migrations are provisioned (`netlify.toml`, `netlify/functions/`, `netlify/database/migrations/`).
2. **Any Node 22.18+ / Docker host** — `runtime/` mounts the same 15 handlers on their declared routes and runs the same migrations against any PostgreSQL:

   ```bash
   DATABASE_URL=postgres://... npm run migrate   # applies the 3 migrations
   npm start                                    # serves pages + /commercial-api/*
   ```

   See [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md) for the verified free-tier hosting recommendation and [`deploy/PORTABLE_RUNTIME.md`](deploy/PORTABLE_RUNTIME.md) for the runtime details. The handler sources are byte-for-byte identical on both targets; only `Netlify.env` and `getDatabase()` are shimmed.

## Hosted authentication gate
This package expects a hosted Supabase Auth project before commercial account endpoints are enabled.
Set these Netlify production environment variables:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` (preferred) or `SUPABASE_ANON_KEY`

Authentication is proxied through Netlify Functions and stored in Secure, HttpOnly, SameSite=Lax cookies. Commercial account, entitlements, and checkout derive identity from the verified hosted session rather than trusting an email submitted by the browser.

Authentication routes:
- `/auth.html`
- `/commercial-api/auth/signup`
- `/commercial-api/auth/signin`
- `/commercial-api/auth/session`
- `/commercial-api/auth/refresh`
- `/commercial-api/auth/signout`
- `/commercial-api/auth/recover`
- `/commercial-api/auth/update-password`
- `/commercial-api/auth/adopt-session`

Security note: Family/parent and teacher are the only self-service commercial roles. School access is disabled from self-service. Commercial accounts are bound to the hosted provider's immutable auth user ID.

## Stripe webhook & Customer Portal activation

Configure `STRIPE_WEBHOOK_SECRET` in Netlify after creating the Stripe webhook endpoint. The handler verifies the `Stripe-Signature` header against the raw request body, rejects stale signatures, records processed event IDs for idempotency, and synchronizes subscription state and entitlements.

Recommended subscribed events for this build:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Checkout copies LearnForge plan/user metadata onto the Stripe Subscription so subsequent subscription lifecycle events map back to the authenticated LearnForge account. The `/commercial-api/portal` endpoint allows active subscribers to manage payment methods and cancellation directly through Stripe's hosted Billing Portal.

## Current Stripe test catalog

- Family: $3 USD/month — `price_1UEz7K3ItjkrrGb20QhuWGdd`
- Teacher: $5 USD/month — `price_1UEz7Q3ItjkrrGb2WzldHDJt`
- School: disabled/inactive for self-service (enterprise contact only)
- No annual subscription prices
- Commercial function routes use `/commercial-api/...` to avoid collision with the LearnForge monolith's internal `/api/...` router.
