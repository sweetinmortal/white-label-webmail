import type { D1Database } from '@cloudflare/workers-types';
import { ensureSchema, nowIso } from './schema';

export type SummaryItemStatus = 'pending' | 'claimed' | 'accepted' | 'failed' | 'unknown';
export type SummaryBatchStatus = 'claiming' | 'sending' | 'accepted' | 'failed' | 'unknown';

export interface SummaryItemInput {
  messageId: string;
  mailboxId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  recipientAddress: string;
  receivedAt: string;
  replyFrom: string;
  replyTo: string[];
  inReplyTo?: string;
  references: string[];
}

export interface SummaryItemRow {
  message_id: string;
  mailbox_id: string;
  batch_id: string | null;
  status: SummaryItemStatus;
  sender_email: string;
  sender_name: string;
  subject: string;
  recipient_address: string;
  received_at: string;
  reply_from: string;
  reply_to_json: string;
  in_reply_to: string | null;
  references_json: string;
  created_at: string;
  claimed_at: string | null;
  error_code: string | null;
  attempts: number;
}

export interface SummaryBatchRow {
  id: string;
  mailbox_id: string;
  status: SummaryBatchStatus;
  item_count: number;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimedSummaryBatch {
  batch: SummaryBatchRow;
  items: SummaryItemRow[];
}

const CLAIM_STALE_MS = 15 * 60 * 1000;
const MAX_SWEEP = 20;
// Definitive pre-send failures are retried on a later flush. Provider
// exceptions are `unknown` and never enter this path because the message may
// already have been accepted.
export const SUMMARY_MAX_ATTEMPTS = 3;

export async function enqueueSummaryItem(db: D1Database, input: SummaryItemInput): Promise<void> {
  await ensureSchema(db);
  await db.prepare(`INSERT OR IGNORE INTO mail_summary_items (message_id, mailbox_id, batch_id, status, sender_email, sender_name, subject, recipient_address, received_at, reply_from, reply_to_json, in_reply_to, references_json, created_at, claimed_at, error_code) VALUES (?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
    .bind(input.messageId, input.mailboxId, input.senderEmail, input.senderName, input.subject, input.recipientAddress, input.receivedAt, input.replyFrom, JSON.stringify(input.replyTo), input.inReplyTo ?? null, JSON.stringify(input.references), input.receivedAt)
    .run();
}

export async function pendingSummaryCount(db: D1Database, mailboxId: string): Promise<number> {
  await ensureSchema(db);
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM mail_summary_items WHERE mailbox_id = ? AND status = 'pending' AND attempts < ?`).bind(mailboxId, SUMMARY_MAX_ATTEMPTS).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function claimSummaryBatch(db: D1Database, mailboxId: string, batchSize: number): Promise<ClaimedSummaryBatch | null> {
  await ensureSchema(db);
  if ((await pendingSummaryCount(db, mailboxId)) < batchSize) return null;
  const batchId = crypto.randomUUID();
  const at = nowIso();
  await db.prepare(`INSERT INTO mail_summary_batches (id, mailbox_id, status, item_count, provider_message_id, error_code, created_at, updated_at) VALUES (?, ?, 'claiming', ?, NULL, NULL, ?, ?)`)
    .bind(batchId, mailboxId, batchSize, at, at).run();
  await db.prepare(`UPDATE mail_summary_items SET status = 'claimed', batch_id = ?, claimed_at = ?, error_code = NULL, attempts = attempts + 1 WHERE message_id IN (SELECT message_id FROM mail_summary_items WHERE mailbox_id = ? AND status = 'pending' AND attempts < ? ORDER BY created_at ASC, message_id ASC LIMIT ?)`)
    .bind(batchId, at, mailboxId, SUMMARY_MAX_ATTEMPTS, batchSize).run();
  const rows = await db.prepare(`SELECT message_id, mailbox_id, batch_id, status, sender_email, sender_name, subject, recipient_address, received_at, reply_from, reply_to_json, in_reply_to, references_json, created_at, claimed_at, error_code, attempts FROM mail_summary_items WHERE batch_id = ? ORDER BY created_at ASC, message_id ASC`)
    .bind(batchId).all<SummaryItemRow>();
  const items = rows.results ?? [];
  if (items.length !== batchSize) {
    await releaseClaimedBatch(db, batchId, 'claim_incomplete');
    return null;
  }
  const sending = await db.prepare(`UPDATE mail_summary_batches SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'claiming'`).bind(at, batchId).run();
  if ((sending.meta.changes ?? 0) === 0) {
    await releaseClaimedBatch(db, batchId, 'claim_lost');
    return null;
  }
  return {
    batch: {
      id: batchId,
      mailbox_id: mailboxId,
      status: 'sending',
      item_count: batchSize,
      provider_message_id: null,
      error_code: null,
      created_at: at,
      updated_at: at,
    },
    items,
  };
}

async function releaseClaimedBatch(db: D1Database, batchId: string, reason: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE mail_summary_items SET status = 'pending', batch_id = NULL, claimed_at = NULL, error_code = ?, attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END WHERE batch_id = ? AND status = 'claimed'`).bind(reason, batchId),
    db.prepare(`DELETE FROM mail_summary_batches WHERE id = ?`).bind(batchId),
  ]);
}

export async function finalizeSummaryBatch(db: D1Database, batchId: string, outcome: Exclude<SummaryBatchStatus, 'claiming' | 'sending'>, providerMessageId?: string, errorCode?: string): Promise<void> {
  await ensureSchema(db);
  const at = nowIso();
  // Claim and finalize are the only writers of a claimed item. The outer
  // status guards make the update a no-op if recovery already moved this
  // batch to `unknown` (or released it) while the provider call was in flight.
  // Items are updated first so they can observe the batch still in `sending`.
  //
  // A `failed` outcome is only produced before the provider call. Those items
  // return to the queue for a bounded retry. `unknown` means the provider may
  // have accepted the message, so it is never requeued automatically.
  const itemUpdate = outcome === 'failed'
    ? db.prepare(`UPDATE mail_summary_items SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, batch_id = CASE WHEN attempts >= ? THEN batch_id ELSE NULL END, claimed_at = CASE WHEN attempts >= ? THEN claimed_at ELSE NULL END, error_code = ? WHERE batch_id = ? AND status = 'claimed' AND EXISTS (SELECT 1 FROM mail_summary_batches WHERE id = ? AND status = 'sending')`)
      .bind(SUMMARY_MAX_ATTEMPTS, SUMMARY_MAX_ATTEMPTS, SUMMARY_MAX_ATTEMPTS, errorCode ?? null, batchId, batchId)
    : db.prepare(`UPDATE mail_summary_items SET status = ?, error_code = ? WHERE batch_id = ? AND status = 'claimed' AND EXISTS (SELECT 1 FROM mail_summary_batches WHERE id = ? AND status = 'sending')`)
      .bind(outcome, errorCode ?? null, batchId, batchId);
  await db.batch([
    itemUpdate,
    db.prepare(`UPDATE mail_summary_batches SET status = ?, provider_message_id = ?, error_code = ?, updated_at = ? WHERE id = ? AND status = 'sending'`)
      .bind(outcome, providerMessageId ?? null, errorCode ?? null, at, batchId),
  ]);
}

export async function recoverStaleSummaryBatches(db: D1Database, mailboxId: string): Promise<{ released: number; unknown: number }> {
  await ensureSchema(db);
  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const rows = await db.prepare(`SELECT id, status FROM mail_summary_batches WHERE mailbox_id = ? AND status IN ('claiming', 'sending') AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`)
    .bind(mailboxId, cutoff, MAX_SWEEP).all<{ id: string; status: 'claiming' | 'sending' }>();
  let released = 0;
  let unknown = 0;
  for (const row of rows.results ?? []) {
    const at = nowIso();
    if (row.status === 'claiming') {
      await db.batch([
        db.prepare(`UPDATE mail_summary_batches SET status = 'failed', error_code = 'recovered_before_send', updated_at = ? WHERE id = ? AND status = 'claiming'`).bind(at, row.id),
        db.prepare(`UPDATE mail_summary_items SET status = 'pending', batch_id = NULL, claimed_at = NULL, error_code = 'recovered_before_send', attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END WHERE batch_id = ? AND status = 'claimed'`).bind(row.id),
      ]);
      released += 1;
    } else {
      // A sending batch may have reached the provider. Mark it unknown and do
      // not put its items back in the queue: a blind retry could duplicate it.
      await db.batch([
        db.prepare(`UPDATE mail_summary_batches SET status = 'unknown', error_code = 'send_outcome_unknown', updated_at = ? WHERE id = ? AND status = 'sending'`).bind(at, row.id),
        db.prepare(`UPDATE mail_summary_items SET status = 'unknown', error_code = 'send_outcome_unknown' WHERE batch_id = ? AND status = 'claimed'`).bind(row.id),
      ]);
      unknown += 1;
    }
  }
  return { released, unknown };
}

export async function cleanupSummaryState(db: D1Database, retentionDays: number): Promise<{ items: number; batches: number }> {
  await ensureSchema(db);
  const cutoff = new Date(Date.now() - Math.max(30, retentionDays + 30) * 86_400_000).toISOString();
  const itemResult = await db.prepare(`DELETE FROM mail_summary_items WHERE message_id IN (SELECT message_id FROM mail_summary_items WHERE status IN ('accepted', 'failed', 'unknown') AND created_at <= ? ORDER BY created_at ASC LIMIT 100)`).bind(cutoff).run();
  const batchResult = await db.prepare(`DELETE FROM mail_summary_batches WHERE id IN (SELECT id FROM mail_summary_batches WHERE status IN ('accepted', 'failed', 'unknown') AND updated_at <= ? ORDER BY updated_at ASC LIMIT 100)`).bind(cutoff).run();
  return { items: itemResult.meta.changes ?? 0, batches: batchResult.meta.changes ?? 0 };
}
