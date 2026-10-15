import type { D1Database } from '@cloudflare/workers-types';
import { ensureSchema, nowIso } from './schema';

function periodKey(date = new Date()): { day: string; month: string } {
  return { day: date.toISOString().slice(0, 10), month: date.toISOString().slice(0, 7) };
}

export async function reserveRecipients(db: D1Database, mailboxId: string, count: number, dailyLimit: number, monthlyLimit: number): Promise<boolean> {
  if (!Number.isSafeInteger(count) || count < 0) return false;
  await ensureSchema(db);
  const keys = periodKey();
  const at = nowIso();
  const result = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO mail_quota_counters (mailbox_id, period, period_key, recipient_count, recipient_limit, updated_at) VALUES (?, 'day', ?, 0, ?, ?)`)
      .bind(mailboxId, keys.day, dailyLimit, at),
    db.prepare(`INSERT OR IGNORE INTO mail_quota_counters (mailbox_id, period, period_key, recipient_count, recipient_limit, updated_at) VALUES (?, 'month', ?, 0, ?, ?)`)
      .bind(mailboxId, keys.month, monthlyLimit, at),
    // Both periods are updated by one statement.  The subqueries make the
    // update conditional on both counters having capacity, so a rejected
    // reservation cannot consume only the daily or monthly half.
    db.prepare(`UPDATE mail_quota_counters
      SET recipient_count = recipient_count + ?,
          recipient_limit = CASE WHEN period = 'day' THEN ? ELSE ? END,
          updated_at = ?
      WHERE mailbox_id = ?
        AND ((period = 'day' AND period_key = ?) OR (period = 'month' AND period_key = ?))
        AND (SELECT recipient_count FROM mail_quota_counters WHERE mailbox_id = ? AND period = 'day' AND period_key = ?) + ? <= ?
        AND (SELECT recipient_count FROM mail_quota_counters WHERE mailbox_id = ? AND period = 'month' AND period_key = ?) + ? <= ?`)
      .bind(count, dailyLimit, monthlyLimit, at, mailboxId, keys.day, keys.month, mailboxId, keys.day, count, dailyLimit, mailboxId, keys.month, count, monthlyLimit),
  ]);
  return (result[2]?.meta?.changes ?? 0) === 2;
}

export async function releaseRecipients(db: D1Database, mailboxId: string, count: number): Promise<void> {
  await ensureSchema(db);
  const keys = periodKey();
  await db.batch([
    db.prepare(`UPDATE mail_quota_counters SET recipient_count = CASE WHEN recipient_count >= ? THEN recipient_count - ? ELSE 0 END, updated_at = ? WHERE mailbox_id = ? AND period = 'day' AND period_key = ?`).bind(count, count, nowIso(), mailboxId, keys.day),
    db.prepare(`UPDATE mail_quota_counters SET recipient_count = CASE WHEN recipient_count >= ? THEN recipient_count - ? ELSE 0 END, updated_at = ? WHERE mailbox_id = ? AND period = 'month' AND period_key = ?`).bind(count, count, nowIso(), mailboxId, keys.month),
  ]);
}
