-- Incoming messages that match a configured filter are kept in the cache but
-- are hidden from Recibidos. The label is displayed in the Filtrados view so
-- the user can still find the original and reply from the webmail.
CREATE TABLE IF NOT EXISTS mail_message_filters (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  label TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail_message_filters_mailbox
  ON mail_message_filters (mailbox_id, created_at DESC, message_id DESC);

INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at)
VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
