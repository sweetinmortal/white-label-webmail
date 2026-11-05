import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { loadConfig } from '../worker/config';
import type { Env } from '../worker/types';
import { ensureOrganizationSchema, handleOrganization } from '../worker/services/organization';
import { getMessage, listMessages } from '../worker/services/mail';
import { enqueueSummaryItem, pendingSummaryCount } from '../worker/store/incoming-summary';
import { ensureSchema } from '../worker/store/schema';

let mf: Miniflare | undefined;
afterEach(async () => { await mf?.dispose(); });
async function setup() {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default{fetch(){return new Response()}}', d1Databases: ['DB'] }));
  const env = { DB: await mf.getD1Database('DB'), APP_ENV: 'local', COMPANY_CONFIG: JSON.stringify({
    mailbox: { id: 'main', address: 'contacto@company.example', name: 'Empresa' }, archiveAddress: 'archive@example.net', allowedUsers: ['owner@example.net'],
  }) } as unknown as Env;
  const config = loadConfig(env);
  const identity = { email: 'owner@example.net', mailboxIds: ['main'] };
  await ensureSchema(env.DB);
  await ensureOrganizationSchema(env.DB);
  await env.DB.prepare(`INSERT INTO mail_messages(id,mailbox_id,direction,from_email,to_json,subject,created_at,expires_at,archive_status)
    VALUES('message-001','main','incoming','sender@example.net','[]','Consulta',?,'2099-01-01T00:00:00Z','forward_accepted')`).bind(new Date().toISOString()).run();
  const call = (path: string, method: string, body?: object) => handleOrganization(new Request('http://127.0.0.1:8788/api' + path,
    { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, config, identity);
  return { env, config, identity, call };
}

it('returns several custom labels in both the message list and detail and searches them by name', async () => {
  const { env, config, identity, call } = await setup();
  const first = await (await call('/labels', 'POST', { name: 'Clientes/Consultas', color: '#123456' }))!.json() as { id: string };
  const second = await (await call('/labels', 'POST', { name: 'Por revisar', color: '#cc8800' }))!.json() as { id: string };
  await call('/messages/message-001/labels', 'PATCH', { labelIds: [first.id, second.id] });
  const page = await listMessages(env, config, identity, 'inbox');
  expect(page.items[0].labels?.map(l => l.id).sort()).toEqual([first.id, second.id].sort());
  expect(page.items[0].isArchived).toBe(false);
  expect((await getMessage(env, config, identity, 'message-001')).labels).toHaveLength(2);
  expect((await listMessages(env, config, identity, 'all', undefined, false, undefined, 'clientes/consultas')).items).toHaveLength(1);
  expect((await listMessages(env, config, identity, 'all', undefined, false, undefined, 'No existe')).items).toHaveLength(0);
});

it('restores a legacy filtered message to Inbox while preserving its label, and can archive it again', async () => {
  const { env, config, identity, call } = await setup();
  await env.DB.prepare(`INSERT INTO mail_message_filters(message_id,mailbox_id,label,rule_id,created_at) VALUES('message-001','main','Legacy','legacy',?)`).bind(new Date().toISOString()).run();
  expect((await listMessages(env, config, identity, 'inbox')).items).toHaveLength(0);
  await call('/messages/message-001/archive', 'PATCH', { archived: false });
  const page = await listMessages(env, config, identity, 'inbox');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ filterLabel: 'Legacy', isArchived: false });
  expect((await listMessages(env, config, identity, 'filtered')).items).toHaveLength(0);
  await call('/messages/message-001/archive', 'PATCH', { archived: true });
  expect((await listMessages(env, config, identity, 'inbox')).items).toHaveLength(0);
  expect((await listMessages(env, config, identity, 'filtered')).items[0].isArchived).toBe(true);
});

it('omits archived pending messages from summaries and respects a manual restore over a legacy filter', async () => {
  const { env, config, call } = await setup();
  await enqueueSummaryItem(env.DB, { messageId: 'message-001', mailboxId: 'main', senderEmail: 'sender@example.net', senderName: '', subject: 'Consulta',
    recipientAddress: config.mailbox.address, receivedAt: new Date().toISOString(), replyFrom: config.mailbox.address, replyTo: ['sender@example.net'], references: [] });
  expect(await pendingSummaryCount(env.DB, 'main')).toBe(1);
  await call('/messages/message-001/archive', 'PATCH', { archived: true });
  expect(await pendingSummaryCount(env.DB, 'main')).toBe(0);
  await env.DB.prepare(`INSERT INTO mail_message_filters(message_id,mailbox_id,label,rule_id,created_at) VALUES('message-001','main','Legacy','legacy',?)`).bind(new Date().toISOString()).run();
  await call('/messages/message-001/archive', 'PATCH', { archived: false });
  expect(await pendingSummaryCount(env.DB, 'main')).toBe(1);
});
