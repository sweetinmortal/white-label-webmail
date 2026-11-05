-- Gmail metadata only. Refresh tokens are encrypted with a Worker secret.
CREATE TABLE IF NOT EXISTS mail_gmail_connections (
  mailbox_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  auth_context TEXT NOT NULL,
  encrypted_refresh TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mail_gmail_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  verifier TEXT NOT NULL,
  auth_context TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS mail_gmail_transactions_expiry ON mail_gmail_transactions(expires_at);
CREATE TABLE IF NOT EXISTS mail_gmail_links (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  gmail_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail_gmail_links_gmail ON mail_gmail_links(mailbox_id, gmail_id);
CREATE TABLE IF NOT EXISTS mail_gmail_observations (
  mailbox_id TEXT NOT NULL,
  gmail_id TEXT NOT NULL,
  rfc_id TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  is_spam INTEGER NOT NULL CHECK(is_spam IN(0,1)),
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(mailbox_id,gmail_id)
);
CREATE INDEX IF NOT EXISTS mail_gmail_observations_message ON mail_gmail_observations(mailbox_id,rfc_id);
CREATE INDEX IF NOT EXISTS mail_gmail_observations_expiry ON mail_gmail_observations(mailbox_id,expires_at);
CREATE INDEX IF NOT EXISTS mail_gmail_local_rfc ON mail_messages(mailbox_id,rfc_message_id);
