-- Drafts are private to the authenticated user and survive browser/session
-- changes. The editable payload (including attachment contents) lives in the
-- configured object store; D1 keeps only the list metadata and quota counts.
CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_text TEXT NOT NULL DEFAULT '',
  cc_text TEXT NOT NULL DEFAULT '',
  bcc_text TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  payload_key TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_drafts_owner
  ON mail_drafts (mailbox_id, user_email, updated_at DESC, id DESC);

INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
