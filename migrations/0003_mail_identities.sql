-- Preserve the actual envelope recipient, including delivery by BCC.
-- Older messages retain the installation's primary address as their fallback.
CREATE TABLE IF NOT EXISTS mail_message_identities (
  message_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail_message_identity_address ON mail_message_identities (address, message_id);
INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
