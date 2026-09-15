ALTER TABLE commercial_accounts ADD COLUMN IF NOT EXISTS auth_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS commercial_accounts_auth_user_id_uidx
  ON commercial_accounts(auth_user_id)
  WHERE auth_user_id IS NOT NULL;
