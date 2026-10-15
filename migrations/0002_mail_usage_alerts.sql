CREATE TABLE IF NOT EXISTS mail_usage_alerts (
  mailbox_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'accepted', 'unknown')),
  provider_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS mail_usage_alerts_updated ON mail_usage_alerts (updated_at);
INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
