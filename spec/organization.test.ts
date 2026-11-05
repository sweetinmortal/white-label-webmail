import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { OrganizationLabel, OrganizationRule, OrganizationRuleInput } from '../shared/organization';
import { loadConfig } from '../worker/config';
import { ensureSchema } from '../worker/store/schema';
import {
  applyIncomingRules,
  attachMessageLabels,
  ensureOrganizationSchema,
  handleOrganization,
} from '../worker/services/organization';
import type { Env, Identity, MailConfig } from '../worker/types';

const baseCompany = {
  appOrigin: 'http://127.0.0.1:8788',
  mailbox: { id: 'main', address: 'owner@company.example', name: 'Company' },
  identities: [{ email: 'sales@company.example', name: 'Sales' }],
  archiveAddress: 'archive@example.net',
  allowedUsers: ['owner@company.example', 'delegate@company.example'],
  storageProvider: 'r2',
};

function config(mailboxId = 'main', incomingFilters?: MailConfig['incomingFilters']): MailConfig {
  return loadConfig({
    APP_ENV: 'local',
    COMPANY_CONFIG: JSON.stringify({ ...baseCompany, mailbox: { ...baseCompany.mailbox, id: mailboxId }, ...(incomingFilters ? { incomingFilters } : {}) }),
  } as Env);
}

function identity(mailboxId = 'main'): Identity {
  return { email: 'OWNER@COMPANY.EXAMPLE', mailboxIds: [mailboxId] };
}

let mf: Miniflare | undefined;
afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

async function setup() {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  }));
  const database = await mf.getD1Database('DB');
  const db = database as unknown as D1Database;
  await ensureSchema(db);
  await ensureOrganizationSchema(db);
  const env = { DB: db } as Env;
  return { db, env };
}

async function request(
  env: Env,
  cfg: MailConfig,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await handleOrganization(new Request(`https://mail.example${path}`, init), env, cfg, identity(cfg.mailbox.id));
  if (!response) throw new Error(`No route handled ${path}`);
  return response;
}

async function insertMessage(
  db: D1Database,
  options: {
    id: string;
    mailboxId?: string;
    direction?: 'incoming' | 'outgoing';
    from?: string;
    fromName?: string;
    to?: Array<{ email: string; name?: string }>;
    cc?: Array<{ email: string; name?: string }>;
    subject?: string;
    identityAddress?: string;
  },
) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO mail_messages
    (id, mailbox_id, direction, from_email, from_name, to_json, cc_json, subject, references_json,
      size_bytes, created_at, expires_at, archive_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 20, ?, ?, 'forward_accepted')`)
    .bind(options.id, options.mailboxId ?? 'main', options.direction ?? 'incoming', options.from ?? 'sender@example.net',
      options.fromName ?? '', JSON.stringify(options.to ?? [{ email: 'owner@company.example' }]),
      JSON.stringify(options.cc ?? []), options.subject ?? '', now,
      new Date(Date.now() + 86_400_000).toISOString()).run();
  if (options.identityAddress) {
    await db.prepare('INSERT INTO mail_message_identities (message_id, address) VALUES (?, ?)')
      .bind(options.id, options.identityAddress).run();
  }
}

async function batchInChunks(db: D1Database, statements: D1PreparedStatement[], size = 25) {
  for (let offset = 0; offset < statements.length; offset += size) {
    await db.batch(statements.slice(offset, offset + size));
  }
}

async function createLabel(env: Env, cfg: MailConfig, name = 'Priority', color = '#3167ca'): Promise<OrganizationLabel> {
  const response = await request(env, cfg, '/api/labels', 'POST', { name, color });
  expect(response.status).toBe(201);
  return await response.json() as OrganizationLabel;
}

async function createRule(env: Env, cfg: MailConfig, input: OrganizationRuleInput): Promise<OrganizationRule> {
  const response = await request(env, cfg, '/api/rules', 'POST', input);
  expect(response.status).toBe(201);
  return await response.json() as OrganizationRule;
}

describe('organization labels and rules', () => {
  it('scopes labels by mailbox, attaches several labels, and replaces message labels safely', async () => {
    const { db, env } = await setup();
    const main = config('main');
    const secondary = config('secondary');
    const mainLabelA = await createLabel(env, main, 'Shared name', '#112233');
    const mainLabelB = await createLabel(env, main, 'Another', '#445566');
    const secondaryLabel = await createLabel(env, secondary, 'Shared name', '#778899');
    await insertMessage(db, { id: 'main-message', mailboxId: 'main' });
    await insertMessage(db, { id: 'secondary-message', mailboxId: 'secondary' });

    expect((await request(env, main, '/api/messages/main-message/labels', 'PATCH', { labelIds: [mainLabelA.id, mainLabelB.id] })).status).toBe(204);
    expect((await request(env, secondary, '/api/messages/secondary-message/labels', 'PATCH', { labelIds: [secondaryLabel.id] })).status).toBe(204);

    const attached = await attachMessageLabels(db, main, [{ id: 'main-message' }, { id: 'secondary-message' }]);
    expect(attached.find((item) => item.id === 'main-message')?.labels.map((label) => label.id).sort())
      .toEqual([mainLabelA.id, mainLabelB.id].sort());
    expect(attached.find((item) => item.id === 'secondary-message')?.labels).toEqual([]);

    await expect(request(env, main, '/api/messages/main-message/labels', 'PATCH', { labelIds: [secondaryLabel.id] }))
      .rejects.toMatchObject({ status: 400, code: 'message_labels_invalid' });
    const afterInvalidReplace = await attachMessageLabels(db, main, [{ id: 'main-message' }]);
    expect(afterInvalidReplace[0].labels.map((label) => label.id).sort()).toEqual([mainLabelA.id, mainLabelB.id].sort());
  });

  it('matches every rule criterion literally and applies labels, archive, read, and ordered spam actions', async () => {
    const { db, env } = await setup();
    const cfg = config();
    const label = await createLabel(env, cfg);
    await createRule(env, cfg, {
      name: 'Invoice copy',
      enabled: true,
      criteria: { from: '@example.net', to: 'copy@company.example', subject: 'invoice', excludeSubject: 'draft' },
      actions: { labelIds: [label.id], skipInbox: true, markRead: true, spam: true },
    });
    await createRule(env, cfg, {
      name: 'Manual sender ham',
      enabled: true,
      criteria: { from: 'manual@example.net' },
      actions: { labelIds: [], skipInbox: false, markRead: false, spam: false },
    });
    await insertMessage(db, { id: 'rule-match', from: 'sender@example.net', to: [{ email: 'owner@company.example' }], cc: [{ email: 'copy@company.example' }], subject: 'Invoice 42' });
    await insertMessage(db, { id: 'rule-wrong-to', from: 'sender@example.net', to: [{ email: 'owner@company.example' }], subject: 'Invoice 42' });
    await insertMessage(db, { id: 'rule-excluded', from: 'sender@example.net', cc: [{ email: 'copy@company.example' }], subject: 'Invoice draft 42' });
    await insertMessage(db, { id: 'rule-ham', from: 'manual@example.net', cc: [{ email: 'copy@company.example' }], subject: 'Invoice 42' });
    await insertMessage(db, { id: 'rule-manual', from: 'manual@example.net', cc: [{ email: 'copy@company.example' }], subject: 'Invoice 42' });
    await db.prepare(`INSERT INTO mail_message_spam (message_id, mailbox_id, is_spam, reason, source, updated_at)
      VALUES ('rule-manual', 'main', 1, 'Manual decision', 'manual', ?)`)
      .bind(new Date().toISOString()).run();

    const matched = await applyIncomingRules(db, cfg, 'rule-match');
    expect(matched).toEqual({ skipInbox: true, isSpam: true });
    expect(await applyIncomingRules(db, cfg, 'rule-wrong-to')).toEqual({ skipInbox: false, isSpam: false });
    expect(await applyIncomingRules(db, cfg, 'rule-excluded')).toEqual({ skipInbox: false, isSpam: false });
    expect(await applyIncomingRules(db, cfg, 'rule-ham')).toEqual({ skipInbox: true, isSpam: false });
    expect(await applyIncomingRules(db, cfg, 'rule-manual')).toEqual({ skipInbox: true, isSpam: true });

    const labels = await db.prepare('SELECT label_id FROM mail_message_labels WHERE message_id = ?').bind('rule-match').all<{ label_id: string }>();
    expect(labels.results?.map((row) => row.label_id)).toEqual([label.id]);
    const readUsers = await db.prepare('SELECT user_email FROM mail_read_states WHERE message_id = ? ORDER BY user_email').bind('rule-match').all<{ user_email: string }>();
    expect(readUsers.results?.map((row) => row.user_email)).toEqual(['delegate@company.example', 'owner@company.example']);
    const spamRows = await db.prepare(`SELECT message_id, is_spam, source FROM mail_message_spam WHERE message_id IN (?, ?, ?) ORDER BY message_id`)
      .bind('rule-ham', 'rule-manual', 'rule-match').all<{ message_id: string; is_spam: number; source: string }>();
    expect(spamRows.results).toEqual([
      { message_id: 'rule-ham', is_spam: 0, source: 'rule' },
      { message_id: 'rule-manual', is_spam: 1, source: 'manual' },
      { message_id: 'rule-match', is_spam: 1, source: 'rule' },
    ]);
  });

  it('evaluates To against primary recipients, cc, and the receiving identity', async () => {
    const { db, env } = await setup();
    const cfg = config();
    const recipients = [
      ['rule-to', 'to-only@company.example', { to: [{ email: 'to-only@company.example' }] }],
      ['rule-cc', 'cc-only@company.example', { cc: [{ email: 'cc-only@company.example' }] }],
      ['rule-identity', 'identity-only@company.example', { identityAddress: 'identity-only@company.example' }],
    ] as const;
    for (const [id, recipient, messageOptions] of recipients) {
      await createRule(env, cfg, {
        name: id,
        enabled: true,
        criteria: { to: recipient },
        actions: { labelIds: [], skipInbox: true, markRead: false },
      });
      await insertMessage(db, { id, ...messageOptions });
      expect(await applyIncomingRules(db, cfg, id)).toMatchObject({ skipInbox: true });
    }
  });

  it('rejects invalid no-op rules without creating state or affecting messages', async () => {
    const { db, env } = await setup();
    const cfg = config();
    await insertMessage(db, { id: 'invalid-rule-target' });
    await expect(request(env, cfg, '/api/rules', 'POST', {
      name: 'No criteria',
      enabled: true,
      criteria: {},
      actions: { labelIds: [], skipInbox: false, markRead: false },
    })).rejects.toMatchObject({ status: 400, code: 'rule_invalid' });

    expect(await request(env, cfg, '/api/organization').then((response) => response.json())).toEqual({ labels: [], rules: [] });
    expect(await applyIncomingRules(db, cfg, 'invalid-rule-target')).toEqual({ skipInbox: false, isSpam: false });
  });

  it('rejects custom label names that collide with legacy filter labels case-insensitively', async () => {
    const { env } = await setup();
    const cfg = config('main', [{ id: 'legacy-team', label: 'Team', from: ['sender@example.net'] }]);
    await expect(request(env, cfg, '/api/labels', 'POST', { name: ' team ', color: '#aabbcc' }))
      .rejects.toMatchObject({ status: 409, code: 'label_legacy_conflict' });
    expect(await request(env, cfg, '/api/organization').then((response) => response.json())).toEqual({ labels: [], rules: [] });
  });

  it('treats metacharacters as literal substring text rather than regular expressions', async () => {
    const { db, env } = await setup();
    const cfg = config();
    await createRule(env, cfg, {
      name: 'Literal punctuation',
      enabled: true,
      criteria: { subject: 'invoice.*' },
      actions: { labelIds: [], skipInbox: true, markRead: false },
    });
    await insertMessage(db, { id: 'literal-target', subject: 'Invoice 42' });
    expect(await applyIncomingRules(db, cfg, 'literal-target')).toEqual({ skipInbox: false, isSpam: false });
  });

  it('reapplies at most 100 active incoming messages per ID cursor page', async () => {
    const { db, env } = await setup();
    const cfg = config();
    const label = await createLabel(env, cfg);
    const rule = await createRule(env, cfg, {
      name: 'Apply targets',
      enabled: true,
      criteria: { subject: 'target' },
      actions: { labelIds: [label.id], skipInbox: false, markRead: false },
    });
    await db.prepare(`WITH RECURSIVE seq(n) AS (
        SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 204
      )
      INSERT INTO mail_messages
        (id, mailbox_id, direction, from_email, from_name, to_json, cc_json, subject, references_json,
          size_bytes, created_at, expires_at, archive_status)
      SELECT 'page-' || printf('%03d', n), 'main', 'incoming', 'sender@example.net', '', '[]', '[]',
        CASE WHEN n % 10 = 0 THEN 'skip this' ELSE 'target message' END, '[]', 20, ?, ?, 'forward_accepted'
      FROM seq`)
      .bind(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()).run();

    const first = await request(env, cfg, `/api/rules/${rule.id}/apply`, 'POST', {});
    const firstPage = await first.json() as { processed: number; matched: number; nextCursor: string | null };
    expect(firstPage).toEqual({ processed: 100, matched: 90, nextCursor: 'page-099' });
    const second = await request(env, cfg, `/api/rules/${rule.id}/apply`, 'POST', { cursor: firstPage.nextCursor });
    const secondPage = await second.json() as { processed: number; matched: number; nextCursor: string | null };
    expect(secondPage).toEqual({ processed: 100, matched: 90, nextCursor: 'page-199' });
    const third = await request(env, cfg, `/api/rules/${rule.id}/apply`, 'POST', { cursor: secondPage.nextCursor });
    expect(await third.json()).toEqual({ processed: 5, matched: 4, nextCursor: null });
    const labelCount = await db.prepare('SELECT COUNT(*) AS count FROM mail_message_labels WHERE mailbox_id = ? AND label_id = ?')
      .bind('main', label.id).first<{ count: number }>();
    expect(labelCount?.count).toBe(184);
  });

  it('supports 100 labels through replacement, rule matching, and a 100-message reapply page', async () => {
    const { db, env } = await setup();
    const cfg = config();
    const labels = Array.from({ length: 100 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Bound label ${String(index).padStart(3, '0')}`,
      color: `#${index.toString(16).padStart(6, '0')}`,
    }));
    await batchInChunks(db, labels.map((label) => db.prepare('INSERT INTO mail_labels (id, mailbox_id, name, color) VALUES (?, ?, ?, ?)')
      .bind(label.id, 'main', label.name, label.color)));
    const now = new Date().toISOString();
    const messageIds = Array.from({ length: 100 }, (_, index) => `bound-${String(index).padStart(3, '0')}`);
    await batchInChunks(db, messageIds.map((id) => db.prepare(`INSERT INTO mail_messages
      (id, mailbox_id, direction, from_email, from_name, to_json, cc_json, subject, references_json,
        size_bytes, created_at, expires_at, archive_status)
      VALUES (?, 'main', 'incoming', 'sender@example.net', '', '[]', '[]', 'target', '[]', 20, ?, ?, 'forward_accepted')`)
      .bind(id, now, new Date(Date.now() + 86_400_000).toISOString())));

    const labelIds = labels.map((label) => label.id);
    expect((await request(env, cfg, '/api/messages/bound-000/labels', 'PATCH', { labelIds })).status).toBe(204);
    const rule = await createRule(env, cfg, {
      name: 'Maximum label references',
      enabled: true,
      criteria: { subject: 'target' },
      actions: { labelIds, skipInbox: false, markRead: false },
    });
    await applyIncomingRules(db, cfg, 'bound-000');
    const oneMessage = await attachMessageLabels(db, cfg, [{ id: 'bound-000' }]);
    expect(oneMessage[0].labels).toHaveLength(100);

    const page = await request(env, cfg, `/api/rules/${rule.id}/apply`, 'POST', {});
    expect(await page.json()).toEqual({ processed: 100, matched: 100, nextCursor: null });
    const associations = await db.prepare('SELECT COUNT(*) AS count FROM mail_message_labels WHERE mailbox_id = ?')
      .bind('main').first<{ count: number }>();
    expect(associations?.count).toBe(10_000);
  });

  it('prevents deleting a label used by a rule and cascades associations after deletion', async () => {
    const { db, env } = await setup();
    const cfg = config();
    const label = await createLabel(env, cfg);
    const rule = await createRule(env, cfg, {
      name: 'Keep label',
      enabled: true,
      criteria: { subject: 'keep' },
      actions: { labelIds: [label.id], skipInbox: false, markRead: false },
    });
    await expect(request(env, cfg, `/api/labels/${label.id}`, 'DELETE'))
      .rejects.toMatchObject({ status: 409, code: 'label_in_use' });
    await request(env, cfg, `/api/rules/${rule.id}`, 'DELETE');
    await insertMessage(db, { id: 'cascade-message' });
    expect((await request(env, cfg, '/api/messages/cascade-message/labels', 'PATCH', { labelIds: [label.id] })).status).toBe(204);
    expect((await request(env, cfg, `/api/labels/${label.id}`, 'DELETE')).status).toBe(204);
    const associations = await db.prepare('SELECT message_id FROM mail_message_labels WHERE label_id = ?').bind(label.id).all();
    expect(associations.results).toEqual([]);
    const message = await db.prepare('SELECT id FROM mail_messages WHERE id = ?').bind('cascade-message').first();
    expect(message).not.toBeNull();

    const anotherLabel = await createLabel(env, cfg, 'Temporary', '#aabbcc');
    await request(env, cfg, '/api/messages/cascade-message/labels', 'PATCH', { labelIds: [anotherLabel.id] });
    await db.prepare('DELETE FROM mail_messages WHERE id = ?').bind('cascade-message').run();
    const messageAssociations = await db.prepare('SELECT message_id FROM mail_message_labels WHERE label_id = ?').bind(anotherLabel.id).all();
    expect(messageAssociations.results).toEqual([]);
  });

  it('archives only incoming active messages without changing legacy incoming filters', async () => {
    const { db, env } = await setup();
    const cfg = config();
    await insertMessage(db, { id: 'archive-incoming' });
    await insertMessage(db, { id: 'archive-outgoing', direction: 'outgoing' });
    await db.prepare(`INSERT INTO mail_message_filters (message_id, mailbox_id, label, rule_id, created_at)
      VALUES ('archive-incoming', 'main', 'Legacy filter', 'legacy', ?)`)
      .bind(new Date().toISOString()).run();

    expect((await request(env, cfg, '/api/messages/archive-incoming/archive', 'PATCH', { archived: true })).status).toBe(204);
    expect(await db.prepare('SELECT skip_inbox FROM mail_message_organization WHERE message_id = ?').bind('archive-incoming').first())
      .toMatchObject({ skip_inbox: 1 });
    expect(await db.prepare('SELECT label FROM mail_message_filters WHERE message_id = ?').bind('archive-incoming').first())
      .toMatchObject({ label: 'Legacy filter' });
    expect((await request(env, cfg, '/api/messages/archive-incoming/archive', 'PATCH', { archived: false })).status).toBe(204);
    expect(await db.prepare('SELECT skip_inbox FROM mail_message_organization WHERE message_id = ?').bind('archive-incoming').first())
      .toMatchObject({ skip_inbox: 0 });
    expect(await db.prepare('SELECT label FROM mail_message_filters WHERE message_id = ?').bind('archive-incoming').first())
      .toMatchObject({ label: 'Legacy filter' });
    await expect(request(env, cfg, '/api/messages/archive-outgoing/archive', 'PATCH', { archived: true }))
      .rejects.toMatchObject({ status: 400, code: 'archive_incoming_only' });
  });
});
