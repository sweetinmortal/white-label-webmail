import { afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { loadConfig } from '../worker/config';
import { ensureSchema } from '../worker/store/schema';
import { claimSummaryBatch, pendingSummaryCount } from '../worker/store/incoming-summary';
import { getMessage, getRaw, listMessages, receiveEmail, setSpam } from '../worker/services/mail';
import { classifyIncomingSpam, quarantineBlockedSenders } from '../worker/services/spam';
import type { Env, IncomingEmail, MailConfig } from '../worker/types';

const company = {
  appOrigin: 'http://127.0.0.1:8788',
  mailbox: { id: 'main', address: 'contacto@company.example', name: 'Empresa' },
  identities: [{ email: 'ventas@company.example', name: 'Ventas' }],
  archiveAddress: 'archive@example.net',
  allowedUsers: ['owner@example.net'],
  storageProvider: 'r2',
};
const identity = { email: 'owner@example.net', mailboxIds: ['main'] };
const config = (overrides: Record<string, unknown> = {}) => loadConfig({
  APP_ENV: 'local',
  COMPANY_CONFIG: JSON.stringify({ ...company, ...overrides }),
} as Env);
const summaryConfig = (overrides: Record<string, unknown> = {}) => config({
  ...overrides,
  incomingSummary: {
    enabled: true,
    from: { email: 'summary@company.example', name: 'Resumen' },
    timeZone: 'UTC',
    schedule: { hour: 8, minute: 0, weekdaysOnly: true },
  },
});

interface IncomingOptions {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  body?: string;
  headers?: HeadersInit;
  rawHeaders?: string[];
}

let messageSequence = 0;
function incoming(options: IncomingOptions = {}): { message: IncomingEmail & { forward: ReturnType<typeof vi.fn>; setReject: ReturnType<typeof vi.fn> }; bytes: Uint8Array } {
  const from = options.from ?? 'sender@example.net';
  const to = options.to ?? 'ventas@company.example';
  const subject = options.subject ?? 'Consulta';
  const messageId = options.messageId ?? `<spam-test-${++messageSequence}@example.net>`;
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    ...(options.rawHeaders ?? []),
    '',
    options.body ?? 'Original message body.',
  ].join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from, to, subject, 'message-id': messageId });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  const message = {
    from,
    to,
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    headers,
    forward: vi.fn(async (_address: string) => undefined),
    setReject: vi.fn(),
  } satisfies IncomingEmail & { forward: ReturnType<typeof vi.fn>; setReject: ReturnType<typeof vi.fn> };
  return { message, bytes };
}

let mf: Miniflare | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await mf?.dispose();
  mf = undefined;
});

async function setup() {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  }));
  const db = await mf.getD1Database('DB');
  const objects = new Map<string, Uint8Array>();
  const store = {
    async put(key: string, value: unknown) {
      objects.set(key, new Uint8Array(await new Response(value as BodyInit).arrayBuffer()));
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { body: new Response(value).body, text: async () => new TextDecoder().decode(value) } : null;
    },
    async delete(key: string) { objects.delete(key); },
  };
  const env = { DB: db, MAIL: store, ASSETS: {} } as unknown as Env;
  await ensureSchema(db as unknown as D1Database);
  return { db: db as unknown as D1Database, env, objects };
}

async function insertStoredMessage(
  db: D1Database,
  row: { id: string; mailboxId: string; direction: 'incoming' | 'outgoing'; from: string },
) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await db.prepare(`INSERT INTO mail_messages
    (id, mailbox_id, direction, from_email, from_name, to_json, cc_json, subject, references_json, size_bytes, created_at, expires_at, archive_status)
    VALUES (?, ?, ?, ?, '', '[]', '[]', '', '[]', 32, ?, ?, 'forward_accepted')`)
    .bind(row.id, row.mailboxId, row.direction, row.from, createdAt, expiresAt).run();
}

describe('spam classification', () => {
  it('normalizes configured blocked senders and matches the envelope address case-insensitively', () => {
    const cfg = config({ spamProtection: { blockedSenders: ['Blocked@Example.NET', 'BLOCKED@example.net'] } });
    expect(cfg.spamProtection).toEqual({ enabled: true, blockedSenders: ['blocked@example.net'] });
    expect(classifyIncomingSpam(new Headers(), ' BLOCKED@example.NET ', cfg)).toMatchObject({
      isSpam: true,
      source: 'blocked_sender',
    });
  });

  it('uses only a first Authentication-Results result identifying mx.cloudflare.net for DMARC failure', () => {
    const cfg = config();
    const verdict = (value: string) => classifyIncomingSpam(new Headers({ 'authentication-results': value }), 'sender@example.net', cfg);
    expect(verdict('mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail')).toMatchObject({ isSpam: true, source: 'cloudflare_dmarc' });
    for (const value of [
      'attacker.example; dmarc=fail',
      'sender.example; dmarc=fail, mx.cloudflare.net; dmarc=fail',
      'mx.cloudflare.net; dmarc=pass, attacker.example; dmarc=fail',
      'mx.cloudflare.net; dmarc=pass, mx.cloudflare.net; dmarc=fail',
      'x-authentication-results: mx.cloudflare.net; dmarc=fail',
    ]) {
      expect(verdict(value), value).toMatchObject({ isSpam: false, source: 'none' });
    }
  });

  it('uses positive spam headers as hints but does not trust score-only headers or benign marketing wording', () => {
    const cfg = config();
    for (const [name, value] of [
      ['x-spam-flag', 'YES'],
      ['x-spam-status', 'Yes, score=5'],
      ['x-cfemailsecurity-disposition', 'phish'],
    ]) {
      expect(classifyIncomingSpam(new Headers({ [name]: value }), 'sender@example.net', cfg)).toMatchObject({
        isSpam: true,
        source: 'upstream_hint',
      });
    }

    const benign = classifyIncomingSpam(new Headers({
      subject: 'Urgent update: our marketing newsletter',
      'x-cf-spamh-score': '8',
      'x-spam-score': '9',
    }), 'news@marketing.example.net', cfg);
    expect(benign).toMatchObject({ isSpam: false, source: 'none' });
  });

  it('allows an explicit disabled policy to turn off all spam classification', () => {
    const cfg = config({ spamProtection: { enabled: false, blockedSenders: ['blocked@example.net'] } });
    const headers = new Headers({
      'authentication-results': 'mx.cloudflare.net; dmarc=fail',
      'x-spam-flag': 'yes',
    });
    expect(classifyIncomingSpam(headers, 'blocked@example.net', cfg)).toMatchObject({ isSpam: false, source: 'none' });
  });

  it('rejects malformed spam protection configuration', () => {
    for (const policy of [
      null,
      [],
      { enabled: 'yes' },
      { blockedSenders: 'blocked@example.net' },
      { blockedSenders: ['not-an-email'] },
      { blockedSenders: Array.from({ length: 501 }, (_, index) => `blocked-${index}@example.net`) },
    ]) {
      expect(() => config({ spamProtection: policy })).toThrow();
    }
  });
});

describe('spam folder and manual review with real D1 queries', () => {
  it('forwards and caches the exact original while storing spam separately from inbox, all, filtered and summaries', async () => {
    const { env, db } = await setup();
    const cfg = summaryConfig({
      spamProtection: { blockedSenders: ['blocked@example.net'] },
      incomingFilters: [{ id: 'blocked-news', label: 'Updates', from: ['blocked@example.net'] }],
    });
    const flagged = incoming({
      from: 'blocked@example.net',
      subject: 'Urgent offer',
      rawHeaders: ['X-Original-Trace: preserve-this-header'],
    });
    await receiveEmail(env, cfg, flagged.message);
    expect(flagged.message.forward).toHaveBeenCalledOnce();
    expect(flagged.message.forward).toHaveBeenCalledWith(cfg.archiveAddress);
    expect(flagged.message.setReject).not.toHaveBeenCalled();

    const spam = await listMessages(env, cfg, identity, 'spam');
    expect(spam.items).toHaveLength(1);
    const flaggedSummary = spam.items[0];
    expect(flaggedSummary).toMatchObject({ isSpam: true, spamReason: expect.any(String) });
    expect((await getMessage(env, cfg, identity, flaggedSummary.id))).toMatchObject({
      isSpam: true,
      spamReason: expect.any(String),
      rawAvailable: true,
    });
    for (const folder of ['inbox', 'all', 'filtered'] as const) {
      expect((await listMessages(env, cfg, identity, folder)).items.map(item => item.id)).not.toContain(flaggedSummary.id);
    }

    const original = await getRaw(env, cfg, identity, flaggedSummary.id);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(flagged.bytes);
    const spamMetadata = await db.prepare('SELECT is_spam, source FROM mail_message_spam WHERE message_id = ?')
      .bind(flaggedSummary.id).first<{ is_spam: number; source: string }>();
    expect(spamMetadata).toEqual({ is_spam: 1, source: 'blocked_sender' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mail_summary_items WHERE message_id = ?')
      .bind(flaggedSummary.id).first<{ count: number }>()).toEqual({ count: 0 });

    const clean = incoming({ from: 'client@example.net', subject: 'Pregunta normal' });
    await receiveEmail(env, cfg, clean.message);
    const inbox = await listMessages(env, cfg, identity, 'inbox');
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ isSpam: false });
    expect((await listMessages(env, cfg, identity, 'spam')).items).toHaveLength(1);
    expect(await pendingSummaryCount(db, cfg.mailbox.id)).toBe(1);
    const claimed = await claimSummaryBatch(db, cfg.mailbox.id, 1);
    expect(claimed?.items.map(item => item.message_id)).toEqual([inbox.items[0].id]);
  });

  it('restores manual spam to inbox or its original filter and persists the manual ham decision', async () => {
    const { env, db } = await setup();
    const cfg = config({ incomingFilters: [{ id: 'promotions', label: 'Promotions', from: ['promo@example.net'] }] });

    const ordinary = incoming({ from: 'client@example.net' });
    await receiveEmail(env, cfg, ordinary.message);
    const ordinaryItem = (await listMessages(env, cfg, identity, 'inbox')).items[0];
    await setSpam(env, cfg, identity, ordinaryItem.id, true);
    expect((await listMessages(env, cfg, identity, 'spam')).items.map(item => item.id)).toContain(ordinaryItem.id);
    expect((await listMessages(env, cfg, identity, 'inbox')).items.map(item => item.id)).not.toContain(ordinaryItem.id);
    await setSpam(env, cfg, identity, ordinaryItem.id, false);
    expect((await listMessages(env, cfg, identity, 'inbox')).items.map(item => item.id)).toContain(ordinaryItem.id);
    expect((await listMessages(env, cfg, identity, 'spam')).items.map(item => item.id)).not.toContain(ordinaryItem.id);

    const promotion = incoming({ from: 'promo@example.net', subject: 'Seasonal collection' });
    await receiveEmail(env, cfg, promotion.message);
    const filteredItem = (await listMessages(env, cfg, identity, 'filtered')).items[0];
    expect(filteredItem.filterLabel).toBe('Promotions');
    await setSpam(env, cfg, identity, filteredItem.id, true);
    expect((await listMessages(env, cfg, identity, 'spam')).items.map(item => item.id)).toContain(filteredItem.id);
    expect((await listMessages(env, cfg, identity, 'filtered')).items.map(item => item.id)).not.toContain(filteredItem.id);
    await setSpam(env, cfg, identity, filteredItem.id, false);
    const restored = (await listMessages(env, cfg, identity, 'filtered')).items.find(item => item.id === filteredItem.id);
    expect(restored).toMatchObject({ isSpam: false, filterLabel: 'Promotions' });
    expect((await listMessages(env, cfg, identity, 'inbox')).items.map(item => item.id)).not.toContain(filteredItem.id);

    const hamMetadata = await db.prepare('SELECT is_spam, source FROM mail_message_spam WHERE message_id = ?')
      .bind(filteredItem.id).first<{ is_spam: number; source: string }>();
    expect(hamMetadata).toMatchObject({ is_spam: 0, source: 'manual' });
    expect((await getMessage(env, cfg, identity, filteredItem.id))).toMatchObject({ isSpam: false });
    expect((await getMessage(env, cfg, identity, filteredItem.id)).spamReason).toBeUndefined();
  });

  it('excludes a manually spammed pending summary item from count and claim, then allows a restore', async () => {
    const { env, db } = await setup();
    const cfg = summaryConfig();
    const clean = incoming({ from: 'client@example.net' });
    await receiveEmail(env, cfg, clean.message);
    const item = (await listMessages(env, cfg, identity, 'inbox')).items[0];
    expect(await pendingSummaryCount(db, cfg.mailbox.id)).toBe(1);

    await setSpam(env, cfg, identity, item.id, true);
    expect(await pendingSummaryCount(db, cfg.mailbox.id)).toBe(0);
    expect(await claimSummaryBatch(db, cfg.mailbox.id, 1)).toBeNull();
    expect(await db.prepare('SELECT status FROM mail_summary_items WHERE message_id = ?').bind(item.id)
      .first<{ status: string }>()).toEqual({ status: 'pending' });

    await setSpam(env, cfg, identity, item.id, false);
    expect(await pendingSummaryCount(db, cfg.mailbox.id)).toBe(1);
    const claimed = await claimSummaryBatch(db, cfg.mailbox.id, 1);
    expect(claimed?.items.map(summaryItem => summaryItem.message_id)).toEqual([item.id]);
  });

  it('limits manual classification to incoming messages and the authenticated mailbox', async () => {
    const { env, db } = await setup();
    const cfg = config();
    await insertStoredMessage(db, { id: 'incoming-main', mailboxId: cfg.mailbox.id, direction: 'incoming', from: 'sender@example.net' });
    await insertStoredMessage(db, { id: 'incoming-other', mailboxId: 'other', direction: 'incoming', from: 'sender@example.net' });
    await insertStoredMessage(db, { id: 'outgoing-main', mailboxId: cfg.mailbox.id, direction: 'outgoing', from: cfg.mailbox.address });

    await expect(setSpam(env, cfg, { ...identity, mailboxIds: [] }, 'incoming-main', true))
      .rejects.toMatchObject({ code: 'mailbox_forbidden' });
    await expect(setSpam(env, cfg, identity, 'incoming-other', true))
      .rejects.toMatchObject({ code: 'message_not_found' });
    await expect(setSpam(env, cfg, identity, 'outgoing-main', true))
      .rejects.toMatchObject({ code: 'spam_incoming_only' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mail_message_spam').first<{ count: number }>())
      .toEqual({ count: 0 });
  });

  it('backfills blocked historical incoming messages in chunks without touching other mailboxes or manual restores', async () => {
    const { env, db } = await setup();
    const blockedSenders = Array.from({ length: 51 }, (_, index) => `blocked-${index}@example.test`);
    const cfg = config({ spamProtection: { blockedSenders } });
    for (let index = 0; index < blockedSenders.length; index += 1) {
      await insertStoredMessage(db, {
        id: `historic-${index}`,
        mailboxId: cfg.mailbox.id,
        direction: 'incoming',
        from: blockedSenders[index],
      });
    }
    await insertStoredMessage(db, { id: 'historic-other-mailbox', mailboxId: 'other', direction: 'incoming', from: blockedSenders[0] });
    await insertStoredMessage(db, { id: 'historic-outgoing', mailboxId: cfg.mailbox.id, direction: 'outgoing', from: blockedSenders[1] });

    expect(await quarantineBlockedSenders(db, cfg)).toBe(51);
    const decisions = await db.prepare('SELECT message_id, is_spam, source FROM mail_message_spam ORDER BY message_id')
      .all<{ message_id: string; is_spam: number; source: string }>();
    expect(decisions.results).toHaveLength(51);
    expect(decisions.results?.every(row => row.is_spam === 1 && row.source === 'blocked_sender')).toBe(true);
    expect(decisions.results?.map(row => row.message_id)).not.toContain('historic-other-mailbox');
    expect(decisions.results?.map(row => row.message_id)).not.toContain('historic-outgoing');

    await setSpam(env, cfg, identity, 'historic-0', false);
    expect(await quarantineBlockedSenders(db, cfg)).toBe(0);
    await db.prepare("UPDATE mail_message_spam SET is_spam=0,source='gmail' WHERE message_id='historic-1'").run();
    await db.prepare("UPDATE mail_message_spam SET is_spam=0,source='rule' WHERE message_id='historic-2'").run();
    expect(await quarantineBlockedSenders(db, cfg)).toBe(1);
    expect(await db.prepare("SELECT is_spam,source FROM mail_message_spam WHERE message_id='historic-1'").first()).toMatchObject({ is_spam: 1, source: 'blocked_sender' });
    expect(await db.prepare("SELECT is_spam,source FROM mail_message_spam WHERE message_id='historic-2'").first()).toMatchObject({ is_spam: 0, source: 'rule' });
    expect(await db.prepare('SELECT is_spam, source FROM mail_message_spam WHERE message_id = ?').bind('historic-0')
      .first<{ is_spam: number; source: string }>()).toMatchObject({ is_spam: 0, source: 'manual' });
  });
});
