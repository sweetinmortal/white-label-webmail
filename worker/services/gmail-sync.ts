import { addressParser } from 'postal-mime';
import type { Env, Identity, MailConfig } from '../types';
import type { GmailSyncStatus } from '../../shared/gmail';
import { AppError } from '../errors';
import { json } from '../http';
import { mailIdentities } from '../config';
import { ensureSchema, nowIso, parseJson } from '../store/schema';

// GET-only Gmail access. This integration cannot change a Gmail message.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
export const GMAIL_CALLBACK = '/api/gmail/callback';
const FLOW_COOKIE = '__Host-webmail-gmail-flow';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const enc = new TextEncoder();
const opaqueRE = /^[A-Za-z0-9_-]{43}$/;
const idRE = /^[A-Za-z0-9_-]{1,128}$/;
const schemaReady = new WeakMap<object, Promise<void>>();
const PAGE_SIZE = 20; // <50 subrequests on Workers Free, including OAuth.

interface Cursor {
  phase?: 'spam' | 'links' | 'history';
  historyId?: string;
  baseline?: string;
  page?: string;
  linkAfter?: string;
  pending?: string[];
  nextPage?: string;
  nextHistory?: string;
  fullAt?: number;
}
interface Connection {
  mailbox_id: string; email: string; auth_context: string; encrypted_refresh: string;
  cursor_json: string; last_synced_at: string | null; last_attempt_at: number;
  last_error: string | null; lease_id: string | null;
}
export interface GmailMetadata {
  id: string; labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
}
class GmailFailure extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}

export async function ensureGmailSchema(db: D1Database): Promise<void> {
  let running = schemaReady.get(db);
  if (!running) {
    running = (async () => {
      await ensureSchema(db);
      await db.batch([
        `CREATE TABLE IF NOT EXISTS mail_gmail_connections(mailbox_id TEXT PRIMARY KEY,email TEXT NOT NULL,auth_context TEXT NOT NULL,encrypted_refresh TEXT NOT NULL,cursor_json TEXT NOT NULL DEFAULT '{}',last_synced_at TEXT,last_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS mail_gmail_transactions(state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,mailbox_id TEXT NOT NULL,user_email TEXT NOT NULL,verifier TEXT NOT NULL,auth_context TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER)`,
        `CREATE INDEX IF NOT EXISTS mail_gmail_transactions_expiry ON mail_gmail_transactions(expires_at)`,
        `CREATE TABLE IF NOT EXISTS mail_gmail_links(message_id TEXT PRIMARY KEY,mailbox_id TEXT NOT NULL,gmail_id TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(message_id) REFERENCES mail_messages(id) ON DELETE CASCADE)`,
        `CREATE INDEX IF NOT EXISTS mail_gmail_links_gmail ON mail_gmail_links(mailbox_id,gmail_id)`,
        `CREATE TABLE IF NOT EXISTS mail_gmail_observations(mailbox_id TEXT NOT NULL,gmail_id TEXT NOT NULL,rfc_id TEXT NOT NULL,recipients_json TEXT NOT NULL,is_spam INTEGER NOT NULL CHECK(is_spam IN(0,1)),updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(mailbox_id,gmail_id))`,
        `CREATE INDEX IF NOT EXISTS mail_gmail_observations_message ON mail_gmail_observations(mailbox_id,rfc_id)`,
        `CREATE INDEX IF NOT EXISTS mail_gmail_observations_expiry ON mail_gmail_observations(mailbox_id,expires_at)`,
        `CREATE INDEX IF NOT EXISTS mail_gmail_local_rfc ON mail_messages(mailbox_id,rfc_message_id)`,
      ].map(s => db.prepare(s)));
    })();
    schemaReady.set(db, running);
    running.catch(() => schemaReady.delete(db));
  }
  await running;
}
function client(env: Env, config: MailConfig) {
  return { id: env.GMAIL_CLIENT_ID || config.googleClientId || '', secret: env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '' };
}
function context(env: Env, config: MailConfig) {
  return JSON.stringify([config.appOrigin, config.mailbox.id, config.archiveAddress, client(env, config).id]);
}
function configured(env: Env, config: MailConfig): boolean {
  const c = client(env, config);
  return /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(c.id)
    && c.secret.length >= 16 && c.secret.length <= 256 && !/[\x00-\x20\x7f]/.test(c.secret)
    && /^[A-Za-z0-9_-]{43}$/.test(env.GMAIL_TOKEN_KEY || '');
}
function assertConfigured(env: Env, config: MailConfig) {
  if (config.mode !== 'production' || !config.gmailSync?.enabled || !configured(env, config)) {
    throw new AppError(503, 'GMAIL_NOT_CONFIGURED', 'Falta configurar la conexión con Gmail.');
  }
}
function assertIdentity(config: MailConfig, identity: Identity) {
  if (!identity.mailboxIds.includes(config.mailbox.id) || !config.allowedUsers.includes(identity.email)) {
    throw new AppError(403, 'FORBIDDEN', 'No tienes acceso a este buzón.');
  }
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
function opaque() { return b64(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value: string) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))); }
export async function encryptGmailToken(token: string, key: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, imported, enc.encode(token));
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}
export async function decryptGmailToken(value: string, key: string, aad: string): Promise<string> {
  const [iv, encrypted] = value.split('.');
  const imported = await crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, imported, unb64(encrypted)));
}
async function responseJson(response: Response): Promise<any> {
  if (!response.ok) throw new GmailFailure(response.status === 401 ? 'reconnect' : response.status === 429 ? 'rate_limit' : 'provider_error', response.status);
  if (!response.body) throw new GmailFailure('invalid_response');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new GmailFailure('response_limit'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GmailFailure('invalid_response'); }
}
async function tokenRequest(params: Record<string, string>) {
  const response = await fetch(TOKEN_URL, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  // Do not log Google's response: it may contain tokens or account information.
  if (response.status === 400 || response.status === 401) throw new GmailFailure('reconnect', response.status);
  return responseJson(response);
}
async function gmailGet(token: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return responseJson(await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}` } }));
}
function flowCookie(value: string, seconds: number) {
  return `${FLOW_COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
function flowValue(request: Request): string | undefined {
  const parts = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(FLOW_COOKIE + '='));
  if (parts.length !== 1) return;
  const value = parts[0].slice(FLOW_COOKIE.length + 1); return opaqueRE.test(value) ? value : undefined;
}
function finish(config: MailConfig, result: string) {
  return new Response(null, { status: 303, headers: { Location: `${config.appOrigin}/?settings=gmail&gmail=${result}`, 'Set-Cookie': flowCookie('', 0) } });
}
async function connection(env: Env, config: MailConfig) {
  return env.DB.prepare('SELECT * FROM mail_gmail_connections WHERE mailbox_id = ? AND auth_context = ?')
    .bind(config.mailbox.id, context(env, config)).first<Connection>();
}
export async function getGmailStatus(env: Env, config: MailConfig): Promise<GmailSyncStatus> {
  await ensureGmailSchema(env.DB);
  const row = await connection(env, config);
  const count = row ? await env.DB.prepare('SELECT COUNT(*) AS n FROM mail_gmail_links l JOIN mail_messages m ON m.id = l.message_id AND m.mailbox_id = l.mailbox_id WHERE l.mailbox_id = ? AND m.delete_state = \'active\'')
    .bind(config.mailbox.id).first<{ n: number }>() : null;
  const cursor = parseJson<Cursor>(row?.cursor_json, {});
  return { enabled: !!config.gmailSync?.enabled, configured: configured(env, config), connected: !!row,
    ...(row ? { email: row.email, ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}), ...(row.last_error ? { lastError: row.last_error } : {}) } : {}),
    matchedCount: count?.n ?? 0, scanning: !!row && cursor.phase !== 'history', callbackUrl: config.appOrigin + GMAIL_CALLBACK };
}

/** Match exact Message-ID plus institutional recipient. Subject/name are never keys.
 * Values stay case-sensitive because Message-ID local parts need not be equivalent.
 */
export function gmailMessageIdentity(metadata: GmailMetadata, config: MailConfig): { rfcId: string; recipients: string[] } | null {
  if (!idRE.test(metadata.id) || (metadata.labelIds !== undefined && !Array.isArray(metadata.labelIds))) return null;
  const headers = metadata.payload?.headers ?? [];
  const ids = headers.filter(h => h.name.toLowerCase() === 'message-id');
  if (ids.length !== 1 || typeof ids[0].value !== 'string') return null;
  const raw = ids[0].value.trim();
  if (!/^<[^<>\s\x00-\x20\x7f]{1,990}@[^<>\s\x00-\x20\x7f]+>$/.test(raw)) return null;
  const allowed = new Set(mailIdentities(config).map(a => a.email.toLowerCase()));
  const recipients = new Set<string>();
  for (const header of headers) {
    if (!['to', 'cc', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'x-gm-original-to'].includes(header.name.toLowerCase()) || header.value.length > 8192) continue;
    for (const address of addressParser(header.value, { flatten: true })) {
      if ('address' in address && address.address && allowed.has(address.address.toLowerCase())) recipients.add(address.address.toLowerCase());
    }
  }
  return recipients.size ? { rfcId: raw, recipients: [...recipients] } : null;
}

export async function applyCachedGmailVerdict(env: Env, config: MailConfig, messageId: string, fence?: string): Promise<boolean> {
  if (!config.gmailSync?.enabled) return false;
  await ensureGmailSchema(env.DB);
  const row = await env.DB.prepare(`SELECT m.rfc_message_id, a.address FROM mail_messages m JOIN mail_message_identities a ON a.message_id=m.id
    WHERE m.id=? AND m.mailbox_id=? AND m.direction='incoming' AND m.delete_state='active'`)
    .bind(messageId, config.mailbox.id).first<{ rfc_message_id: string | null; address: string }>();
  if (!row?.rfc_message_id) return false;
  const rfcId = row.rfc_message_id.startsWith('<') ? row.rfc_message_id : `<${row.rfc_message_id}>`;
  const observations = await env.DB.prepare('SELECT gmail_id, recipients_json, is_spam FROM mail_gmail_observations WHERE mailbox_id=? AND rfc_id=? AND expires_at>?')
    .bind(config.mailbox.id, rfcId, nowIso()).all<{ gmail_id: string; recipients_json: string; is_spam: number }>();
  const matches = observations.results.filter(o => parseJson<string[]>(o.recipients_json, []).includes(row.address.toLowerCase()));
  if (matches.length !== 1) return false;
  const match = matches[0];
  const guard = 'EXISTS(SELECT 1 FROM mail_gmail_connections WHERE mailbox_id=? AND auth_context=?' + (fence ? ' AND lease_id=?' : '') + ')';
  const args = [config.mailbox.id, context(env, config), ...(fence ? [fence] : [])];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO mail_gmail_links(message_id,mailbox_id,gmail_id,updated_at) SELECT ?,?,?,? WHERE ${guard}
      ON CONFLICT(message_id) DO UPDATE SET gmail_id=excluded.gmail_id,updated_at=excluded.updated_at WHERE mail_gmail_links.mailbox_id=excluded.mailbox_id`)
      .bind(messageId, config.mailbox.id, match.gmail_id, nowIso(), ...args),
    env.DB.prepare(`INSERT INTO mail_message_spam(message_id,mailbox_id,is_spam,reason,source,updated_at)
      SELECT ?,?,?,?,'gmail',? WHERE ${guard}
      ON CONFLICT(message_id) DO UPDATE SET is_spam=excluded.is_spam,reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at
      WHERE mail_message_spam.mailbox_id=excluded.mailbox_id AND mail_message_spam.source NOT IN('manual','rule','blocked_sender')`)
      .bind(messageId, config.mailbox.id, match.is_spam, match.is_spam ? 'Gmail clasificó esta copia como spam.' : 'Gmail no tiene esta copia en Spam.', nowIso(), ...args),
  ]);
  return true;
}
async function observe(env: Env, config: MailConfig, metadata: GmailMetadata, fence: string) {
  const target = gmailMessageIdentity(metadata, config); if (!target) return;
  const expiration = new Date(Date.now() + config.retentionDays * 86400000).toISOString();
  await env.DB.prepare(`INSERT INTO mail_gmail_observations(mailbox_id,gmail_id,rfc_id,recipients_json,is_spam,updated_at,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_gmail_connections WHERE mailbox_id=? AND auth_context=? AND lease_id=?)
    ON CONFLICT(mailbox_id,gmail_id) DO UPDATE SET rfc_id=excluded.rfc_id,recipients_json=excluded.recipients_json,is_spam=excluded.is_spam,updated_at=excluded.updated_at,expires_at=excluded.expires_at`)
    .bind(config.mailbox.id, metadata.id, target.rfcId, JSON.stringify(target.recipients), metadata.labelIds?.includes('SPAM') ? 1 : 0, nowIso(), expiration,
      config.mailbox.id, context(env, config), fence).run();
}
async function reconcileObservations(env: Env, config: MailConfig, fence: string) {
  // Bound D1 calls independently from aliases and Gmail bulk-label operations.
  const rows = await env.DB.prepare(`SELECT m.id,o.gmail_id,o.is_spam,o.updated_at FROM mail_messages m
    JOIN mail_message_identities a ON a.message_id=m.id
    JOIN mail_gmail_observations o ON o.mailbox_id=m.mailbox_id AND (o.rfc_id=m.rfc_message_id OR trim(o.rfc_id,'<>')=m.rfc_message_id)
    LEFT JOIN mail_gmail_links l ON l.message_id=m.id AND l.mailbox_id=m.mailbox_id
    WHERE m.mailbox_id=? AND m.direction='incoming' AND m.delete_state='active' AND o.expires_at>?
    AND EXISTS(SELECT 1 FROM json_each(o.recipients_json) WHERE value=lower(a.address))
    AND (SELECT COUNT(*) FROM mail_gmail_observations x WHERE x.mailbox_id=m.mailbox_id AND x.rfc_id=o.rfc_id AND x.expires_at>? AND EXISTS(SELECT 1 FROM json_each(x.recipients_json) WHERE value=lower(a.address)))=1
    AND (l.message_id IS NULL OR l.gmail_id<>o.gmail_id OR l.updated_at<o.updated_at)
    ORDER BY o.updated_at,m.id LIMIT 10`)
    .bind(config.mailbox.id, nowIso(), nowIso()).all<{ id: string; gmail_id: string; is_spam: number; updated_at: string }>();
  const statements = rows.results.flatMap(row => [
    env.DB.prepare(`INSERT INTO mail_gmail_links(message_id,mailbox_id,gmail_id,updated_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_gmail_connections WHERE mailbox_id=? AND lease_id=?)
      ON CONFLICT(message_id) DO UPDATE SET gmail_id=excluded.gmail_id,updated_at=excluded.updated_at WHERE mail_gmail_links.mailbox_id=excluded.mailbox_id`)
      .bind(row.id, config.mailbox.id, row.gmail_id, row.updated_at, config.mailbox.id, fence),
    env.DB.prepare(`INSERT INTO mail_message_spam(message_id,mailbox_id,is_spam,reason,source,updated_at) SELECT ?,?,?,?,'gmail',? WHERE EXISTS(SELECT 1 FROM mail_gmail_connections WHERE mailbox_id=? AND lease_id=?)
      ON CONFLICT(message_id) DO UPDATE SET is_spam=excluded.is_spam,reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at
      WHERE mail_message_spam.mailbox_id=excluded.mailbox_id AND mail_message_spam.source NOT IN('manual','rule','blocked_sender')`)
      .bind(row.id, config.mailbox.id, row.is_spam, row.is_spam ? 'Gmail clasificó esta copia como spam.' : 'Gmail no tiene esta copia en Spam.', nowIso(), config.mailbox.id, fence),
  ]);
  if (statements.length) await env.DB.batch(statements);
}
async function metadataGet(token: string, id: string): Promise<GmailMetadata | null> {
  if (!idRE.test(id)) throw new GmailFailure('invalid_response');
  try {
    // format=metadata does not return the body or attachments. No q parameter:
    // Google disallows search q with gmail.metadata.
    return await gmailGet(token, 'messages/' + encodeURIComponent(id), { format: 'metadata', fields: 'id,labelIds,payload/headers' });
  } catch (error) {
    if (error instanceof GmailFailure && error.status === 404) return null; // Deleted Gmail messages never delete local copies.
    throw error;
  }
}
export async function syncGmail(env: Env, config: MailConfig): Promise<void> {
  if (!config.gmailSync?.enabled || !configured(env, config)) return;
  await ensureGmailSchema(env.DB);
  const at = Date.now(); const lease = opaque();
  const row = await env.DB.prepare(`UPDATE mail_gmail_connections SET lease_id=?,lease_until=?,last_attempt_at=? WHERE mailbox_id=? AND auth_context=? AND lease_until<? AND last_attempt_at<=? RETURNING *`)
    .bind(lease, at + 240000, at, config.mailbox.id, context(env, config), at, at - config.gmailSync.intervalMinutes * 60000).first<Connection>();
  if (!row) return;
  try {
    const c = client(env, config);
    const refresh = await decryptGmailToken(row.encrypted_refresh, env.GMAIL_TOKEN_KEY!, context(env, config));
    const tokens = await tokenRequest({ client_id: c.id, client_secret: c.secret, refresh_token: refresh, grant_type: 'refresh_token' });
    if (typeof tokens.access_token !== 'string') throw new GmailFailure('invalid_response');
    const token = tokens.access_token;
    const cursor = parseJson<Cursor>(row.cursor_json, {});
    if (!cursor.phase || (cursor.phase === 'history' && at - (cursor.fullAt || 0) > 86400000)) {
      const profile = await gmailGet(token, 'profile');
      if (profile.emailAddress?.toLowerCase() !== config.archiveAddress || !/^\d+$/.test(profile.historyId || '')) throw new GmailFailure('wrong_account');
      Object.assign(cursor, { phase: 'spam', baseline: profile.historyId, page: undefined, pending: undefined, fullAt: at });
    }
    if (cursor.phase === 'spam') {
      const page = await gmailGet(token, 'messages', { labelIds: 'SPAM', includeSpamTrash: 'true', maxResults: String(PAGE_SIZE), ...(cursor.page ? { pageToken: cursor.page } : {}) });
      if (page.messages !== undefined && !Array.isArray(page.messages)) throw new GmailFailure('invalid_response');
      for (const message of page.messages ?? []) {
        const metadata = await metadataGet(token, message.id); if (metadata) await observe(env, config, metadata, lease);
      }
      if (page.nextPageToken) cursor.page = page.nextPageToken;
      else { cursor.phase = 'links'; delete cursor.page; delete cursor.linkAfter; }
    } else if (cursor.phase === 'links') {
      const links = await env.DB.prepare('SELECT DISTINCT gmail_id FROM mail_gmail_links WHERE mailbox_id=? AND gmail_id>? ORDER BY gmail_id LIMIT ?')
        .bind(config.mailbox.id, cursor.linkAfter || '', PAGE_SIZE).all<{ gmail_id: string }>();
      for (const link of links.results) {
        const metadata = await metadataGet(token, link.gmail_id); if (metadata) await observe(env, config, metadata, lease);
      }
      if (links.results.length === PAGE_SIZE) cursor.linkAfter = links.results.at(-1)!.gmail_id;
      else { cursor.phase = 'history'; cursor.historyId = cursor.baseline; delete cursor.linkAfter; }
    } else {
      if (!cursor.pending?.length) {
        let history;
        try { history = await gmailGet(token, 'history', { startHistoryId: cursor.historyId!, maxResults: '20', ...(cursor.page ? { pageToken: cursor.page } : {}) }); }
        catch (error) {
          if (error instanceof GmailFailure && error.status === 404) {
            await env.DB.prepare('UPDATE mail_gmail_connections SET cursor_json=\'{}\',lease_until=0,lease_id=NULL,last_error=\'history_reset\' WHERE mailbox_id=? AND lease_id=?')
              .bind(config.mailbox.id, lease).run(); return;
          }
          throw error;
        }
        const ids = new Set<string>();
        for (const item of history.history ?? []) for (const message of item.messages ?? []) if (idRE.test(message.id)) ids.add(message.id);
        cursor.pending = [...ids]; cursor.nextPage = history.nextPageToken; cursor.nextHistory = history.historyId;
      }
      const batch = cursor.pending!.slice(0, PAGE_SIZE);
      for (const id of batch) { const metadata = await metadataGet(token, id); if (metadata) await observe(env, config, metadata, lease); }
      cursor.pending = cursor.pending!.slice(batch.length);
      if (!cursor.pending.length) {
        if (cursor.nextPage) cursor.page = cursor.nextPage;
        else { cursor.historyId = cursor.nextHistory || cursor.historyId; delete cursor.page; }
        delete cursor.pending; delete cursor.nextPage; delete cursor.nextHistory;
      }
    }
    await reconcileObservations(env, config, lease);
    // Commit the cursor only when every message in this bounded batch succeeded.
    await env.DB.prepare(`UPDATE mail_gmail_connections SET cursor_json=?,last_synced_at=?,last_error=NULL,lease_id=NULL,lease_until=0 WHERE mailbox_id=? AND lease_id=?`)
      .bind(JSON.stringify(cursor), nowIso(), config.mailbox.id, lease).run();
    await env.DB.prepare('DELETE FROM mail_gmail_observations WHERE mailbox_id=? AND expires_at<=?').bind(config.mailbox.id, nowIso()).run();
    await env.DB.prepare('DELETE FROM mail_gmail_transactions WHERE expires_at<?').bind(Date.now()).run();
  } catch (error) {
    const code = error instanceof GmailFailure ? error.code : 'sync_failed';
    await env.DB.prepare('UPDATE mail_gmail_connections SET last_error=?,lease_id=NULL,lease_until=0 WHERE mailbox_id=? AND lease_id=?')
      .bind(code, config.mailbox.id, lease).run();
  }
}

export async function handleGmail(request: Request, env: Env, config: MailConfig, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url); if (!url.pathname.startsWith('/api/gmail/')) return null;
  assertIdentity(config, identity);
  await ensureGmailSchema(env.DB);
  if (url.pathname === '/api/gmail/status' && request.method === 'GET') return json(await getGmailStatus(env, config));
  if (url.pathname === '/api/gmail/connection' && request.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mail_gmail_connections WHERE mailbox_id=?').bind(config.mailbox.id),
      env.DB.prepare('DELETE FROM mail_gmail_links WHERE mailbox_id=?').bind(config.mailbox.id),
      env.DB.prepare('DELETE FROM mail_gmail_observations WHERE mailbox_id=?').bind(config.mailbox.id),
      env.DB.prepare('DELETE FROM mail_gmail_transactions WHERE mailbox_id=?').bind(config.mailbox.id),
    ]);
    return new Response(null, { status: 204 });
  }
  assertConfigured(env, config);
  if (url.pathname === '/api/gmail/sync' && request.method === 'POST') { await syncGmail(env, config); return json(await getGmailStatus(env, config)); }
  if (url.pathname === '/api/gmail/connect' && request.method === 'POST') {
    const state = opaque(); const browser = opaque(); const verifier = opaque(); const at = Date.now();
    await env.DB.prepare('DELETE FROM mail_gmail_transactions WHERE expires_at<?').bind(at).run();
    const inserted = await env.DB.prepare(`INSERT INTO mail_gmail_transactions(state_hash,browser_hash,mailbox_id,user_email,verifier,auth_context,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mail_gmail_transactions WHERE mailbox_id=? AND expires_at>?)<5`)
      .bind(await digest(state), await digest(browser), config.mailbox.id, identity.email, verifier, context(env, config), at + 600000, config.mailbox.id, at).run();
    if (!inserted.meta.changes) throw new AppError(429, 'GMAIL_RATE_LIMIT', 'Espera unos minutos antes de volver a conectar.');
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({ client_id: client(env, config).id, redirect_uri: config.appOrigin + GMAIL_CALLBACK,
      response_type: 'code', scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent select_account', state,
      login_hint: config.archiveAddress, code_challenge: await digest(verifier), code_challenge_method: 'S256' }).toString();
    const response = json({ url: authorization.href }); response.headers.append('Set-Cookie', flowCookie(browser, 600)); return response;
  }
  if (url.pathname === GMAIL_CALLBACK && request.method === 'GET') {
    try {
      const state = url.searchParams.get('state'); const browser = flowValue(request);
      if (!state || !opaqueRE.test(state) || !browser || url.searchParams.getAll('state').length !== 1) return finish(config, 'failed');
      const transaction = await env.DB.prepare(`UPDATE mail_gmail_transactions SET consumed_at=? WHERE state_hash=? AND browser_hash=? AND mailbox_id=? AND user_email=? AND auth_context=? AND consumed_at IS NULL AND expires_at>? RETURNING verifier`)
        .bind(Date.now(), await digest(state), await digest(browser), config.mailbox.id, identity.email, context(env, config), Date.now()).first<{ verifier: string }>();
      if (!transaction) return finish(config, 'failed');
      if (url.searchParams.has('error')) return finish(config, 'denied');
      const code = url.searchParams.get('code'); if (!code || code.length > 8192 || url.searchParams.getAll('code').length !== 1) return finish(config, 'failed');
      const c = client(env, config);
      const tokens = await tokenRequest({ code, client_id: c.id, client_secret: c.secret, redirect_uri: config.appOrigin + GMAIL_CALLBACK,
        grant_type: 'authorization_code', code_verifier: transaction.verifier });
      if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length < 16 || tokens.refresh_token.length > 8192
        || typeof tokens.scope !== 'string' || !tokens.scope.split(' ').includes(GMAIL_SCOPE)) return finish(config, 'failed');
      const profile = await gmailGet(tokens.access_token, 'profile');
      if (profile.emailAddress?.toLowerCase() !== config.archiveAddress) return finish(config, 'wrong_account');
      const encrypted = await encryptGmailToken(tokens.refresh_token, env.GMAIL_TOKEN_KEY!, context(env, config));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM mail_gmail_links WHERE mailbox_id=?').bind(config.mailbox.id),
        env.DB.prepare('DELETE FROM mail_gmail_observations WHERE mailbox_id=?').bind(config.mailbox.id),
        env.DB.prepare(`INSERT INTO mail_gmail_connections(mailbox_id,email,auth_context,encrypted_refresh) VALUES(?,?,?,?)
          ON CONFLICT(mailbox_id) DO UPDATE SET email=excluded.email,auth_context=excluded.auth_context,encrypted_refresh=excluded.encrypted_refresh,cursor_json='{}',last_synced_at=NULL,last_error=NULL,lease_id=NULL,lease_until=0,last_attempt_at=0`)
          .bind(config.mailbox.id, config.archiveAddress, context(env, config), encrypted),
      ]);
      return finish(config, 'connected');
    } catch { return finish(config, 'failed'); }
  }
  throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
}
