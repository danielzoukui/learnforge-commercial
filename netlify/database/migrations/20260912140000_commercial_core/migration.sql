CREATE TABLE IF NOT EXISTS commercial_accounts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'parent',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commercial_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES commercial_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'inactive',
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commercial_entitlements (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES commercial_accounts(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'subscription',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, entitlement_key)
);

CREATE TABLE IF NOT EXISTS commercial_audit_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES commercial_accounts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commercial_subscriptions_account ON commercial_subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_commercial_entitlements_account ON commercial_entitlements(account_id);
CREATE INDEX IF NOT EXISTS idx_commercial_audit_account ON commercial_audit_events(account_id, created_at DESC);
