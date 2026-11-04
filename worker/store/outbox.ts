import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../errors';
import type { SendStatus } from '../../shared/contracts';
import { addDaysIso, ensureSchema, isUniqueConstraint, nowIso } from './schema';

export interface ExistingOutbox { id: string; status: SendStatus; payload_hash: string; scheduled_at?: string | null }

function effectiveStatus(row: ExistingOutbox): SendStatus {
  // The outbox CHECK constraint predates scheduling, so a queued scheduled
  // message is stored as pending with scheduled_at set. Present it to clients
  // as scheduled until the dispatcher claims it.
  return row.status === 'pending' && row.scheduled_at ? 'scheduled' : row.status;
}

export async function findIdempotency(db: D1Database, mailboxId: string, key: string): Promise<ExistingOutbox | null> {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT id, status, payload_hash, scheduled_at FROM mail_outbox WHERE mailbox_id = ? AND idempotency_key = ?`).bind(mailboxId, key).first<ExistingOutbox>();
  if (row) return { ...row, status: effectiveStatus(row) };
  const tombstone = await db.prepare(`SELECT message_id AS id, status, payload_hash FROM mail_idempotency_tombstones WHERE mailbox_id = ? AND idempotency_key = ? AND expires_at > ?`).bind(mailboxId, key, nowIso()).first<ExistingOutbox>();
  return tombstone ? { ...tombstone, scheduled_at: null } : null;
}

export async function insertOutbox(db: D1Database, values: { id: string; mailboxId: string; key: string; hash: string; payloadKey: string; provider: string; correlationId: string; scheduledAt?: string; messageSql: D1PreparedStatement; recipientStatements: D1PreparedStatement[] }): Promise<void> {
  await ensureSchema(db);
  const at = nowIso();
  try {
    await db.batch([
      values.messageSql,
      db.prepare(`INSERT INTO mail_outbox (id, mailbox_id, idempotency_key, payload_hash, payload_key, status, provider, correlation_id, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
        .bind(values.id, values.mailboxId, values.key, values.hash, values.payloadKey, values.provider, values.correlationId, values.scheduledAt ?? null, at, at),
      ...values.recipientStatements,
    ]);
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'idempotency_conflict', 'La clave de idempotencia ya está en uso.');
    throw error;
  }
}

export async function claimOutbox(db: D1Database, id: string): Promise<boolean> {
  await ensureSchema(db);
  const now = nowIso();
  const result = await db.prepare(`UPDATE mail_outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)`).bind(now, id, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export interface DueOutboxRow {
  id: string;
  mailbox_id: string;
  payload_key: string;
  provider: string;
  scheduled_at: string;
  created_at: string;
}

export async function listDueOutbox(db: D1Database, now: string, limit = 20): Promise<DueOutboxRow[]> {
  await ensureSchema(db);
  const result = await db.prepare(`SELECT id, mailbox_id, payload_key, provider, scheduled_at, created_at FROM mail_outbox WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at ASC, id ASC LIMIT ?`).bind(now, limit).all<DueOutboxRow>();
  return result.results ?? [];
}

export async function claimDueOutbox(db: D1Database, id: string, now: string): Promise<boolean> {
  await ensureSchema(db);
  const result = await db.prepare(`UPDATE mail_outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`).bind(now, id, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function recoverStaleScheduledOutbox(db: D1Database, cutoff: string): Promise<number> {
  await ensureSchema(db);
  const rows = await db.prepare(`SELECT id FROM mail_outbox WHERE status = 'sending' AND scheduled_at IS NOT NULL AND updated_at <= ? ORDER BY updated_at ASC LIMIT 20`).bind(cutoff).all<{ id: string }>();
  const at = nowIso();
  let recovered = 0;
  for (const row of rows.results ?? []) {
    await db.batch([
      db.prepare(`UPDATE mail_messages SET send_status = 'unknown' WHERE id = ? AND send_status IN ('scheduled', 'sending')`).bind(row.id),
      db.prepare(`UPDATE mail_outbox SET status = 'unknown', error_code = 'scheduled_send_unknown', updated_at = ? WHERE id = ? AND status = 'sending'`).bind(at, row.id),
    ]);
    recovered += 1;
  }
  return recovered;
}

export async function setOutboxStatus(db: D1Database, id: string, status: SendStatus, errorCode?: string): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db.prepare(`UPDATE mail_outbox SET status = ?, error_code = ?, updated_at = ? WHERE id = ?`).bind(status, errorCode ?? null, nowIso(), id),
    db.prepare(`UPDATE mail_messages SET send_status = ?, sent_at = CASE WHEN ? = 'accepted' THEN COALESCE(sent_at, ?) ELSE sent_at END, archive_status = CASE WHEN ? = 'failed' AND archive_status = 'pending' THEN 'failed' ELSE archive_status END WHERE id = ?`).bind(status, status, nowIso(), status, id),
  ]);
}

export async function updateRecipientResults(db: D1Database, id: string, results: Array<{ email: string; kind: string; providerId?: string; providerUuid?: string; status: string }>): Promise<void> {
  await ensureSchema(db);
  const at = nowIso();
  await db.batch(results.map((item) => db.prepare(`UPDATE mail_outbox_recipients SET provider_id = ?, provider_uuid = ?, status = ?, updated_at = ? WHERE outbox_id = ? AND email = ? AND kind = ?`).bind(item.providerId ?? null, item.providerUuid ?? null, item.status, at, id, item.email, item.kind)));
}

export async function addTombstone(db: D1Database, mailboxId: string, key: string, hash: string, messageId: string, status: SendStatus, retentionDays: number): Promise<void> {
  await ensureSchema(db);
  await db.prepare(`INSERT OR REPLACE INTO mail_idempotency_tombstones (mailbox_id, idempotency_key, payload_hash, message_id, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(mailboxId, key, hash, messageId, status, addDaysIso(Math.max(30, retentionDays + 30))).run();
}
