# LearnForge Commercial Platform

[![LearnForge Commercial CI](https://github.com/danielzoukui/learnforge-commercial/actions/workflows/ci.yml/badge.svg)](https://github.com/danielzoukui/learnforge-commercial/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg)](#)

LearnForge is an adaptive, zero-dependency educational platform delivering 23,400+ interactive skills across K-12 math, reading, science, and world strategy. This repository provides the complete **LearnForge Commercial Edition**, pairing the client-side learning engine with a serverless backend for hosted authentication, Stripe subscription billing, customer self-service billing management, and database-backed entitlement synchronization.

---

## 🏛️ Architecture Overview

The commercial platform consists of three integrated layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        LEARNFORGE CLIENT                               │
│  • Single-file SPA learning engine (index.html, SQLite in-browser)     │
│  • Commercial Pricing & Plan Selector (pricing.html)                   │
│  • Hosted Account Interface (auth.html)                                │
│  • Customer Support, Terms, & Privacy Portals                          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Same-Origin Cookies & HTTPS
┌───────────────────────────────────▼────────────────────────────────────┐
│                  NETLIFY SERVERLESS FUNCTIONS                          │
│  • Commercial Auth Proxy (HttpOnly SameSite cookies via Supabase)      │
│  • Stripe Checkout & Billing Customer Portal API                       │
│  • Webhook Verification (HMAC-SHA256 signature & replay defense)       │
│  • Real-time Entitlement & Account Synchronization                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│              NETLIFY POSTGRESQL / PERSISTENCE LAYER                    │
│  • commercial_accounts (auth identity & roles)                         │
│  • commercial_subscriptions (provider IDs, plans, statuses)            │
│  • commercial_entitlements (active feature flags)                      │
│  • commercial_webhook_events (idempotency ledger)                      │
│  • commercial_audit_events (tamper-evident audit log)                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 💳 Commercial Monetization Model

All commercial pricing is strictly month-to-month with no hard-coded price IDs in source code.

| Plan | Price | Target Audience | Key Features |
| :--- | :--- | :--- | :--- |
| **Free Edition** | $0 | Public Preview | Preview curriculum access, offline practice, core skill library |
| **Family Plan** | **$3 / mo** | Parents, homeschoolers, home learners | 100% ad-free, 23,400+ skills, step-by-step diagnostics, voice read-aloud TTS, dyslexia font, offline PWA |
| **Teacher Plan** | **$5 / mo** | Educators, tutors, classroom teachers | Everything in Family, plus multi-student rosters, targeted assignments, mistake analysis, curriculum audit (CCSS/NGSS), printable prep packets |
| **School / District** | *Custom* | Campuses & School Districts | Campus-wide licensing, FERPA/COPPA compliance DPAs, Google/Clever SSO *(Self-service disabled)* |

> **Note on School Access**: Self-service signup for school/district tiers is intentionally disabled. Institutional onboarding requires custom contractual agreements and privacy compliance review.

---

## 🔌 Commercial API Routes

All commercial routes use the `/commercial-api/...` prefix to prevent collision with internal monolith client routers:

### Authentication & Account
- `POST /commercial-api/auth/signup` — Create hosted account (Family or Teacher role)
- `POST /commercial-api/auth/signin` — Authenticate and issue secure HttpOnly cookies
- `POST /commercial-api/auth/signout` — Clear session cookies
- `GET  /commercial-api/auth/session` — Query current authenticated session
- `POST /commercial-api/auth/refresh` — Refresh expired session tokens
- `POST /commercial-api/auth/recover` — Send password reset email
- `POST /commercial-api/auth/update-password` — Set new password
- `POST /commercial-api/auth/adopt-session` — Adopt token from hosted email redirect
- `POST /commercial-api/account` — Upsert commercial account linked to hosted auth ID

### Billing & Monetization
- `POST /commercial-api/checkout` — Initiate Stripe Checkout session for Family or Teacher
- `POST /commercial-api/checkout-sync` — Instant post-checkout verification and entitlement activation
- `POST /commercial-api/portal` — Generate Stripe Billing Customer Portal session (invoices, card updates, cancellation)
- `GET  /commercial-api/entitlements` — Return active entitlements and subscription state
- `POST /commercial-api/stripe-webhook` — Cryptographically verify Stripe webhook events with idempotency tracking
- `GET  /commercial-api/health` — Service and database liveness probe

---

## 🗄️ Database Schema & Migrations

PostgreSQL migrations are located under `netlify/database/migrations/`:

1. `20260912140000_commercial_core`:
   - `commercial_accounts`: User identities, roles (`parent`, `teacher`), and account statuses.
   - `commercial_subscriptions`: Tracks Stripe customer ID, subscription ID, plan, status, and period end.
   - `commercial_entitlements`: Feature keys (`learnforge.family`, `learnforge.teacher`) tied to account IDs.
   - `commercial_audit_events`: Security and transactional audit history.
2. `20260912143000_auth_identity`:
   - Enforces unique indexed foreign mapping to hosted authentication IDs (`auth_user_id`).
3. `20260912150000_stripe_webhook`:
   - `commercial_webhook_events`: Idempotency ledger preventing replay attacks and duplicate processing.

---

## 🛠️ Local Development & Testing

### Prerequisites
- Node.js >= 22.0.0
- npm >= 10.0.0

### Installation
```bash
git clone https://github.com/danielzoukui/learnforge-commercial.git
cd learnforge-commercial
npm install
```

### Run Automated Tests
```bash
# Run comprehensive commercial verification and Stripe security test suites
npm test

# Run TypeScript compilation checks across all Netlify functions
npm run check
```

### Start Local Preview Server
```bash
# Starts local preview server on http://localhost:8080
npm run preview
```
Visit:
- Main Learning Engine: `http://localhost:8080/`
- Plans & Pricing: `http://localhost:8080/pricing.html`
- Hosted Account: `http://localhost:8080/auth.html`
- Support Center: `http://localhost:8080/support.html`

---

## ⚙️ Environment Configuration

Set these variables in your deployment environment (Netlify Site Configuration):

```bash
# Public URL
PUBLIC_SITE_URL="https://your-domain.com"

# Stripe Monetization
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRICE_FAMILY="price_1UEz7K3ItjkrrGb20QhuWGdd"
STRIPE_PRICE_TEACHER="price_1UEz7Q3ItjkrrGb2WzldHDJt"

# Hosted Supabase Authentication
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_PUBLISHABLE_KEY="your-anon-or-publishable-key"
```

---

## 🛡️ Launch Gates & Compliance

Per LearnForge commercial policy, technical readiness does not constitute legal or regulatory certification. Prior to onboarding live paid students and institutions:
1. Conduct formal COPPA/FERPA privacy and student data governance legal review.
2. Verify production database backups, point-in-time recovery, and disaster response procedures.
3. Establish dedicated, monitored support channels (`support@learnforge.ai`).
4. Ensure hosted account deletion and data export workflows comply with applicable jurisdiction laws.

---

## 📄 License
Proprietary. All rights reserved.
