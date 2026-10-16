-- One-use OAuth transactions and revocable sessions. Raw session cookies are
-- never stored. Expired rows are removed by the scheduled cleanup.
CREATE TABLE IF NOT EXISTS mail_auth_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_auth_transactions_created ON mail_auth_transactions(created_at);
CREATE INDEX IF NOT EXISTS mail_auth_transactions_expiry ON mail_auth_transactions(expires_at);

CREATE TABLE IF NOT EXISTS mail_auth_sessions (
  token_hash TEXT PRIMARY KEY,
  auth_context TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_auth_sessions_expiry ON mail_auth_sessions(expires_at);
