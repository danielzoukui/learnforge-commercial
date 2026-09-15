# LearnForge Commercial Netlify Package

This package keeps the current LearnForge single-file deployment as the product front end and adds a Netlify-native commercial backend scaffold.

## Included
- Existing working `index.html` with the learning engine preserved.
- Netlify security/cache headers.
- Netlify Database migration for commercial accounts, subscriptions, entitlements, and audit events.
- `/commercial-api/health`
- `/commercial-api/account`
- `/commercial-api/entitlements`
- `/commercial-api/checkout`
- Pricing, Privacy, Terms, and Support pages.

## Billing configuration required before checkout works
Set these production environment variables in Netlify:
- `PUBLIC_SITE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_FAMILY`
- `STRIPE_PRICE_TEACHER`

No prices are hard-coded in this package.

## Important launch gates
This package is not a claim of legal, security, COPPA/FERPA, accessibility, or payment-compliance certification. Before taking paid customers, complete production authentication, hosted account recovery, Stripe webhook entitlement synchronization, hosted data export/deletion, child/school consent flows, legal review, monitoring, backup/restore tests, accessibility testing, and incident-response/support operations.

## Deployment
This is source code that requires a Netlify build so Functions and Database migrations are provisioned. A simple drag-and-drop static deploy will serve the HTML pages but will not activate the backend functions/database build pipeline.

## Hosted authentication gate
This package now expects a hosted Supabase Auth project before commercial account endpoints are enabled.
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

Security note: Family/parent and teacher are the only self-service commercial roles. School access is disabled. Commercial accounts are bound to the hosted provider's immutable auth user ID.


## Stripe webhook activation

The package now includes `/commercial-api/stripe-webhook`. Configure `STRIPE_WEBHOOK_SECRET` in Netlify after creating the Stripe webhook endpoint. The handler verifies the `Stripe-Signature` header against the raw request body, rejects stale signatures, records processed event IDs for idempotency, and synchronizes subscription state and entitlements.

Recommended subscribed events for this build:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Checkout now copies LearnForge plan/user metadata onto the Stripe Subscription so subsequent subscription lifecycle events can map back to the authenticated LearnForge account.


## Current Stripe test catalog

- Family: $3 USD/month — `price_1UEz7K3ItjkrrGb20QhuWGdd`
- Teacher: $5 USD/month — `price_1UEz7Q3ItjkrrGb2WzldHDJt`
- School: disabled/inactive
- No annual subscription prices
- Commercial function routes use `/commercial-api/...` to avoid collision with the LearnForge monolith's internal `/api/...` router.
