-- Scheduled sends stay in `pending` so the existing mail_outbox CHECK
-- constraint remains valid. `scheduled_at` is the UTC instant when the
-- every-minute dispatcher may claim and deliver the message.
ALTER TABLE mail_outbox ADD COLUMN scheduled_at TEXT;
CREATE INDEX IF NOT EXISTS mail_outbox_due
  ON mail_outbox (status, scheduled_at, id);

-- "Todos" lists incoming and outgoing messages together. This cursor index
-- avoids scanning the per-direction folder index.
CREATE INDEX IF NOT EXISTS mail_messages_all_cursor
  ON mail_messages (mailbox_id, created_at DESC, id DESC);

INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at)
VALUES (9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
