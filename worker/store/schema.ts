import type { D1Database } from '@cloudflare/workers-types';

const statements = [
  `CREATE TABLE IF NOT EXISTS mail_messages (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, direction TEXT NOT NULL, from_email TEXT NOT NULL, from_name TEXT NOT NULL DEFAULT '', to_json TEXT NOT NULL, cc_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL DEFAULT '', reply_to_json TEXT, rfc_message_id TEXT, references_json TEXT NOT NULL DEFAULT '[]', body_text TEXT, raw_key TEXT, payload_key TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, received_at TEXT, sent_at TEXT, expires_at TEXT NOT NULL, receipt_id TEXT UNIQUE, archive_address TEXT, archive_status TEXT NOT NULL DEFAULT 'pending', send_status TEXT, delete_state TEXT NOT NULL DEFAULT 'active', delete_started_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_folder_cursor ON mail_messages (mailbox_id, direction, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_expiry ON mail_messages (expires_at, delete_state, id)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_receipt ON mail_messages (receipt_id)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_archive_status ON mail_messages (archive_status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_outbox_status ON mail_messages (send_status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_hold ON mail_messages (mailbox_id, expires_at, delete_state, archive_status, send_status)`,
  `CREATE TABLE IF NOT EXISTS mail_read_states (message_id TEXT NOT NULL, user_email TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (message_id, user_email), FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS mail_outbox (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_key TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, correlation_id TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (id) REFERENCES mail_messages(id) ON DELETE CASCADE, UNIQUE (mailbox_id, idempotency_key))`,
  `CREATE INDEX IF NOT EXISTS mail_outbox_status ON mail_outbox (status, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS mail_outbox_correlation ON mail_outbox (correlation_id)`,
  `CREATE TABLE IF NOT EXISTS mail_outbox_recipients (outbox_id TEXT NOT NULL, email TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')), provider_id TEXT, provider_uuid TEXT, status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL, PRIMARY KEY (outbox_id, email, kind), FOREIGN KEY (outbox_id) REFERENCES mail_outbox(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS mail_outbox_recipient_provider ON mail_outbox_recipients (provider_id, email)`,
  `CREATE INDEX IF NOT EXISTS mail_outbox_recipient_uuid ON mail_outbox_recipients (provider_uuid, email)`,
  `CREATE TABLE IF NOT EXISTS mail_storage_counters (mailbox_id TEXT PRIMARY KEY, used_bytes INTEGER NOT NULL DEFAULT 0, budget_bytes INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mail_quota_counters (mailbox_id TEXT NOT NULL, period TEXT NOT NULL, period_key TEXT NOT NULL, recipient_count INTEGER NOT NULL DEFAULT 0, recipient_limit INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (mailbox_id, period, period_key))`,
  `CREATE INDEX IF NOT EXISTS mail_quota_expiry ON mail_quota_counters (mailbox_id, period_key)`,
  `CREATE TABLE IF NOT EXISTS mail_idempotency_tombstones (mailbox_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, message_id TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (mailbox_id, idempotency_key))`,
  `CREATE INDEX IF NOT EXISTS mail_idempotency_expiry ON mail_idempotency_tombstones (expires_at)`,
  `CREATE TABLE IF NOT EXISTS mail_webhook_events (event_key TEXT PRIMARY KEY, received_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mail_webhook_received ON mail_webhook_events (received_at)`,
  `CREATE TABLE IF NOT EXISTS mail_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  `CREATE TABLE IF NOT EXISTS mail_usage_alerts (mailbox_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('sending', 'accepted', 'unknown')), provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (mailbox_id, idempotency_key))`,
  `CREATE INDEX IF NOT EXISTS mail_usage_alerts_updated ON mail_usage_alerts (updated_at)`,
  `INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at) VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  `CREATE TABLE IF NOT EXISTS mail_message_identities (message_id TEXT PRIMARY KEY, address TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS mail_message_identity_address ON mail_message_identities (address, message_id)`,
  `INSERT OR IGNORE INTO mail_schema_migrations (version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
];

const initialized = new WeakSet<object>();
const initializationPromises = new WeakMap<object, Promise<void>>();

/** Ensure a test database and a newly provisioned D1 binding have the same schema.
 * Production deployments should still apply webmail/migrations/0001_mail.sql.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (initialized.has(db as object)) return;
  const running = initializationPromises.get(db as object);
  if (running) return running;
  const promise = (async () => {
    await db.batch(statements.map((sql) => db.prepare(sql)));
    initialized.add(db as object);
  })();
  initializationPromises.set(db as object, promise);
  try {
    await promise;
  } finally {
    initializationPromises.delete(db as object);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(days: number, from = Date.now()): string {
  return new Date(from + days * 86_400_000).toISOString();
}

export function isUniqueConstraint(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /unique|constraint/i.test(text);
}

export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
