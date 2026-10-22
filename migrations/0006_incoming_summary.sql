-- Deduplicate retried deliveries by RFC Message-ID + envelope recipient.
-- NULL keys keep older messages and messages without Message-ID unaffected.
ALTER TABLE mail_messages ADD COLUMN incoming_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_incoming_key
  ON mail_messages (mailbox_id, incoming_key);

-- Persist each valid incoming message until it belongs to a complete summary
-- batch. The snapshot is independent from the temporary message cache so a
-- summary can still be sent after the original expires.
CREATE TABLE IF NOT EXISTS mail_summary_items (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'accepted', 'failed', 'unknown')),
  sender_email TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  recipient_address TEXT NOT NULL,
  received_at TEXT NOT NULL,
  reply_from TEXT NOT NULL,
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mail_summary_items_pending
  ON mail_summary_items (mailbox_id, status, created_at, message_id);
CREATE INDEX IF NOT EXISTS mail_summary_items_batch
  ON mail_summary_items (batch_id, status);

CREATE TABLE IF NOT EXISTS mail_summary_batches (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('claiming', 'sending', 'accepted', 'failed', 'unknown')),
  item_count INTEGER NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_summary_batches_recovery
  ON mail_summary_batches (mailbox_id, status, updated_at);

INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at)
VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
