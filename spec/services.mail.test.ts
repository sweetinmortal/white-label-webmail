import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Env, Identity, IncomingEmail, MailConfig } from '../worker/types';
import { AppError } from '../worker/errors';
import { seedLocal } from '../worker/dev';
import { cleanup, getMessage, getOutgoingAttachment, listMessages, processWebhook, receiveEmail, setRead, sendMessage } from '../worker/services/mail';
import { localProvider } from '../worker/providers/local';
import type { OutboundMessage } from '../worker/providers/types';
import { openArchiveReply, sealArchiveReply } from '../worker/services/archive-links';

type StoredMessage = Record<string, any>;

function result(changes = 0) { return { meta: { changes } }; }

class FakeStatement {
  private values: any[] = [];
  constructor(private readonly db: FakeD1, private readonly sql: string) {}
  bind(...values: any[]) { this.values = values; return this; }
  async run() { return this.db.run(this.sql, this.values); }
  async first<T = any>() { return this.db.first<T>(this.sql, this.values); }
  async all<T = any>() { return this.db.all<T>(this.sql, this.values); }
}

class FakeD1 {
  messages: StoredMessage[] = [];
  reads = new Set<string>();
  storage = new Map<string, { used: number; budget: number; paused: number }>();
  quotas = new Map<string, { count: number; limit: number }>();
  outboxes = new Map<string, StoredMessage>();
  recipients: StoredMessage[] = [];
  webhookEvents = new Set<string>();
  summaryItems = new Map<string, StoredMessage>();
  summaryBatches = new Map<string, StoredMessage>();
  failWebhookBatchOnce = false;
  prepare(sql: string) { return new FakeStatement(this, sql); }
  async batch(statements: FakeStatement[]) {
    if (this.failWebhookBatchOnce && statements.some((statement) => (statement as any).sql?.includes('INSERT OR IGNORE INTO mail_webhook_events'))) {
      this.failWebhookBatchOnce = false;
      throw new Error('simulated D1 batch failure');
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  async run(sql: string, args: any[]) {
    if (sql.startsWith('CREATE ') || sql.startsWith('CREATE INDEX')) return result();
    if (sql.includes('INSERT OR IGNORE INTO mail_storage_counters')) {
      const [mailbox, budget] = args;
      if (!this.storage.has(mailbox)) this.storage.set(mailbox, { used: 0, budget, paused: 0 });
      return result(1);
    }
    if (sql.includes('INSERT OR IGNORE INTO mail_quota_counters')) {
      const [mailbox, periodKey, limit] = args; const period = sql.includes("'day'") ? 'day' : 'month';
      this.quotas.set(`${mailbox}|${period}|${periodKey}`, { count: 0, limit }); return result(1);
    }
    if (sql.includes('UPDATE mail_quota_counters') && sql.includes('CASE WHEN period =')) {
      const [count, dailyLimit, monthlyLimit, _at, mailbox, dayKey, monthKey] = args;
      const day = this.quotas.get(`${mailbox}|day|${dayKey}`);
      const month = this.quotas.get(`${mailbox}|month|${monthKey}`);
      if (!day || !month || day.count + count > dailyLimit || month.count + count > monthlyLimit) return result();
      day.count += count; day.limit = dailyLimit; month.count += count; month.limit = monthlyLimit;
      return result(2);
    }
    if (sql.startsWith('UPDATE mail_quota_counters SET recipient_count = recipient_count +')) {
      const [count, limit, _at, mailbox, periodKey, _again, max] = args; const period = sql.includes("period = 'day'") ? 'day' : 'month';
      const row = this.quotas.get(`${mailbox}|${period}|${periodKey}`);
      if (!row || row.count + count > max) return result(); row.count += count; row.limit = limit; return result(1);
    }
    if (sql.startsWith('UPDATE mail_storage_counters SET used_bytes = used_bytes +')) {
      const [bytes, budget, _at, mailbox] = args;
      const row = this.storage.get(mailbox);
      if (!row || row.used + bytes > args[5]) return result();
      row.used += bytes; row.budget = budget; row.paused = 0; return result(1);
    }
    if (sql.startsWith('UPDATE mail_storage_counters SET used_bytes = CASE')) {
      const [bytes, _same, unpause, _at, mailbox] = args;
      const row = this.storage.get(mailbox);
      if (row) { row.used = Math.max(0, row.used - bytes); if (unpause) row.paused = 0; }
      return result(1);
    }
    if (sql.includes('INSERT INTO mail_storage_counters') && sql.includes('ON CONFLICT')) {
      const [mailbox, budget] = args;
      const row = this.storage.get(mailbox);
      if (row) { row.paused = 1; row.budget = budget; } else this.storage.set(mailbox, { used: 0, budget, paused: 1 });
      return result(1);
    }
    if (sql.includes('INSERT OR REPLACE INTO mail_read_states')) {
      this.reads.add(`${args[0]}|${args[1]}`); return result(1);
    }
    if (sql.startsWith('DELETE FROM mail_read_states')) {
      this.reads.delete(`${args[0]}|${args[1]}`); return result(1);
    }
    if (sql.startsWith('INSERT OR IGNORE INTO mail_summary_items')) {
      const [messageId, mailboxId, senderEmail, senderName, subject, recipientAddress, receivedAt, replyFrom, replyToJson, inReplyTo, referencesJson, createdAt] = args;
      if (this.summaryItems.has(messageId)) return result();
      this.summaryItems.set(messageId, { message_id: messageId, mailbox_id: mailboxId, batch_id: null, status: 'pending', sender_email: senderEmail, sender_name: senderName, subject, recipient_address: recipientAddress, received_at: receivedAt, reply_from: replyFrom, reply_to_json: replyToJson, in_reply_to: inReplyTo, references_json: referencesJson, created_at: createdAt, claimed_at: null, error_code: null, attempts: 0 });
      return result(1);
    }
    if (sql.startsWith('INSERT INTO mail_summary_batches')) {
      const [id, mailboxId, itemCount, createdAt, updatedAt] = args;
      this.summaryBatches.set(id, { id, mailbox_id: mailboxId, status: 'claiming', item_count: itemCount, provider_message_id: null, error_code: null, created_at: createdAt, updated_at: updatedAt });
      return result(1);
    }
    if (sql.startsWith("UPDATE mail_summary_items SET status = 'claimed'")) {
      const [batchId, claimedAt, mailboxId, maxAttempts, limit] = args;
      const rows = [...this.summaryItems.values()]
        .filter((row) => row.mailbox_id === mailboxId && row.status === 'pending' && row.attempts < maxAttempts)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
        .slice(0, limit);
      for (const row of rows) {
        row.status = 'claimed'; row.batch_id = batchId; row.claimed_at = claimedAt; row.error_code = null; row.attempts += 1;
      }
      return result(rows.length);
    }
    if (sql.startsWith("UPDATE mail_summary_batches SET status = 'sending'")) {
      const [updatedAt, id] = args;
      const row = this.summaryBatches.get(id);
      if (!row || row.status !== 'claiming') return result();
      row.status = 'sending'; row.updated_at = updatedAt;
      return result(1);
    }
    if (sql.startsWith('UPDATE mail_summary_batches SET status = ?')) {
      const [status, providerMessageId, errorCode, updatedAt, id] = args;
      const row = this.summaryBatches.get(id);
      if (row) { row.status = status; row.provider_message_id = providerMessageId; row.error_code = errorCode; row.updated_at = updatedAt; }
      return result(row ? 1 : 0);
    }
    if (sql.startsWith("UPDATE mail_summary_items SET status = CASE")) {
      const [maxAttempts, , , errorCode, batchId] = args;
      let changes = 0;
      for (const row of this.summaryItems.values()) {
        if (row.batch_id === batchId && row.status === 'claimed') {
          if (row.attempts >= maxAttempts) row.status = 'failed';
          else { row.status = 'pending'; row.batch_id = null; row.claimed_at = null; }
          row.error_code = errorCode; changes += 1;
        }
      }
      return result(changes);
    }
    if (sql.startsWith("UPDATE mail_summary_items SET status = ?, error_code = ? WHERE batch_id = ?")) {
      const [status, errorCode, batchId] = args;
      let changes = 0;
      for (const row of this.summaryItems.values()) {
        if (row.batch_id === batchId && row.status === 'claimed') { row.status = status; row.error_code = errorCode; changes += 1; }
      }
      return result(changes);
    }
    if (sql.startsWith("UPDATE mail_summary_items SET status = 'pending'")) {
      const [errorCode, batchId] = args;
      let changes = 0;
      for (const row of this.summaryItems.values()) {
        if (row.batch_id === batchId && row.status === 'claimed') {
          row.status = 'pending'; row.batch_id = null; row.claimed_at = null; row.error_code = errorCode; changes += 1;
        }
      }
      return result(changes);
    }
    if (sql.startsWith("UPDATE mail_summary_batches SET status = 'failed'")) {
      const [updatedAt, id] = args;
      const row = this.summaryBatches.get(id);
      if (row && row.status === 'claiming') { row.status = 'failed'; row.error_code = 'recovered_before_send'; row.updated_at = updatedAt; return result(1); }
      return result();
    }
    if (sql.startsWith("UPDATE mail_summary_batches SET status = 'unknown'")) {
      const [updatedAt, id] = args;
      const row = this.summaryBatches.get(id);
      if (row && row.status === 'sending') { row.status = 'unknown'; row.error_code = 'send_outcome_unknown'; row.updated_at = updatedAt; return result(1); }
      return result();
    }
    if (sql.startsWith("UPDATE mail_summary_items SET status = 'unknown'")) {
      const [batchId] = args;
      let changes = 0;
      for (const row of this.summaryItems.values()) {
        if (row.batch_id === batchId && row.status === 'claimed') { row.status = 'unknown'; row.error_code = 'send_outcome_unknown'; changes += 1; }
      }
      return result(changes);
    }
    if (sql.startsWith('DELETE FROM mail_summary_batches WHERE id = ?')) {
      return result(this.summaryBatches.delete(args[0]) ? 1 : 0);
    }
    if (sql.startsWith('DELETE FROM mail_summary_batches WHERE id IN')) return result();
    if (sql.startsWith('DELETE FROM mail_summary_items WHERE message_id IN')) return result();
    if (sql.includes("INSERT INTO mail_messages") && sql.includes("'outgoing'")) {
      const [id, mailboxId, fromEmail, fromName, toJson, ccJson, subject, replyToJson, rfcMessageId, referencesJson, bodyText, payloadKey, sizeBytes, createdAt, sentAt, expiresAt, archiveAddress] = args;
      this.messages.push({ id, mailbox_id: mailboxId, direction: 'outgoing', from_email: fromEmail, from_name: fromName, to_json: toJson, cc_json: ccJson, subject, reply_to_json: replyToJson, rfc_message_id: rfcMessageId, references_json: referencesJson, body_text: bodyText, raw_key: null, payload_key: payloadKey, size_bytes: sizeBytes, created_at: createdAt, received_at: null, sent_at: sentAt, expires_at: expiresAt, receipt_id: null, archive_address: archiveAddress, archive_status: 'pending', send_status: 'pending', delete_state: 'active' });
      return result(1);
    }
    if (sql.startsWith('INSERT INTO mail_outbox (')) {
      const [id, mailboxId, key, hash, payloadKey, provider, correlationId, createdAt, updatedAt] = args;
      this.outboxes.set(id, { id, mailbox_id: mailboxId, idempotency_key: key, payload_hash: hash, payload_key: payloadKey, provider, correlation_id: correlationId, status: 'pending', created_at: createdAt, updated_at: updatedAt }); return result(1);
    }
    if (sql.startsWith('INSERT INTO mail_outbox_recipients')) {
      const [outboxId, email, kind, updatedAt] = args; this.recipients.push({ outbox_id: outboxId, email, kind, provider_id: null, provider_uuid: null, status: 'pending', updated_at: updatedAt }); return result(1);
    }
    if (sql.startsWith('INSERT OR IGNORE INTO mail_webhook_events')) {
      if (this.webhookEvents.has(args[0])) return result(); this.webhookEvents.add(args[0]); return result(1);
    }
    if (sql.startsWith('INSERT OR REPLACE INTO mail_idempotency_tombstones')) return result(1);
    if (sql.startsWith("UPDATE mail_outbox SET status = 'sending'")) {
      const row = this.outboxes.get(args[1]); if (!row || row.status !== 'pending') return result(); row.status = 'sending'; row.updated_at = args[0]; return result(1);
    }
    if (sql.startsWith('UPDATE mail_outbox SET status = ?, error_code')) {
      const row = this.outboxes.get(args[3]); if (row) { row.status = args[0]; row.error_code = args[1]; row.updated_at = args[2]; } return result(row ? 1 : 0);
    }
    if (sql.startsWith('UPDATE mail_outbox_recipients SET provider_id')) {
      const [providerId, providerUuid, status, updatedAt, outboxId, email, kind] = args; const row = this.recipients.find((item) => item.outbox_id === outboxId && item.email === email && item.kind === kind); if (row) { row.provider_id = providerId; row.provider_uuid = providerUuid; row.status = status; row.updated_at = updatedAt; } return result(row ? 1 : 0);
    }
    if (sql.startsWith('UPDATE mail_messages SET send_status')) {
      if (sql.includes("SET send_status = 'failed'")) {
        const row = this.messages.find((item) => item.id === args[0]);
        if (row) { row.send_status = 'failed'; if (row.archive_status === 'pending') row.archive_status = 'failed'; }
        return result(row ? 1 : 0);
      }
      const row = this.messages.find((item) => item.id === args[4]); if (row) { row.send_status = args[0]; if (args[1] === 'accepted') row.sent_at = row.sent_at ?? args[2]; if (args[3] === 'failed' && row.archive_status === 'pending') row.archive_status = 'failed'; } return result(row ? 1 : 0);
    }
    if (sql.startsWith("UPDATE mail_messages SET archive_status = 'smtp_accepted'")) {
      const row = this.messages.find((item) => item.id === args[0] && item.archive_address === args[1]); if (row) row.archive_status = 'smtp_accepted'; return result(row ? 1 : 0);
    }
    if (sql.startsWith('UPDATE mail_messages SET archive_status = ?')) {
      const row = this.messages.find((item) => item.id === args[1] && !['failed', 'unknown'].includes(item.archive_status));
      if (row) row.archive_status = args[0];
      return result(row ? 1 : 0);
    }
    if (sql.startsWith('UPDATE mail_messages SET payload_key = NULL')) {
      const row = this.messages.find((item) => item.id === args[0]); if (row) { row.payload_key = null; row.size_bytes = 0; } return result(row ? 1 : 0);
    }
    if (sql.startsWith("UPDATE mail_outbox_recipients SET status = 'accepted'")) {
      const row = this.recipients.find((item) => item.outbox_id === args[1] && item.email === args[2]); if (row && row.status !== 'failed') row.status = 'accepted'; return result(row ? 1 : 0);
    }
    if (sql.startsWith("UPDATE mail_outbox_recipients SET status = 'failed'")) {
      const row = this.recipients.find((item) => item.outbox_id === args[1] && item.email === args[2]); if (row) row.status = 'failed'; return result(row ? 1 : 0);
    }
    if (sql.startsWith('UPDATE mail_outbox SET status = CASE')) {
      const row = this.outboxes.get(args[2]); if (row && row.status !== 'failed') row.status = 'failed'; return result(row ? 1 : 0);
    }
    if (sql.startsWith('DELETE FROM mail_outbox_recipients')) { this.recipients = this.recipients.filter((item) => item.outbox_id !== args[0]); return result(1); }
    if (sql.startsWith('DELETE FROM mail_outbox WHERE')) { this.outboxes.delete(args[0]); return result(1); }
    if (sql.startsWith('DELETE FROM mail_messages WHERE')) { this.messages = this.messages.filter((item) => item.id !== args[0]); return result(1); }
    if (sql.startsWith('DELETE FROM mail_idempotency_tombstones') || sql.startsWith('DELETE FROM mail_webhook_events')) return result(1);
    if (sql.includes("INSERT INTO mail_messages") && sql.includes("'incoming'")) {
      const [id, mailboxId, fromEmail, fromName, toJson, ccJson, subject, replyToJson, rfcMessageId, referencesJson, rawKey, sizeBytes, createdAt, receivedAt, expiresAt, receiptId, archiveAddress, archiveStatus, incomingKey] = args;
      if (incomingKey && this.messages.some((row) => row.mailbox_id === mailboxId && row.incoming_key === incomingKey)) {
        throw new Error('UNIQUE constraint failed: mail_messages.mailbox_id, mail_messages.incoming_key');
      }
      this.messages.push({ id, mailbox_id: mailboxId, direction: 'incoming', from_email: fromEmail, from_name: fromName, to_json: toJson, cc_json: ccJson, subject, reply_to_json: replyToJson, rfc_message_id: rfcMessageId, references_json: referencesJson, raw_key: rawKey, payload_key: null, body_text: null, size_bytes: sizeBytes, created_at: createdAt, received_at: receivedAt, expires_at: expiresAt, receipt_id: receiptId, archive_address: archiveAddress, archive_status: archiveStatus, send_status: null, delete_state: 'active', incoming_key: incomingKey });
      return result(1);
    }
    if (sql.includes('UPDATE mail_messages SET delete_state')) {
      const row = this.messages.find((item) => item.id === args[1] && item.delete_state === 'active');
      if (row) { row.delete_state = 'deleting'; row.delete_started_at = args[0]; return result(1); }
      return result();
    }
    return result();
  }
  async first<T = any>(sql: string, args: any[]): Promise<T | null> {
    if (sql.includes('SELECT id FROM mail_messages WHERE mailbox_id = ? AND incoming_key = ?')) {
      const row = this.messages.find((item) => item.mailbox_id === args[0] && item.incoming_key === args[1]);
      return (row ? { id: row.id } : null) as T;
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM mail_summary_items')) {
      const count = [...this.summaryItems.values()].filter((row) => row.mailbox_id === args[0] && row.status === 'pending' && row.attempts < args[1]).length;
      return { count } as T;
    }
    if (sql.includes('SELECT used_bytes')) {
      const row = this.storage.get(args[0]);
      return (row ? { used_bytes: row.used, budget_bytes: row.budget, paused: row.paused } : null) as T;
    }
    if (sql.includes('SELECT id, status, payload_hash FROM mail_outbox')) {
      const row = [...this.outboxes.values()].find((item) => item.mailbox_id === args[0] && item.idempotency_key === args[1]);
      return (row ? { id: row.id, status: row.status, payload_hash: row.payload_hash } : null) as T;
    }
    if (sql.includes('SELECT r.outbox_id, r.email FROM mail_outbox_recipients')) {
      const custom = sql.includes('o.id = ?');
      const mailbox = custom ? args[1] : args[0]; const email = custom ? args[2] : args[1];
      const id = custom ? args[0] : undefined; const providerId = custom ? undefined : args[2]; const providerUuid = custom ? undefined : args[3];
      const row = this.recipients.find((item) => this.outboxes.get(item.outbox_id)?.mailbox_id === mailbox && item.email === email && (custom ? item.outbox_id === id : item.provider_id === providerId || item.provider_uuid === providerUuid));
      return (row ? { outbox_id: row.outbox_id, email: row.email } : null) as T;
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM mail_messages')) {
      const count = this.messages.filter((row) => row.expires_at <= args[1] && ['active', 'deleting'].includes(row.delete_state) && (['pending', 'failed', 'unknown'].includes(row.archive_status) || ['pending', 'sending', 'unknown'].includes(row.send_status))).length;
      return { count } as T;
    }
    if (sql.includes('SELECT m.*, CASE')) {
      const row = this.messages.find((item) => item.id === args[1] && item.mailbox_id === args[2] && item.delete_state !== 'deleted');
      if (!row) return null;
      return { ...row, is_read: this.reads.has(`${row.id}|${args[0]}`) ? 1 : 0 } as T;
    }
    return null;
  }
  async all<T = any>(sql: string, args: any[]): Promise<{ results: T[] }> {
    if (sql.includes('FROM mail_summary_items WHERE batch_id = ?')) {
      const rows = [...this.summaryItems.values()]
        .filter((row) => row.batch_id === args[0])
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id));
      return { results: rows as T[] };
    }
    if (sql.includes('FROM mail_summary_batches WHERE mailbox_id = ?')) {
      const rows = [...this.summaryBatches.values()]
        .filter((row) => row.mailbox_id === args[0] && ['claiming', 'sending'].includes(row.status) && row.updated_at <= args[1])
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .slice(0, args[2]);
      return { results: rows.map((row) => ({ id: row.id, status: row.status })) as T[] };
    }
    if (sql.includes('ORDER BY m.created_at DESC')) {
      const userEmail = args[0];
      const mailboxId = args[1];
      const direction = args[2];
      const unreadOnly = sql.includes('r.message_id IS NULL');
      let rows = this.messages.filter((row) => row.mailbox_id === mailboxId && row.direction === direction && row.delete_state === 'active' && (!unreadOnly || !this.reads.has(`${row.id}|${userEmail}`)));
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return { results: rows.map((row) => ({ ...row, is_read: this.reads.has(`${row.id}|${userEmail}`) ? 1 : 0 })) as T[] };
    }
    if (sql.includes('FROM mail_messages m LEFT JOIN mail_outbox')) {
      const now = args[1]; const rows = this.messages.filter((row) => row.mailbox_id === args[0] && row.expires_at <= now && ['active', 'deleting'].includes(row.delete_state) && !['pending', 'failed', 'unknown'].includes(row.archive_status) && !['pending', 'sending', 'unknown'].includes(row.send_status));
      return { results: rows.map((row) => ({ ...row, ...(this.outboxes.has(row.id) ? { idempotency_key: this.outboxes.get(row.id).idempotency_key, payload_hash: this.outboxes.get(row.id).payload_hash, outbox_status: this.outboxes.get(row.id).status } : {}) })) as T[] };
    }
    return { results: [] };
  }
}

class FakeR2 {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: any) {
    if (value?.getReader) {
      const reader = value.getReader(); const parts: Uint8Array[] = [];
      while (true) { const next = await reader.read(); if (next.done) break; parts.push(next.value); }
      const length = parts.reduce((sum, part) => sum + part.byteLength, 0); const bytes = new Uint8Array(length);
      let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      this.objects.set(key, bytes);
    } else this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async get(key: string) {
    const bytes = this.objects.get(key); if (!bytes) return null;
    return { body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }
  async delete(key: string) { this.objects.delete(key); }
}

function config(mailboxId = 'company-a'): MailConfig {
  return { brand: { name: 'Mi Empresa', logo: '/logo.svg', primaryColor: '#000', locale: 'es' }, appOrigin: 'https://app.example', mailbox: { id: mailboxId, address: `${mailboxId}@example.com`, name: 'Mailbox' }, archiveAddress: 'archive@example.com', allowedUsers: ['alice@example.com', 'bob@example.com'], retentionDays: 180, cleanupEnabled: true, storageBudgetBytes: 10_000_000, maxMessageBytes: 25 * 1024 * 1024, maxComposeBytes: 100_000, maxAttachments: 5, maxAttachmentBytes: 5 * 1024 * 1024, dailyRecipientLimit: 100, monthlyRecipientLimit: 1000, mode: 'local', provider: 'local', accessTeamDomain: 'example.com', accessAudience: 'aud' };
}

const archiveKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString('base64url');
function productionArchiveConfig(): MailConfig {
  return { ...config(), mode: 'production', provider: 'mailjet', archiveCopies: { enabled: true, maxDecoratedBytes: 3 * 1024 * 1024 } };
}
function summaryConfig(batchSize = 5): MailConfig {
  return {
    ...config(),
    incomingSummary: {
      enabled: true,
      batchSize,
      from: { email: 'webmail@example.com', name: 'Webmail de Mi Empresa' },
      timeZone: 'UTC',
    },
  };
}
function summaryEnvironment(db: FakeD1, storage: FakeR2, sent: any[]): Env {
  const wrapper = {
    send: async (value: unknown) => {
      sent.push(value);
      return { messageId: `summary-${sent.length}` };
    },
  } as unknown as SendEmail;
  return { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, ARCHIVE_EMAIL_COPY: wrapper };
}
function archiveEnvironment(db: FakeD1, mail: FakeR2, copy: SendEmail): Env {
  return { ...env(db, mail), ARCHIVE_LINK_KEY: archiveKey, ARCHIVE_EMAIL_COPY: copy };
}
function rawIncoming(raw: Uint8Array, onForward: (address: string) => Promise<unknown> = async () => {}): IncomingEmail {
  return {
    from: 'sender@example.net', to: 'company-a@example.com', raw: new Blob([raw]).stream() as any,
    rawSize: raw.byteLength,
    headers: new Headers({ from: 'Sender <sender@example.net>', subject: 'Archivo', 'message-id': '<incoming@example.net>', to: 'company-a@example.com' }),
    forward: onForward, setReject: () => {},
  };
}
function bytesOf(value: Uint8Array): number[] { return Array.from(value); }

afterEach(() => vi.unstubAllGlobals());

function env(db: FakeD1, mail = new FakeR2()): Env { return { DB: db as any, MAIL: mail as any, ASSETS: {} as Fetcher }; }
function identity(mailboxId = 'company-a', email = 'alice@example.com'): Identity { return { email, mailboxIds: [mailboxId] }; }

let incomingSequence = 0;
function incoming(subject: string, forwardResult = true, messageId = `<incoming-${++incomingSequence}@example.net>`, recipient = 'company-a@example.com'): { message: IncomingEmail; rejected: string[]; forwarded: string[] } {
  const rejected: string[] = []; const forwarded: string[] = [];
  const raw = new TextEncoder().encode(`From: sender@example.net\r\nSubject: ${subject}\r\nMessage-ID: ${messageId}\r\n\r\nhello`);
  const message: IncomingEmail = { from: 'sender@example.net', to: recipient, raw: new Blob([raw]).stream() as any, rawSize: raw.byteLength, headers: new Headers({ subject, 'message-id': messageId, to: recipient, from: 'sender@example.net' }), forward: async (address) => { forwarded.push(address); if (!forwardResult) throw new Error('forward failed'); }, setReject: (reason) => rejected.push(reason) };
  return { message, rejected, forwarded };
}

describe('mail services', () => {
  it('stores inbound copies, lists unread, and scopes mailbox access', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const e = env(db, storage); const cfg = config();
    await receiveEmail(e, cfg, incoming('one').message); await receiveEmail(e, cfg, incoming('two').message);
    const page = await listMessages(e, cfg, identity(), 'inbox');
    expect(page.items).toHaveLength(2); expect(page.items.every((item) => item.isRead === false)).toBe(true);
    await setRead(e, cfg, identity(), page.items[0].id, true);
    expect((await listMessages(e, cfg, identity(), 'inbox', undefined, true)).items).toHaveLength(1);
    await expect(listMessages(e, config('company-b'), identity('company-b'), 'inbox')).resolves.toMatchObject({ items: [] });
    await expect(listMessages(e, cfg, identity('company-b'), 'inbox')).rejects.toMatchObject({ code: 'mailbox_forbidden' });
    expect(storage.objects.size).toBe(2);
  });

  it('decodes bounded RFC 2047 sender names and subjects while retaining envelope fallback', async () => {
    const db = new FakeD1(); const e = env(db); const cfg = config();
    const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const encodedName = `=?UTF-8?B?${encode('María Torres')}?=`;
    const encodedSubject = `=?UTF-8?B?${encode('Propuesta para nuestro sitio')}?=`;
    const raw = new TextEncoder().encode(`From: ${encodedName} <maria@example.com>\r\nSubject: ${encodedSubject}\r\n\r\nhello`);
    const message: IncomingEmail = {
      from: 'envelope@example.net', to: cfg.mailbox.address, raw: new Blob([raw]).stream() as any, rawSize: raw.byteLength,
      headers: new Headers({ from: `${encodedName} <maria@example.com>`, subject: encodedSubject, to: cfg.mailbox.address }),
      forward: async () => {}, setReject: (reason) => { throw new Error(reason); },
    };
    await receiveEmail(e, cfg, message);
    const item = (await listMessages(e, cfg, identity(), 'inbox')).items[0];
    expect(item.from).toEqual({ email: 'maria@example.com', name: 'María Torres' });
    expect(item.subject).toBe('Propuesta para nuestro sitio');
  });

  it('forwards even when the cache database is unavailable, and rejects only when both paths fail', async () => {
    const broken = { batch: async () => { throw new Error('D1 down'); }, prepare: () => { throw new Error('D1 down'); } };
    const first = incoming('forwarded'); await receiveEmail(env(broken as any), config(), first.message);
    expect(first.forwarded).toEqual(['archive@example.com']); expect(first.rejected).toHaveLength(0);
    const second = incoming('lost', false); await receiveEmail(env(broken as any), config(), second.message);
    expect(second.rejected).toHaveLength(1);
  });

  it('delivers the archive once before a failing cache upload', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const mail = incoming('archive first');
    storage.put = async () => {
      expect(mail.forwarded).toEqual(['archive@example.com']);
      throw new Error('temporary storage unavailable');
    };
    await receiveEmail(env(db, storage), config(), mail.message);
    expect(mail.forwarded).toEqual(['archive@example.com']);
    expect(mail.rejected).toEqual([]);
    expect(db.messages).toHaveLength(0);
    expect([...db.storage.values()].every((row) => row.used === 0)).toBe(true);
  });

  it('forwards the untouched original and never sends a decorated archive copy', async () => {
    const db = new FakeD1(); const storage = new FakeR2();
    const raw = Uint8Array.from([
      ...new TextEncoder().encode('From: sender@example.net\r\nSubject: Archivo\r\n\r\n'),
      0, 255, 128, 13, 10, 65,
    ]);
    const sent: any[] = [];
    const wrapper = { send: async (value: unknown) => { sent.push(value); return { messageId: 'unexpected-copy' }; } } as unknown as SendEmail;
    const events: string[] = [];
    const message = rawIncoming(raw, async (address) => { events.push(address); });

    await receiveEmail(archiveEnvironment(db, storage, wrapper), productionArchiveConfig(), message);

    expect(events).toEqual(['archive@example.com']);
    expect(sent).toHaveLength(0);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].archive_status).toBe('forward_accepted');
    expect(bytesOf([...storage.objects.values()][0])).toEqual(bytesOf(raw));
  });

  it('does not let a summary failure block native forwarding or the cached original', async () => {
    const db = new FakeD1(); const storage = new FakeR2();
    const rejected: string[] = []; const forwarded: string[] = [];
    const wrapper = { send: async () => { throw new Error('summary provider unavailable'); } } as unknown as SendEmail;
    const e = { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, ARCHIVE_EMAIL_COPY: wrapper } as Env;
    for (let index = 0; index < 5; index += 1) {
      const item = incoming(`Resumen ${index}`);
      item.message.forward = async (address) => { forwarded.push(address); };
      item.message.setReject = (reason) => rejected.push(reason);
      await receiveEmail(e, summaryConfig(), item.message);
    }
    expect(forwarded).toHaveLength(5);
    expect(rejected).toHaveLength(0);
    expect(storage.objects.size).toBe(5);
    expect(db.messages).toHaveLength(5);
    expect([...db.summaryItems.values()].every((item) => item.status === 'unknown')).toBe(true);
  });

  it('forwards an oversized original first and keeps it out of the summary count', async () => {
    const db = new FakeD1(); const storage = new FakeR2();
    const events: string[] = []; const sent: any[] = [];
    const raw = new Uint8Array(config().maxMessageBytes + 1);
    const message = rawIncoming(raw, async () => { events.push('forward'); });
    await receiveEmail(archiveEnvironment(db, storage, { send: async (value: unknown) => { sent.push(value); return { messageId: 'nope' }; } } as unknown as SendEmail), summaryConfig(), message);
    expect(events).toEqual(['forward']);
    expect(sent).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
    expect(db.summaryItems.size).toBe(0);
  });

  it('escapes sender display names in the summary HTML', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const sent: any[] = [];
    const e = summaryEnvironment(db, storage, sent);
    for (let index = 0; index < 4; index += 1) await receiveEmail(e, summaryConfig(), incoming(`Nombre ${index}`).message);
    for (const item of db.summaryItems.values()) item.sender_name = '<img src=x onerror=alert(1)>';
    await receiveEmail(e, summaryConfig(), incoming('Nombre final').message);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).not.toContain('<img');
    expect(sent[0].html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('sanitizes control characters before sealing summary reply links', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const sent: any[] = [];
    const e = summaryEnvironment(db, storage, sent);
    for (let index = 0; index < 4; index += 1) await receiveEmail(e, summaryConfig(), incoming(`Nombre ${index}`).message);
    for (const item of db.summaryItems.values()) item.subject = 'Hola\tmundo\x01';
    await receiveEmail(e, summaryConfig(), incoming('Nombre final').message);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Hola mundo');
    expect(sent[0].text).not.toContain('\x01');
  });

  it('forwards a duplicate Message-ID only once and consumes one summary slot', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const sent: any[] = [];
    const e = summaryEnvironment(db, storage, sent);
    const duplicateId = '<duplicate@example.net>';
    for (let index = 0; index < 4; index += 1) await receiveEmail(e, summaryConfig(), incoming(`Único ${index}`).message);
    const first = incoming('Duplicado', true, duplicateId);
    const second = incoming('Duplicado', true, duplicateId);
    await receiveEmail(e, summaryConfig(), first.message);
    await receiveEmail(e, summaryConfig(), second.message);
    expect(first.forwarded).toHaveLength(1);
    expect(second.forwarded).toHaveLength(0);
    expect(db.messages).toHaveLength(5);
    expect(sent).toHaveLength(1);
    expect([...db.summaryItems.values()].filter((item) => item.status === 'accepted')).toHaveLength(5);
    expect([...db.summaryItems.values()].filter((item) => item.status === 'pending')).toHaveLength(0);
  });

  it('retains and indexes the cached original when native forwarding fails', async () => {
    const db = new FakeD1(); const storage = new FakeR2();
    const rejected: string[] = []; const raw = new TextEncoder().encode('From: sender@example.net\r\nSubject: Archivo\r\n\r\nbody');
    const wrapper = { send: async () => { throw new Error('native delivery failed'); } } as unknown as SendEmail;
    const message = rawIncoming(raw, async () => { throw new Error('forward failed'); });
    message.setReject = (reason) => rejected.push(reason);

    await receiveEmail(archiveEnvironment(db, storage, wrapper), productionArchiveConfig(), message);
    expect(rejected).toEqual([]);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].archive_status).toBe('failed');
    expect(bytesOf([...storage.objects.values()][0])).toEqual(bytesOf(raw));
  });

  it.each([4, 5, 10, 12])('sends only complete summary batches for %i incoming messages', async (count) => {
    const db = new FakeD1(); const storage = new FakeR2(); const sent: any[] = [];
    const e = summaryEnvironment(db, storage, sent);
    for (let index = 0; index < count; index += 1) {
      await receiveEmail(e, summaryConfig(), incoming(`Correo ${index + 1}`).message);
    }
    const expectedBatches = Math.floor(count / 5);
    expect(sent).toHaveLength(expectedBatches);
    expect([...db.summaryItems.values()].filter((item) => item.status === 'pending')).toHaveLength(count % 5);
    expect([...db.summaryItems.values()].filter((item) => item.status === 'accepted')).toHaveLength(expectedBatches * 5);
    expect(db.messages).toHaveLength(count);
    for (const summary of sent) {
      expect(summary.to).toBe('archive@example.com');
      expect(summary.from).toEqual({ email: 'webmail@example.com', name: 'Webmail de Mi Empresa' });
      expect(summary.subject).toContain('5 correos');
      expect(summary.text).toContain('Responder en el webmail:');
      expect(summary.text).toContain('sender@example.net');
      expect(summary.html).toContain('Responder en el webmail');
      expect(summary.html).toContain('https://app.example/?reply=');
      expect((summary.text.match(/Responder en el webmail:/g) ?? [])).toHaveLength(5);
    }
    if (expectedBatches > 0) {
      const token = /Responder en el webmail: https:\/\/app\.example\/\?reply=([A-Za-z0-9_.-]+)/.exec(sent[0].text)?.[1];
      expect(token).toBeTruthy();
      const cfg = summaryConfig();
      storage.objects.clear();
      db.messages = [];
      await expect(openArchiveReply(e, cfg, token!)).resolves.toMatchObject({
        direction: 'incoming',
        from: 'company-a@example.com',
        to: ['sender@example.net'],
      });
    }
  });

  it('claims concurrent summary batches once without double-sending items', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const sent: any[] = [];
    const e = summaryEnvironment(db, storage, sent);
    const messages = Array.from({ length: 10 }, (_, index) => incoming(`Concurrente ${index}`).message);
    await Promise.all(messages.map((message) => receiveEmail(e, summaryConfig(), message)));
    expect(sent).toHaveLength(2);
    expect(db.messages).toHaveLength(10);
    expect(db.summaryBatches.size).toBe(2);
    expect([...db.summaryBatches.values()].every((batch) => batch.status === 'accepted')).toBe(true);
    expect([...db.summaryItems.values()].every((item) => item.status === 'accepted')).toBe(true);
  });

  it('recovers a claimed-but-unsent batch without resending an ambiguous batch', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const sent: any[] = [];
    const e = summaryEnvironment(db, storage, sent);
    for (let index = 0; index < 5; index += 1) await receiveEmail(e, summaryConfig(), incoming(`Previo ${index}`).message);
    expect(sent).toHaveLength(1);
    const accepted = [...db.summaryBatches.values()][0];
    accepted.status = 'sending'; accepted.updated_at = '2000-01-01T00:00:00.000Z';
    for (const item of db.summaryItems.values()) item.status = 'claimed';
    db.summaryItems.get([...db.summaryItems.keys()][0])!.status = 'unknown';
    db.summaryItems.get([...db.summaryItems.keys()][0])!.batch_id = accepted.id;
    await receiveEmail(e, summaryConfig(), incoming('Nuevo lote 1').message);
    for (let index = 1; index < 5; index += 1) await receiveEmail(e, summaryConfig(), incoming(`Nuevo lote ${index + 1}`).message);
    expect(sent).toHaveLength(2);
    // The ambiguous old batch is swept before the next complete batch is sent.
    expect(db.summaryBatches.get(accepted.id)?.status).toBe('unknown');
    expect([...db.summaryItems.values()].filter((item) => item.batch_id === accepted.id).every((item) => item.status === 'unknown')).toBe(true);
  });

  it('accepts a valid archived reply without a cached original and derives safe thread headers from its token', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const cfg = productionArchiveConfig();
    const token = await sealArchiveReply({ ARCHIVE_LINK_KEY: archiveKey } as Env, cfg, {
      direction: 'incoming', to: ['sender@example.net'], cc: ['copy@example.net'], subject: 'Re: propuesta — versión final',
      inReplyTo: '<latest@example.net>', references: ['<oldest@example.net>'],
    });
    const fetchMock = vi.fn(async () => Response.json({ Messages: [
      { Status: 'success', To: [{ Email: 'sender@example.net', MessageID: 401 }], Cc: [{ Email: 'copy@example.net', MessageID: 402 }] },
      { Status: 'success', To: [{ Email: 'archive@example.com', MessageID: 403 }] },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, MAILJET_API_KEY: 'test-key', MAILJET_API_SECRET: 'test-secret' } as Env;

    const sent = await sendMessage(e, cfg, identity(), {
      to: ['sender@example.net'], cc: ['copy@example.net'], subject: 'Re: propuesta', text: 'Respuesta', archiveReplyToken: token,
    }, 'archive-reply-missing-original');

    expect(sent.status).toBe('accepted');
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].rfc_message_id).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.Messages[0].Headers).toEqual({
      'In-Reply-To': '<latest@example.net>',
      References: '<oldest@example.net> <latest@example.net>',
    });
    expect(Object.keys(payload.Messages[0].Headers)).toEqual(['In-Reply-To', 'References']);
  });

  it('rejects a bad archive token before reserving quota or calling the provider', async () => {
    const db = new FakeD1(); const storage = new FakeR2();
    const fetchMock = vi.fn(async () => Response.json({ Messages: [] })); vi.stubGlobal('fetch', fetchMock);
    const e = { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, MAILJET_API_KEY: 'test-key', MAILJET_API_SECRET: 'test-secret' } as Env;

    await expect(sendMessage(e, productionArchiveConfig(), identity(), {
      to: ['customer@example.net'], subject: 'Reply', text: 'body', archiveReplyToken: 'malformed-token',
    }, 'archive-reply-invalid-token')).rejects.toMatchObject({ code: 'ARCHIVE_LINK_INVALID' });
    expect(db.quotas.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists one generated archive link across an idempotent send retry', async () => {
    const db = new FakeD1(); const storage = new FakeR2();
    const fetchMock = vi.fn(async () => Response.json({ Messages: [
      { Status: 'success', To: [{ Email: 'customer@example.net', MessageID: 501 }] },
      { Status: 'success', To: [{ Email: 'archive@example.com', MessageID: 502 }] },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, MAILJET_API_KEY: 'test-key', MAILJET_API_SECRET: 'test-secret' } as Env;
    const cfg = productionArchiveConfig(); const input = { to: ['customer@example.net'], subject: 'Once', text: 'body' };

    const first = await sendMessage(e, cfg, identity(), input, 'archive-copy-idempotency-key');
    const second = await sendMessage(e, cfg, identity(), input, 'archive-copy-idempotency-key');

    expect(first.status).toBe('accepted');
    expect(second).toEqual({ id: first.id, status: 'accepted', reused: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(db.messages).toHaveLength(1);
    expect(db.recipients).toHaveLength(2);
    expect([...db.quotas.values()].every((row) => row.count === 2)).toBe(true);
    const payload = JSON.parse(new TextDecoder().decode(storage.objects.get(db.messages[0].payload_key)!));
    expect(typeof payload.archiveReplyToken).toBe('string');
    expect(payload.archiveReplyToken).not.toContain('customer@example.net');
  });

  it('sends, archives, lists, and serves outgoing attachments without changing the idempotency payload', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const cfg = productionArchiveConfig();
    const fetchMock = vi.fn(async () => Response.json({ Messages: [
      { Status: 'success', To: [{ Email: 'customer@example.net', MessageID: 551 }] },
      { Status: 'success', To: [{ Email: 'archive@example.com', MessageID: 552 }] },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, MAILJET_API_KEY: 'test-key', MAILJET_API_SECRET: 'test-secret' } as Env;
    const input = {
      to: ['customer@example.net'], subject: 'Con adjunto', text: 'Mira el archivo.',
      attachments: [{ filename: 'foto.png', mimeType: 'image/png', contentBase64: 'AAEC' }],
    };

    const sent = await sendMessage(e, cfg, identity(), input, 'outgoing-attachment-key');
    expect(sent.status).toBe('accepted');
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.Messages).toHaveLength(2);
    for (const message of payload.Messages) {
      expect(message.Attachments).toEqual([{ ContentType: 'image/png', Filename: 'foto.png', Base64Content: 'AAEC' }]);
    }

    const detail = await getMessage(e, cfg, identity(), sent.id);
    expect(detail.attachments).toEqual([{ filename: 'foto.png', mimeType: 'image/png', sizeBytes: 3 }]);
    const response = await getOutgoingAttachment(e, cfg, identity(), sent.id, 0);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''foto.png");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([0, 1, 2]);

    await expect(sendMessage(e, cfg, identity(), {
      ...input,
      attachments: [{ filename: 'foto.png', mimeType: 'image/png', contentBase64: 'BAUG' }],
    }, 'outgoing-attachment-key')).rejects.toMatchObject({ code: 'idempotency_mismatch' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  const attachmentRejectionCases = [
    { name: 'count', limits: { maxAttachments: 1 }, attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream', contentBase64: 'AAEC' }, { filename: 'b.bin', mimeType: 'application/octet-stream', contentBase64: 'AAEC' }], error: { code: 'attachment_limit', status: 400 } },
    { name: 'total size', limits: { maxAttachmentBytes: 2 }, attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream', contentBase64: 'AAEC' }], error: { code: 'attachment_too_large', status: 413 } },
    { name: 'MIME type', limits: {}, attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream; charset=binary', contentBase64: 'AAEC' }], error: { code: 'attachment_type', status: 400 } },
    { name: 'Base64', limits: {}, attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream', contentBase64: 'A===' }], error: { code: 'attachment_invalid', status: 400 } },
  ];

  it.each(attachmentRejectionCases)('rejects outgoing attachments that exceed or violate the $name contract', async ({ limits, attachments, error }) => {
    const db = new FakeD1();
    const e = env(db);
    const input = { to: ['customer@example.net'], subject: 'Attachment check', text: 'body', attachments: attachments.map((attachment) => ({ ...attachment })) };

    await expect(sendMessage(e, { ...config(), ...limits }, identity(), input, 'attachment-validation-attempt'))
      .rejects.toMatchObject(error);
    expect(db.quotas.size).toBe(0);
    expect(db.outboxes.size).toBe(0);
  });

  it('keeps an explicitly addressed archive mailbox in the single annotated Mailjet copy', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const cfg = productionArchiveConfig();
    const fetchMock = vi.fn(async () => Response.json({ Messages: [
      { Status: 'success', To: [{ Email: 'archive@example.com', MessageID: 601 }] },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const e = { ...env(db, storage), ARCHIVE_LINK_KEY: archiveKey, MAILJET_API_KEY: 'test-key', MAILJET_API_SECRET: 'test-secret' } as Env;

    const sent = await sendMessage(e, cfg, identity(), {
      to: ['archive@example.com'], subject: 'Envío al buzón de archivo', text: 'Contenido explícito',
    }, 'archive-explicit-recipient-key');

    expect(sent.status).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledOnce();
    const mailjetPayload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(mailjetPayload.Messages).toHaveLength(1);
    expect(mailjetPayload.Messages[0].To).toEqual([{ Email: 'archive@example.com' }]);
    expect(mailjetPayload.Messages[0].TextPart).toContain('Copia archivada por Mi Empresa. Remitente original: company-a@example.com.');
    expect(db.recipients).toHaveLength(1);
    expect(db.recipients[0]).toMatchObject({ email: 'archive@example.com', kind: 'to' });

    const storedPayload = JSON.parse(new TextDecoder().decode(storage.objects.get(db.messages[0].payload_key)!));
    await expect(openArchiveReply(e, cfg, storedPayload.archiveReplyToken)).resolves.toMatchObject({
      direction: 'outgoing', to: ['archive@example.com'],
    });
  });

  it('rejects malformed compose input before any provider call', async () => {
    const db = new FakeD1(); const e = env(db); const cfg = config();
    await expect(sendMessage(e, cfg, identity(), { to: ['user@example.net'], subject: 'bad\r\nheader', text: 'x' }, 'key-1')).rejects.toMatchObject({ code: 'subject_invalid' });
    await expect(sendMessage(e, cfg, identity(), { to: Array.from({ length: 10 }, (_, index) => `u${index}@example.net`), subject: 'ok', text: 'x' }, 'key-2')).rejects.toMatchObject({ code: 'recipient_limit' });
  });

  it('does not partially consume quota when the monthly period is full', async () => {
    const db = new FakeD1(); const e = env(db); const cfg = { ...config(), monthlyRecipientLimit: 1 };
    await expect(sendMessage(e, cfg, identity(), { to: ['customer@example.net'], subject: 'quota', text: 'body' }, 'quota-key')).rejects.toMatchObject({ code: 'recipient_quota' });
    expect([...db.quotas.values()].every((row) => row.count === 0)).toBe(true);
  });

  it('adds the archive Bcc once, counts it in both quotas, and reuses an idempotent POST', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const e = env(db, storage); const cfg = config();
    const input = { to: ['customer@example.net'], subject: 'hello', text: 'body' };
    const first = await sendMessage(e, cfg, identity(), input, 'stable-key');
    const second = await sendMessage(e, cfg, identity(), input, 'stable-key');
    expect(first.status).toBe('accepted'); expect(second).toEqual({ id: first.id, status: 'accepted', reused: true });
    expect(db.recipients.filter((item) => item.outbox_id === first.id).map((item) => item.email)).toEqual(['customer@example.net', 'archive@example.com']);
    expect([...db.quotas.values()].every((row) => row.count === 2)).toBe(true);
    expect(db.messages.find((item) => item.id === first.id)?.rfc_message_id).toBeNull();
    expect(db.messages.find((item) => item.id === first.id)?.body_text).toBeNull();
    const detail = await getMessage(e, cfg, identity(), first.id);
    expect(detail.archiveStatus).toBe('smtp_accepted'); expect(detail.to).toEqual([{ email: 'customer@example.net' }]);
    expect(detail.bodyText).toBe('body');
    const snapshot = JSON.parse(new TextDecoder().decode(storage.objects.get(db.messages.find((item) => item.id === first.id)?.payload_key!)!));
    expect(snapshot.bcc).toEqual(['archive@example.com']);
    storage.objects.clear();
    await expect(getMessage(e, cfg, identity(), first.id)).rejects.toMatchObject({ code: 'payload_not_available' });
    await expect(sendMessage(e, cfg, identity(), { ...input, text: 'changed' }, 'stable-key')).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  });

  it('correlates webhooks to the archive recipient and never lets stale sent overwrite a bounce', async () => {
    const db = new FakeD1(); const e = env(db); const cfg = config();
    const sent = await sendMessage(e, cfg, identity(), { to: ['customer@example.net'], subject: 'hello', text: 'body' }, 'webhook-key');
    await processWebhook(e, cfg, { event: 'bounce', CustomID: sent.id, email: 'archive@example.com', MessageID: 42 });
    expect((await getMessage(e, cfg, identity(), sent.id)).sendStatus).toBe('failed');
    expect(db.outboxes.get(sent.id)?.status).toBe('failed');
    await processWebhook(e, cfg, { event: 'sent', CustomID: sent.id, email: 'archive@example.com', MessageID: 43 });
    expect((await getMessage(e, cfg, identity(), sent.id)).archiveStatus).toBe('failed');
    await processWebhook(e, cfg, { event: 'bounce', CustomID: 'foreign-id', email: 'archive@example.com', MessageID: 99 });
    expect(db.messages).toHaveLength(1);
  });

  it('retries a webhook after an atomic D1 batch failure', async () => {
    const db = new FakeD1(); const e = env(db); const cfg = config();
    const sent = await sendMessage(e, cfg, identity(), { to: ['customer@example.net'], subject: 'hello', text: 'body' }, 'retry-webhook-key');
    db.failWebhookBatchOnce = true;
    await expect(processWebhook(e, cfg, { event: 'bounce', CustomID: sent.id, email: 'customer@example.net', MessageID: 77 })).rejects.toThrow('simulated D1 batch failure');
    expect(db.webhookEvents).toHaveLength(0);
    await processWebhook(e, cfg, { event: 'bounce', CustomID: sent.id, email: 'customer@example.net', MessageID: 77 });
    expect((await getMessage(e, cfg, identity(), sent.id)).sendStatus).toBe('failed');
    expect(db.recipients.find((item) => item.outbox_id === sent.id && item.email === 'customer@example.net')?.status).toBe('failed');
  });

  it('cleans expired eligible copies in bounded passes and holds unknown archive state', async () => {
    const db = new FakeD1(); const storage = new FakeR2(); const e = env(db, storage); const cfg = config();
    await receiveEmail(e, cfg, incoming('old').message);
    db.messages[0].expires_at = '2000-01-01T00:00:00.000Z';
    expect(await cleanup(e, cfg)).toEqual({ deleted: 1, held: 0 }); expect(storage.objects.size).toBe(0);
    await receiveEmail(e, cfg, incoming('held').message);
    db.messages[0].expires_at = '2000-01-01T00:00:00.000Z'; db.messages[0].archive_status = 'unknown';
    expect(await cleanup(e, cfg)).toEqual({ deleted: 0, held: 1 }); expect(storage.objects.size).toBe(1);
  });

  it('uses simulated IDs only for an explicitly local provider', async () => {
    const message: OutboundMessage = { id: 'm1', from: { email: 'company-a@example.com' }, to: [{ email: 'to@example.net', kind: 'to' }], subject: 's', text: 't', attachments: [], headers: {}, customId: 'm1', archiveAddress: 'archive@example.com' };
    const result = await localProvider.send({} as Env, config(), message);
    expect(result.outcome).toBe('accepted'); expect(result.recipients[0].providerId).toBe('local-m1-1');
    const production = { ...config(), mode: 'production' as const, provider: 'local' as const };
    expect((await localProvider.send({} as Env, production, message)).outcome).toBe('definite_failure');
  });

  it('seeds six messages once against a real migrated D1 and R2 binding', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      r2Buckets: ['MAIL'],
    }));
    try {
      const db = await mf.getD1Database('DB');
      for (const name of ['0001_mail.sql', '0006_incoming_summary.sql']) {
        const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
        const statements = migration
          .replace(/^[ \t]*--[^\r\n]*(?:\r?\n|$)/gm, '')
          .split(';')
          .map((statement) => statement.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        for (const statement of statements) await db.exec(`${statement};`);
      }
      // Miniflare's R2 binding does not accept a Node ReadableStream in all
      // supported versions; D1 and the migration are the integration target
      // here, while this focused fake keeps seed storage deterministic.
      const mail = new FakeR2();
      const cfg = config('seed-mailbox');
      const realEnv = { DB: db, MAIL: mail, ASSETS: {} as Fetcher } as Env;

      await seedLocal(realEnv, cfg);
      const first = await db.prepare('SELECT COUNT(*) AS count FROM mail_messages WHERE mailbox_id = ?').bind(cfg.mailbox.id).first<{ count: number }>();
      await seedLocal(realEnv, cfg);
      const second = await db.prepare('SELECT COUNT(*) AS count FROM mail_messages WHERE mailbox_id = ?').bind(cfg.mailbox.id).first<{ count: number }>();

      expect(first?.count).toBe(6);
      expect(second?.count).toBe(6);
    } finally {
      await mf.dispose();
    }
  }, 30000);
});
