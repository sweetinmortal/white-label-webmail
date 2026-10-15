import type { D1Database } from '@cloudflare/workers-types';
import { ensureSchema, nowIso } from './schema';

export type UsageNoticeClaim =
  | { kind: 'claimed' }
  | { kind: 'accepted'; providerId: string | null }
  | { kind: 'pending' };

/** Create a durable one-shot claim. Existing ambiguous claims must never be resent automatically. */
export async function claimUsageNotice(db: D1Database, mailboxId: string, key: string): Promise<UsageNoticeClaim> {
  await ensureSchema(db);
  const now = nowIso();
  const cutoff = new Date();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 14);
  // Keep cleanup bounded so a notification cannot turn into an unbounded maintenance pass.
  await db.prepare(`DELETE FROM mail_usage_alerts WHERE rowid IN (
    SELECT rowid FROM mail_usage_alerts WHERE updated_at < ? ORDER BY updated_at LIMIT 50
  )`).bind(cutoff.toISOString()).run();

  const inserted = await db.prepare(`INSERT OR IGNORE INTO mail_usage_alerts
    (mailbox_id, idempotency_key, status, provider_id, created_at, updated_at)
    VALUES (?, ?, 'sending', NULL, ?, ?) RETURNING idempotency_key`)
    .bind(mailboxId, key, now, now).first<{ idempotency_key: string }>();
  if (inserted?.idempotency_key === key) return { kind: 'claimed' };

  const existing = await db.prepare(`SELECT status, provider_id FROM mail_usage_alerts
    WHERE mailbox_id = ? AND idempotency_key = ?`).bind(mailboxId, key)
    .first<{ status: string; provider_id: string | null }>();
  if (existing?.status === 'accepted') return { kind: 'accepted', providerId: existing.provider_id };
  if (existing?.status === 'sending' || existing?.status === 'unknown') return { kind: 'pending' };
  throw new Error('usage_notice_claim_missing');
}

export async function finishUsageNotice(
  db: D1Database,
  mailboxId: string,
  key: string,
  status: 'accepted' | 'unknown',
  providerId: string | null,
): Promise<void> {
  const result = await db.prepare(`UPDATE mail_usage_alerts SET status = ?, provider_id = ?, updated_at = ?
    WHERE mailbox_id = ? AND idempotency_key = ? AND status = 'sending'`)
    .bind(status, providerId, nowIso(), mailboxId, key).run();
  if (result.meta.changes !== 1) throw new Error('usage_notice_finish_conflict');
}
