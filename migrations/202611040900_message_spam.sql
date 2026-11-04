-- A manual ham decision remains stored as is_spam=0. No original is deleted.
CREATE TABLE IF NOT EXISTS mail_message_spam (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  is_spam INTEGER NOT NULL CHECK (is_spam IN (0, 1)),
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail_message_spam_mailbox
  ON mail_message_spam (mailbox_id, is_spam, message_id);
