CREATE TABLE IF NOT EXISTS mail_labels (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  UNIQUE (mailbox_id, name)
);

CREATE INDEX IF NOT EXISTS mail_labels_mailbox_name
  ON mail_labels (mailbox_id, name COLLATE NOCASE, id);

CREATE TABLE IF NOT EXISTS mail_message_labels (
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id),
  FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES mail_labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mail_message_labels_mailbox_label
  ON mail_message_labels (mailbox_id, label_id, message_id);

CREATE INDEX IF NOT EXISTS mail_message_labels_mailbox_message
  ON mail_message_labels (mailbox_id, message_id, label_id);

CREATE TABLE IF NOT EXISTS mail_rules (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  criteria_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mail_rules_mailbox_order
  ON mail_rules (mailbox_id, created_at, id);

CREATE TABLE IF NOT EXISTS mail_message_organization (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  skip_inbox INTEGER NOT NULL CHECK (skip_inbox IN (0, 1)),
  FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mail_message_organization_mailbox_archive
  ON mail_message_organization (mailbox_id, skip_inbox, message_id);
