import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { claimSummaryBatch, enqueueSummaryItem, finalizeSummaryBatch, pendingSummaryCount, recoverStaleSummaryBatches, SUMMARY_MAX_ATTEMPTS } from '../worker/store/incoming-summary';

const instances: Miniflare[] = [];

async function database(): Promise<D1Database> {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  }));
  instances.push(mf);
  return await mf.getD1Database('DB') as unknown as D1Database;
}

async function enqueue(db: D1Database, count: number, prefix = 'message'): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const receivedAt = new Date(Date.UTC(2026, 9, 21, 12, index)).toISOString();
    await enqueueSummaryItem(db, {
      messageId: `${prefix}-${index}`,
      mailboxId: 'mailbox',
      senderEmail: `sender-${index}@example.net`,
      senderName: `Sender ${index}`,
      subject: `Subject ${index}`,
      recipientAddress: 'inbox@example.com',
      receivedAt,
      replyFrom: 'inbox@example.com',
      replyTo: [`sender-${index}@example.net`],
      inReplyTo: `<parent-${index}@example.net>`,
      references: [`<root-${index}@example.net>`],
    });
  }
}

afterEach(async () => {
  while (instances.length) await instances.pop()!.dispose();
});

describe('summary queue on real D1', () => {
  it('claims exactly one complete batch at a time and finalizes its snapshot', async () => {
    const db = await database();
    await enqueue(db, 12);
    const first = await claimSummaryBatch(db, 'mailbox', 5);
    expect(first?.items).toHaveLength(5);
    expect(first?.batch.status).toBe('sending');
    const second = await claimSummaryBatch(db, 'mailbox', 5);
    expect(second?.items).toHaveLength(5);
    expect(new Set([...(first?.items ?? []), ...(second?.items ?? [])].map((item) => item.message_id)).size).toBe(10);
    expect(await pendingSummaryCount(db, 'mailbox')).toBe(2);
    await finalizeSummaryBatch(db, first!.batch.id, 'accepted', 'provider-1');
    await finalizeSummaryBatch(db, second!.batch.id, 'unknown', undefined, 'provider_exception');
    const accepted = await db.prepare(`SELECT COUNT(*) AS count FROM mail_summary_items WHERE status = 'accepted'`).first<{ count: number }>();
    const unknown = await db.prepare(`SELECT COUNT(*) AS count FROM mail_summary_items WHERE status = 'unknown'`).first<{ count: number }>();
    expect(accepted?.count).toBe(5);
    expect(unknown?.count).toBe(5);
  });

  it('releases a stale claim and never requeues a stale sending batch', async () => {
    const db = await database();
    await enqueue(db, 10);
    const claimed = await claimSummaryBatch(db, 'mailbox', 5);
    await db.prepare(`UPDATE mail_summary_batches SET status = 'claiming', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(claimed!.batch.id).run();
    const result = await recoverStaleSummaryBatches(db, 'mailbox');
    expect(result.released).toBe(1);
    expect(await pendingSummaryCount(db, 'mailbox')).toBe(10);
    const accepted = await claimSummaryBatch(db, 'mailbox', 5);
    await db.prepare(`UPDATE mail_summary_batches SET status = 'sending', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(accepted!.batch.id).run();
    const ambiguous = await recoverStaleSummaryBatches(db, 'mailbox');
    expect(ambiguous.unknown).toBe(1);
    const staleItems = await db.prepare(`SELECT COUNT(*) AS count FROM mail_summary_items WHERE batch_id = ? AND status = 'unknown'`).bind(accepted!.batch.id).first<{ count: number }>();
    expect(staleItems?.count).toBe(5);
    expect(await pendingSummaryCount(db, 'mailbox')).toBe(5);
  });

  it('retries definitive pre-send failures only a bounded number of times', async () => {
    const db = await database();
    await enqueue(db, 5);
    for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt += 1) {
      const claimed = await claimSummaryBatch(db, 'mailbox', 5);
      expect(claimed?.items).toHaveLength(5);
      expect(claimed?.items.every((item) => item.attempts === attempt)).toBe(true);
      await finalizeSummaryBatch(db, claimed!.batch.id, 'failed', undefined, 'link_unavailable');
      expect(await pendingSummaryCount(db, 'mailbox')).toBe(attempt < SUMMARY_MAX_ATTEMPTS ? 5 : 0);
    }
    const failed = await db.prepare(`SELECT COUNT(*) AS count FROM mail_summary_items WHERE status = 'failed'`).first<{ count: number }>();
    expect(failed?.count).toBe(5);
  });

  it('does not overwrite a batch recovered as unknown after the provider call', async () => {
    const db = await database();
    await enqueue(db, 5);
    const claimed = await claimSummaryBatch(db, 'mailbox', 5);
    await db.prepare(`UPDATE mail_summary_batches SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(claimed!.batch.id).run();
    await recoverStaleSummaryBatches(db, 'mailbox');
    await finalizeSummaryBatch(db, claimed!.batch.id, 'accepted', 'late-provider-id');
    const batch = await db.prepare(`SELECT status, provider_message_id FROM mail_summary_batches WHERE id = ?`).bind(claimed!.batch.id).first<{ status: string; provider_message_id: string | null }>();
    const items = await db.prepare(`SELECT COUNT(*) AS count FROM mail_summary_items WHERE batch_id = ? AND status = 'unknown'`).bind(claimed!.batch.id).first<{ count: number }>();
    expect(batch).toMatchObject({ status: 'unknown', provider_message_id: null });
    expect(items?.count).toBe(5);
  });
});
