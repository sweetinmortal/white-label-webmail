import { afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { loadConfig } from '../worker/config';
import { ensureSchema } from '../worker/store/schema';
import { ensureOrganizationSchema } from '../worker/services/organization';
import { decryptGmailToken, encryptGmailToken, ensureGmailSchema, GMAIL_CALLBACK, GMAIL_SCOPE, getGmailStatus, gmailMessageIdentity, handleGmail, syncGmail } from '../worker/services/gmail-sync';
import { receiveEmail } from '../worker/services/mail';
import type { Env, IncomingEmail, MailConfig } from '../worker/types';
import worker from '../worker/index';

const APP_ORIGIN = 'https://mail.company.example';
const CLIENT_ID = '123456789012-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-gmail-client-secret-for-tests-000000';
const TOKEN_KEY = 'K'.repeat(43);
const FLOW_COOKIE = '__Host-webmail-gmail-flow';
const company = {
  appOrigin: APP_ORIGIN,
  mailbox: { id: 'main', address: 'contacto@company.example', name: 'Empresa' },
  identities: [{ email: 'ventas@company.example', name: 'Ventas' }],
  archiveAddress: 'archive@example.net',
  allowedUsers: ['owner@example.net'],
  storageProvider: 'r2',
  gmailSync: { enabled: true, intervalMinutes: 5 },
};
const identity = { email: 'owner@example.net', mailboxIds: ['main'] };
let mf: Miniflare | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await mf?.dispose();
  mf = undefined;
});

async function setup(options: { credentials?: boolean; googleAuth?: boolean; appEnv?: 'local' | 'production'; companyOverrides?: Record<string, unknown> } = {}) {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  }));
  const db = await mf.getD1Database('DB') as unknown as D1Database;
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
  const env = {
    DB: db,
    MAIL: store,
    ASSETS: {} as Fetcher,
    APP_ENV: options.appEnv ?? 'production',
    ...(options.credentials === false ? {} : {
      GMAIL_CLIENT_ID: CLIENT_ID,
      GMAIL_CLIENT_SECRET: CLIENT_SECRET,
      GMAIL_TOKEN_KEY: TOKEN_KEY,
    }),
    ...(options.googleAuth ? { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } : {}),
    COMPANY_CONFIG: JSON.stringify({ ...company, ...(options.googleAuth ? { auth: { provider: 'google' } } : {}), ...options.companyOverrides }),
  } as unknown as Env;
  const config = loadConfig(env);
  await ensureSchema(db);
  await ensureGmailSchema(db);
  return { db, env, config, objects };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function authContext(config: MailConfig, clientId = CLIENT_ID): string {
  return JSON.stringify([config.appOrigin, config.mailbox.id, config.archiveAddress, clientId]);
}
async function insertConnection(db: D1Database, config: MailConfig, cursor = '{}') {
  const context = authContext(config);
  const encrypted = await encryptGmailToken('synthetic-refresh-token', TOKEN_KEY, context);
  await db.prepare(`INSERT INTO mail_gmail_connections
    (mailbox_id,email,auth_context,encrypted_refresh,cursor_json,last_attempt_at)
    VALUES(?,?,?,?,?,0)`)
    .bind(config.mailbox.id, config.archiveAddress, context, encrypted, cursor).run();
}
function header(name: string, value: string) { return { name, value }; }
function metadata(id: string, rfcId: string, recipients: { to?: string; cc?: string } = {}, labelIds: string[] = []) {
  return {
    id,
    labelIds,
    payload: { headers: [
      header('Message-ID', rfcId),
      ...(recipients.to ? [header('To', recipients.to)] : []),
      ...(recipients.cc ? [header('Cc', recipients.cc)] : []),
      header('Subject', 'El asunto no interviene en la identidad'),
    ] },
  };
}
function metadataWithoutLabels(id: string, rfcId: string, recipients: { to?: string; cc?: string } = {}) {
  const source = metadata(id, rfcId, recipients, []);
  const { labelIds, ...withoutLabels } = source;
  void labelIds;
  return withoutLabels;
}
async function insertLocalCopy(db: D1Database, config: MailConfig, id: string, rfcId: string, recipient: string, spam?: { isSpam: 0 | 1; source: string }) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO mail_messages
    (id,mailbox_id,direction,from_email,from_name,to_json,cc_json,subject,references_json,size_bytes,created_at,received_at,expires_at,archive_status,rfc_message_id)
    VALUES(?,?,'incoming','sender@example.net','',?,?,?,'[]',50,?,?,?,'forward_accepted',?)`)
    .bind(id, config.mailbox.id, JSON.stringify([{ email: recipient }]), '[]', 'Shared subject', now, now,
      new Date(Date.now() + 86400000).toISOString(), rfcId).run();
  await db.prepare('INSERT INTO mail_message_identities(message_id,address) VALUES(?,?)').bind(id, recipient).run();
  if (spam) {
    await db.prepare(`INSERT INTO mail_message_spam(message_id,mailbox_id,is_spam,reason,source,updated_at) VALUES(?,?,?,?,?,?)`)
      .bind(id, config.mailbox.id, spam.isSpam, 'Existing decision', spam.source, now).run();
  }
}
function apiFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)), init));
}

describe('Gmail sync identity and local verdict application', () => {
  it('requires one exact Message-ID and a configured company recipient, never subject or personal mailbox matching', async () => {
    const { config } = await setup({ credentials: false, appEnv: 'local' });
    expect(gmailMessageIdentity(metadata('gmail_1', '<exact@example.net>', {
      to: 'Ventas <ventas@company.example>', cc: 'contacto@company.example',
    }), config)).toEqual({
      rfcId: '<exact@example.net>',
      recipients: ['ventas@company.example', 'contacto@company.example'],
    });
    expect(gmailMessageIdentity({
      ...metadata('gmail_2', '<same-subject-only@example.net>', { to: 'someone@gmail.com' }),
      payload: { headers: [header('Subject', 'Shared subject')] },
    }, config)).toBeNull();
    expect(gmailMessageIdentity({
      ...metadata('gmail_3', '<duplicate@example.net>', { to: 'contacto@company.example' }),
      payload: { headers: [header('Message-ID', '<one@example.net>'), header('Message-ID', '<two@example.net>'), header('To', 'contacto@company.example')] },
    }, config)).toBeNull();
    expect(gmailMessageIdentity(metadata('gmail_4', '<personal@example.net>', { to: 'owner@gmail.com' }), config)).toBeNull();
    expect(gmailMessageIdentity(metadata('gmail_5', '<no-company-recipient@example.net>'), config)).toBeNull();
  });

  it('encrypts refresh tokens with AES-GCM AAD isolation and reports status without credentials', async () => {
    const { env, config } = await setup({ credentials: false, appEnv: 'local' });
    const encrypted = await encryptGmailToken('synthetic-refresh-token', TOKEN_KEY, authContext(config));
    expect(encrypted).not.toContain('synthetic-refresh-token');
    await expect(decryptGmailToken(encrypted, TOKEN_KEY, authContext(config))).resolves.toBe('synthetic-refresh-token');
    await expect(decryptGmailToken(encrypted, TOKEN_KEY, `${authContext(config)}-other-tenant`)).rejects.toThrow();

    const status = await getGmailStatus(env, config);
    expect(status).toMatchObject({ enabled: true, configured: false, connected: false, matchedCount: 0, scanning: false,
      callbackUrl: `${APP_ORIGIN}${GMAIL_CALLBACK}` });
    expect(status).not.toHaveProperty('email');
  });

  it('keeps independent Gmail authorization scoped to the selected identity and hashes OAuth state and browser context', async () => {
    const { db, env, config } = await setup();
    await expect(handleGmail(new Request(`${APP_ORIGIN}/api/gmail/status`), env, config, { email: identity.email, mailboxIds: [] }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });

    const response = await handleGmail(new Request(`${APP_ORIGIN}/api/gmail/connect`, { method: 'POST' }), env, config, identity);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { url: string };
    const authorization = new URL(body.url);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${APP_ORIGIN}${GMAIL_CALLBACK}`);
    expect(authorization.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');

    const cookieHeader = response!.headers.get('set-cookie') ?? '';
    const browser = new RegExp(`${FLOW_COOKIE}=([^;,]*)`).exec(cookieHeader)?.[1] ?? '';
    const state = authorization.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).not.toContain('Domain=');

    const transaction = await db.prepare('SELECT * FROM mail_gmail_transactions WHERE state_hash=?').bind(await sha256(state)).first<Record<string, unknown>>();
    expect(transaction).toMatchObject({
      state_hash: await sha256(state),
      browser_hash: await sha256(browser),
      mailbox_id: config.mailbox.id,
      user_email: identity.email,
      auth_context: authContext(config),
    });
    expect(transaction?.state_hash).not.toBe(state);
    expect(transaction?.browser_hash).not.toBe(browser);
    expect(transaction?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get('code_challenge')).toBe(await sha256(String(transaction!.verifier)));
  });

  it('consumes callback state once and rejects a profile outside the configured archive mailbox', async () => {
    const { db, env, config } = await setup();
    const connect = await handleGmail(new Request(`${APP_ORIGIN}/api/gmail/connect`, { method: 'POST' }), env, config, identity);
    const authorization = new URL(((await connect!.json()) as { url: string }).url);
    const browser = new RegExp(`${FLOW_COOKIE}=([^;,]*)`).exec(connect!.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', apiFetch(async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: url.href, method });
      if (url.href === 'https://oauth2.googleapis.com/token') {
        expect(method).toBe('POST');
        const params = new URLSearchParams(String(init?.body));
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', scope: GMAIL_SCOPE });
      }
      expect(method).toBe('GET');
      expect(url.pathname).toBe('/gmail/v1/users/me/profile');
      return Response.json({ emailAddress: 'personal@gmail.com', historyId: '5' });
    }));

    const callbackUrl = `${APP_ORIGIN}${GMAIL_CALLBACK}?code=synthetic-code&state=${authorization.searchParams.get('state')}`;
    const callback = () => handleGmail(new Request(callbackUrl, { headers: { cookie: `${FLOW_COOKIE}=${browser}` } }), env, config, identity);
    const first = await callback();
    expect(first?.status).toBe(303);
    expect(new URL(first!.headers.get('location')!).searchParams.get('gmail')).toBe('wrong_account');
    expect(first!.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_connections').first<{ n: number }>()).toEqual({ n: 0 });
    expect(calls).toHaveLength(2);

    const replay = await callback();
    expect(new URL(replay!.headers.get('location')!).searchParams.get('gmail')).toBe('failed');
    expect(calls).toHaveLength(2);
  });

  it('stores a successful refresh token only as context-bound ciphertext and returns no credentials in JSON or redirect', async () => {
    const { db, env, config } = await setup();
    const connect = await handleGmail(new Request(`${APP_ORIGIN}/api/gmail/connect`, { method: 'POST' }), env, config, identity);
    const connectJson = await connect!.text();
    const authorization = new URL((JSON.parse(connectJson) as { url: string }).url);
    const browser = new RegExp(`${FLOW_COOKIE}=([^;,]*)`).exec(connect!.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const state = authorization.searchParams.get('state')!;
    expect(authorization.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(connectJson).not.toContain(CLIENT_SECRET);
    expect(connectJson).not.toContain(TOKEN_KEY);
    const refresh = 'synthetic-refresh-token-stored-encrypted';
    vi.stubGlobal('fetch', apiFetch(async (url, init) => {
      if (url.href === 'https://oauth2.googleapis.com/token') {
        expect(init?.method).toBe('POST');
        const params = new URLSearchParams(String(init?.body));
        expect(params.get('code')).toBe('synthetic-auth-code');
        expect(params.get('scope')).toBeNull();
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: refresh, scope: GMAIL_SCOPE });
      }
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url.pathname).toBe('/gmail/v1/users/me/profile');
      return Response.json({ emailAddress: config.archiveAddress, historyId: '500' });
    }));

    const callback = await handleGmail(new Request(`${APP_ORIGIN}${GMAIL_CALLBACK}?code=synthetic-auth-code&state=${state}`, {
      headers: { cookie: `${FLOW_COOKIE}=${browser}` },
    }), env, config, identity);
    expect(callback?.status).toBe(303);
    const location = callback!.headers.get('location')!;
    expect(new URL(location).searchParams.get('gmail')).toBe('connected');
    expect(location).not.toContain(refresh);
    expect(location).not.toContain('synthetic-access-token');
    expect(location).not.toContain('synthetic-auth-code');
    expect(location).not.toContain(CLIENT_SECRET);
    expect(location).not.toContain(TOKEN_KEY);
    const connection = await db.prepare('SELECT email,auth_context,encrypted_refresh,cursor_json FROM mail_gmail_connections WHERE mailbox_id=?')
      .bind(config.mailbox.id).first<{ email: string; auth_context: string; encrypted_refresh: string; cursor_json: string }>();
    expect(connection).toMatchObject({ email: config.archiveAddress, auth_context: authContext(config), cursor_json: '{}' });
    expect(connection?.encrypted_refresh).not.toContain(refresh);
    await expect(decryptGmailToken(connection!.encrypted_refresh, TOKEN_KEY, authContext(config))).resolves.toBe(refresh);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_connections').first<{ n: number }>()).toEqual({ n: 1 });
  });

  it('rejects cross-origin writes through root routes in local mode before Gmail transactions or organization changes', async () => {
    const { db, env, config } = await setup({ appEnv: 'local', credentials: false });
    await ensureOrganizationSchema(db);
    const requests: Array<{ path: string; body?: unknown }> = [
      { path: '/api/gmail/connect' },
      { path: '/api/gmail/sync' },
      { path: '/api/labels', body: { name: 'Synthetic', color: '#123456' } },
      { path: '/api/rules', body: { name: 'Synthetic rule', enabled: true, criteria: { subject: 'synthetic' }, actions: { labelIds: [], skipInbox: true, markRead: false } } },
    ];
    for (const item of requests) {
      const response = await worker.fetch(new Request(`http://127.0.0.1:8788${item.path}`, {
        method: 'POST',
        headers: { origin: 'https://attacker.example', ...(item.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(item.body === undefined ? {} : { body: JSON.stringify(item.body) }),
      }), env);
      expect(response.status, item.path).toBe(403);
      expect(await response.json(), item.path).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_transactions').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_connections').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_labels').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_rules').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('requires a production Google session at the root route before creating a Gmail connection transaction', async () => {
    const { db, env, config } = await setup({ googleAuth: true });
    await ensureOrganizationSchema(db);
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/api/gmail/connect`, {
      method: 'POST', headers: { origin: APP_ORIGIN },
    }), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_transactions').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_connections').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_labels').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_rules').first<{ n: number }>()).toEqual({ n: 0 });
    expect(config.authProvider).toBe('google');
  });

  it('lists Spam with metadata-only Gmail GETs and applies verdicts to exact recipient copies without overriding local decisions', async () => {
    const { db, env, config } = await setup();
    const rfcId = '<shared-copy@example.net>';
    await insertConnection(db, config);
    const copies = [
      ['manual-ham', 'contacto@company.example', { isSpam: 0 as const, source: 'manual' }],
      ['manual-spam', 'ventas@company.example', { isSpam: 1 as const, source: 'manual' }],
      ['blocked', 'contacto@company.example', { isSpam: 1 as const, source: 'blocked_sender' }],
      ['rule', 'ventas@company.example', { isSpam: 0 as const, source: 'rule' }],
      ['gmail-source', 'contacto@company.example', undefined],
    ] as const;
    for (const [id, recipient, prior] of copies) await insertLocalCopy(db, config, id, rfcId, recipient, prior);
    await insertLocalCopy(db, config, 'same-subject-wrong-rfc', '<different@example.net>', 'contacto@company.example');

    let labelsRemoved = false;
    const calls: Array<{ url: URL; method: string }> = [];
    vi.stubGlobal('fetch', apiFetch(async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.href === 'https://oauth2.googleapis.com/token') {
        expect(method).toBe('POST');
        expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token');
        return Response.json({ access_token: 'synthetic-access-token' });
      }
      expect(method).toBe('GET');
      expect(url.hostname).toBe('gmail.googleapis.com');
      expect(url.searchParams.has('q')).toBe(false);
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: config.archiveAddress, historyId: '100' });
      if (url.pathname.endsWith('/messages')) {
        expect(url.searchParams.get('labelIds')).toBe('SPAM');
        expect(url.searchParams.get('includeSpamTrash')).toBe('true');
        expect(url.searchParams.get('maxResults')).toBe('20');
        return Response.json({ messages: [{ id: 'gmail_spam_1' }] });
      }
      if (url.pathname.endsWith('/history')) {
        return Response.json({ history: [{ messages: [{ id: 'gmail_spam_1' }] }], historyId: '101' });
      }
      expect(url.pathname.endsWith('/messages/gmail_spam_1')).toBe(true);
      expect(url.searchParams.get('format')).toBe('metadata');
      expect(url.searchParams.get('fields')).toBe('id,labelIds,payload/headers');
      return Response.json(metadata('gmail_spam_1', rfcId, {
        to: 'contacto@company.example', cc: 'ventas@company.example',
      }, labelsRemoved ? [] : ['SPAM']));
    }));

    await syncGmail(env, config);
    expect(calls.every(call => call.url.href === 'https://oauth2.googleapis.com/token' ? call.method === 'POST' : call.method === 'GET')).toBe(true);
    const links = await db.prepare('SELECT message_id,gmail_id FROM mail_gmail_links ORDER BY message_id').all<{ message_id: string; gmail_id: string }>();
    expect(links.results.map(row => row.message_id)).toEqual(copies.map(([id]) => id).sort());
    expect(links.results.every(row => row.gmail_id === 'gmail_spam_1')).toBe(true);
    const decisions = await db.prepare('SELECT message_id,is_spam,source FROM mail_message_spam ORDER BY message_id')
      .all<{ message_id: string; is_spam: number; source: string }>();
    expect(decisions.results).toEqual([
      { message_id: 'blocked', is_spam: 1, source: 'blocked_sender' },
      { message_id: 'gmail-source', is_spam: 1, source: 'gmail' },
      { message_id: 'manual-ham', is_spam: 0, source: 'manual' },
      { message_id: 'manual-spam', is_spam: 1, source: 'manual' },
      { message_id: 'rule', is_spam: 0, source: 'rule' },
    ]);
    const observation = await db.prepare('SELECT recipients_json,is_spam FROM mail_gmail_observations WHERE mailbox_id=? AND gmail_id=?')
      .bind(config.mailbox.id, 'gmail_spam_1').first<{ recipients_json: string; is_spam: number }>();
    expect(JSON.parse(observation!.recipients_json)).toEqual(['contacto@company.example', 'ventas@company.example']);
    expect(observation?.is_spam).toBe(1);

    labelsRemoved = true;
    await db.prepare('UPDATE mail_gmail_connections SET cursor_json=?,last_attempt_at=0 WHERE mailbox_id=?')
      .bind(JSON.stringify({ phase: 'history', historyId: '100', fullAt: Date.now() }), config.mailbox.id).run();
    await syncGmail(env, config);
    const updatedObservation = await db.prepare('SELECT is_spam FROM mail_gmail_observations WHERE mailbox_id=? AND gmail_id=?')
      .bind(config.mailbox.id, 'gmail_spam_1').first<{ is_spam: number }>();
    expect(updatedObservation?.is_spam).toBe(0);
    const gmailDecision = await db.prepare('SELECT is_spam,source FROM mail_message_spam WHERE message_id=?')
      .bind('gmail-source').first<{ is_spam: number; source: string }>();
    expect(gmailDecision).toEqual({ is_spam: 0, source: 'gmail' });
  });

  it('stores observations for later delivery so an incoming cache hit inherits Gmail spam classification', async () => {
    const { db, env, config } = await setup();
    await insertConnection(db, config);
    const rfcId = '<later-delivery@example.net>';
    const observedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO mail_gmail_observations(mailbox_id,gmail_id,rfc_id,recipients_json,is_spam,updated_at,expires_at)
      VALUES(?,?,?,?,1,?,?)`).bind(config.mailbox.id, 'gmail_later_1', rfcId, JSON.stringify(['contacto@company.example']), observedAt,
        new Date(Date.now() + 3600000).toISOString()).run();
    const from = 'sender@example.net';
    const to = 'contacto@company.example';
    const raw = new TextEncoder().encode(`From: ${from}\r\nTo: ${to}\r\nSubject: Later\r\nMessage-ID: ${rfcId}\r\n\r\nSynthetic body.`);
    const message = {
      from, to, raw: new Response(raw).body!, rawSize: raw.byteLength,
      headers: new Headers({ from, to, subject: 'Later', 'message-id': rfcId }),
      forward: vi.fn(async () => undefined), setReject: vi.fn(),
    } satisfies IncomingEmail & { forward: ReturnType<typeof vi.fn>; setReject: ReturnType<typeof vi.fn> };
    await receiveEmail(env, config, message);
    const row = await db.prepare(`SELECT m.id,s.is_spam,s.source FROM mail_messages m
      LEFT JOIN mail_message_spam s ON s.message_id=m.id WHERE m.rfc_message_id=?`).bind(rfcId).first<{ id: string; is_spam: number | null; source: string | null }>();
    expect(row).toMatchObject({ is_spam: 1, source: 'gmail' });
  });

  it('treats omitted labelIds as not spam and reconciles more than ten exact alias copies over later ticks', async () => {
    const { db, env, config } = await setup();
    const rfcId = '<omitted-labels@example.net>';
    await insertConnection(db, config);
    await insertLocalCopy(db, config, 'label-omitted-copy', rfcId, 'ventas@company.example');
    vi.stubGlobal('fetch', apiFetch(async (url, init) => {
      if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token' });
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: config.archiveAddress, historyId: '900' });
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'gmail_no_labels' }] });
      return Response.json(metadataWithoutLabels('gmail_no_labels', rfcId, { cc: 'ventas@company.example' }));
    }));
    await syncGmail(env, config);
    const noLabelsObservation = await db.prepare('SELECT is_spam FROM mail_gmail_observations WHERE gmail_id=?')
      .bind('gmail_no_labels').first<{ is_spam: number }>();
    expect(noLabelsObservation?.is_spam).toBe(0);
    expect(await db.prepare('SELECT is_spam,source FROM mail_message_spam WHERE message_id=?')
      .bind('label-omitted-copy').first()).toEqual({ is_spam: 0, source: 'gmail' });

    const largeRfcId = '<many-alias-copies@example.net>';
    for (let index = 0; index < 12; index += 1) {
      const recipient = index % 2 ? 'ventas@company.example' : 'contacto@company.example';
      await insertLocalCopy(db, config, `bulk-${String(index).padStart(2, '0')}`, largeRfcId, recipient);
    }
    vi.stubGlobal('fetch', apiFetch(async (url, init) => {
      if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token' });
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: config.archiveAddress, historyId: '900' });
      if (url.pathname.endsWith('/messages')) {
        return Response.json({ messages: [{ id: 'gmail_many_alias_copies' }] });
      }
      if (url.pathname.endsWith('/history')) return Response.json({ history: [], historyId: '901' });
      expect(url.pathname.endsWith('/messages/gmail_many_alias_copies')).toBe(true);
      const value = metadata('gmail_many_alias_copies', largeRfcId, {
        to: 'contacto@company.example', cc: 'ventas@company.example',
      }, ['SPAM']);
      return Response.json(value);
    }));
    await db.prepare('DELETE FROM mail_gmail_links WHERE mailbox_id=?').bind(config.mailbox.id).run();
    await db.prepare('DELETE FROM mail_gmail_observations WHERE mailbox_id=?').bind(config.mailbox.id).run();
    await db.prepare('UPDATE mail_gmail_connections SET cursor_json=?,last_attempt_at=0 WHERE mailbox_id=?')
      .bind('{}', config.mailbox.id).run();
    await syncGmail(env, config);
    let links = await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_links WHERE gmail_id=?')
      .bind('gmail_many_alias_copies').first<{ n: number }>();
    expect(links?.n).toBe(10);
    await db.prepare('UPDATE mail_gmail_connections SET last_attempt_at=0 WHERE mailbox_id=?').bind(config.mailbox.id).run();
    await syncGmail(env, config);
    let cursor = await db.prepare('SELECT cursor_json FROM mail_gmail_connections WHERE mailbox_id=?')
      .bind(config.mailbox.id).first<{ cursor_json: string }>();
    expect(JSON.parse(cursor!.cursor_json)).toMatchObject({ phase: 'history', historyId: '900' });
    await db.prepare('UPDATE mail_gmail_connections SET last_attempt_at=0 WHERE mailbox_id=?').bind(config.mailbox.id).run();
    await syncGmail(env, config);
    links = await db.prepare('SELECT COUNT(*) AS n FROM mail_gmail_links WHERE gmail_id=?')
      .bind('gmail_many_alias_copies').first<{ n: number }>();
    expect(links?.n).toBe(12);
    const linkedIds = await db.prepare('SELECT message_id FROM mail_gmail_links WHERE gmail_id=? ORDER BY message_id')
      .bind('gmail_many_alias_copies').all<{ message_id: string }>();
    expect(linkedIds.results.map(row => row.message_id)).toEqual(Array.from({ length: 12 }, (_, i) => `bulk-${String(i).padStart(2, '0')}`));
    cursor = await db.prepare('SELECT cursor_json FROM mail_gmail_connections WHERE mailbox_id=?')
      .bind(config.mailbox.id).first<{ cursor_json: string }>();
    expect(JSON.parse(cursor!.cursor_json)).toMatchObject({ phase: 'history', historyId: '901' });
  });

  it('bounds each history tick to twenty messages, preserves failed cursors, resets stale history, and holds a single lease', async () => {
    const { db, env, config } = await setup();
    await insertConnection(db, config, JSON.stringify({ phase: 'history', historyId: '100', fullAt: Date.now() }));
    const ids = Array.from({ length: 25 }, (_, index) => `gmail_${String(index).padStart(2, '0')}`);
    let mode: 'batch' | 'failure' | 'expired' = 'batch';
    let tokenWait: Promise<void> | undefined;
    let releaseToken: (() => void) | undefined;
    let tokenStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { tokenStarted = resolve; });
    let holdFirstToken = false;
    const fetched: string[] = [];
    const fetchMock = apiFetch(async (url, init) => {
      if (url.href === 'https://oauth2.googleapis.com/token') {
        expect(init?.method).toBe('POST');
        if (holdFirstToken) {
          holdFirstToken = false;
          tokenStarted?.();
          await tokenWait;
        }
        return Response.json({ access_token: 'synthetic-access-token' });
      }
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.pathname.endsWith('/history')) {
        if (mode === 'expired') return Response.json({ error: { message: 'synthetic unavailable history' } }, { status: 404 });
        if (mode === 'failure') return Response.json({ history: [{ messages: [{ id: 'gmail_fail_1' }, { id: 'gmail_fail_2' }] }], historyId: '102' });
        return Response.json({ history: ids.map(id => ({ messages: [{ id }] })), historyId: '101' });
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      fetched.push(id);
      if (mode === 'failure' && id === 'gmail_fail_2') return Response.json({ error: { message: 'synthetic provider failure' } }, { status: 503 });
      return Response.json(metadata(id, `<${id}@example.net>`, {}, []));
    });
    vi.stubGlobal('fetch', fetchMock);

    await syncGmail(env, config);
    const afterFirst = await db.prepare('SELECT cursor_json FROM mail_gmail_connections WHERE mailbox_id=?').bind(config.mailbox.id).first<{ cursor_json: string }>();
    const firstCursor = JSON.parse(afterFirst!.cursor_json);
    expect(fetched).toHaveLength(20);
    expect(firstCursor).toMatchObject({ phase: 'history', historyId: '100', nextHistory: '101' });
    expect(firstCursor.pending).toHaveLength(5);

    await db.prepare('UPDATE mail_gmail_connections SET last_attempt_at=0 WHERE mailbox_id=?').bind(config.mailbox.id).run();
    await syncGmail(env, config);
    const afterSecond = await db.prepare('SELECT cursor_json FROM mail_gmail_connections WHERE mailbox_id=?').bind(config.mailbox.id).first<{ cursor_json: string }>();
    const secondCursor = JSON.parse(afterSecond!.cursor_json);
    expect(fetched).toHaveLength(25);
    expect(secondCursor).toMatchObject({ phase: 'history', historyId: '101' });
    expect(secondCursor).not.toHaveProperty('pending');

    const failedCursor = JSON.stringify({ phase: 'history', historyId: '101', fullAt: Date.now() });
    await db.prepare('UPDATE mail_gmail_connections SET cursor_json=?,last_attempt_at=0 WHERE mailbox_id=?')
      .bind(failedCursor, config.mailbox.id).run();
    mode = 'failure';
    await syncGmail(env, config);
    const afterFailure = await db.prepare('SELECT cursor_json,last_error FROM mail_gmail_connections WHERE mailbox_id=?')
      .bind(config.mailbox.id).first<{ cursor_json: string; last_error: string | null }>();
    expect(afterFailure?.cursor_json).toBe(failedCursor);
    expect(afterFailure?.last_error).toBe('provider_error');

    await db.prepare('UPDATE mail_gmail_connections SET cursor_json=?,last_attempt_at=0 WHERE mailbox_id=?')
      .bind(JSON.stringify({ phase: 'history', historyId: '102', fullAt: Date.now() }), config.mailbox.id).run();
    mode = 'expired';
    await syncGmail(env, config);
    const afterExpiry = await db.prepare('SELECT cursor_json,last_error,lease_id,lease_until FROM mail_gmail_connections WHERE mailbox_id=?')
      .bind(config.mailbox.id).first<{ cursor_json: string; last_error: string | null; lease_id: string | null; lease_until: number }>();
    expect(afterExpiry).toMatchObject({ cursor_json: '{}', last_error: 'history_reset', lease_id: null, lease_until: 0 });

    await db.prepare('UPDATE mail_gmail_connections SET cursor_json=?,last_attempt_at=0 WHERE mailbox_id=?')
      .bind(JSON.stringify({ phase: 'history', historyId: '103', fullAt: Date.now() }), config.mailbox.id).run();
    mode = 'batch';
    fetched.length = 0;
    let release!: () => void;
    tokenWait = new Promise<void>(resolve => { release = resolve; });
    holdFirstToken = true;
    const before = fetchMock.mock.calls.length;
    const inFlight = syncGmail(env, config);
    await started;
    await syncGmail(env, config);
    expect(fetchMock.mock.calls.length - before).toBe(1);
    release();
    await inFlight;
    expect(fetchMock.mock.calls.length - before).toBeGreaterThan(1);
  });
});
