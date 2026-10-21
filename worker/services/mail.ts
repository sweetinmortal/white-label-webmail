import type { D1Database } from '@cloudflare/workers-types';
import { addressParser, decodeWords } from 'postal-mime';
import type { Address, AttachmentInfo, Folder, MessageDetail, MessagePage, MessageSummary, OutgoingAttachment, SendInput, SendResult, SendStatus, ArchiveStatus } from '../../shared/contracts';
import { base64ByteLength, isMimeType, normalizeBase64, sanitizeAttachmentFilename } from '../../shared/attachments';
import { parseEmailContent } from '../../shared/email-content';
import { AppError } from '../errors';
import { mailIdentities } from '../config';
import type { Env, Identity, IncomingEmail, MailConfig } from '../types';
import { localProvider } from '../providers/local';
import { mailjetProvider } from '../providers/mailjet';
import type { OutboundMessage, OutboundProvider, OutboundRecipient, ProviderResult } from '../providers/types';
import { addDaysIso, ensureSchema, json, nowIso, parseJson } from '../store/schema';
import { deleteObject, getObject, getStorageUsage, pauseStorage, putJson, putStream, releaseStorage, reserveStorage } from '../store/storage';
import { releaseRecipients, reserveRecipients } from '../store/quota';
import { addTombstone, claimOutbox, findIdempotency, insertOutbox, setOutboxStatus, updateRecipientResults } from '../store/outbox';
import { getMailStore } from '../store/objects';
import { archiveMessageId, archiveReferences, assertArchiveLinkKey, openArchiveReply, sealArchiveReply } from './archive-links';
import { archiveCopyContent, readArchiveOriginal } from './archive-copy';

const MAX_CURSOR_BYTES = 512;
const MAX_PAGE = 30;
const MAX_IDEMPOTENCY_KEY = 256;
const MAX_ADDRESS_HEADER = 8192;
const MAX_DECODED_HEADER = 4096;
const MAX_DISPLAY_NAME = 200;
const EMAIL_RE = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/;
const SAFE_HEADER_NAMES = new Set(['in-reply-to', 'references']);

interface MessageRow {
  id: string;
  mailbox_id: string;
  identity_address?: string | null;
  direction: 'incoming' | 'outgoing';
  from_email: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  subject: string;
  reply_to_json: string | null;
  rfc_message_id: string | null;
  references_json: string;
  body_text: string | null;
  raw_key: string | null;
  payload_key: string | null;
  size_bytes: number;
  created_at: string;
  received_at: string | null;
  sent_at: string | null;
  expires_at: string;
  receipt_id: string | null;
  archive_address: string | null;
  archive_status: ArchiveStatus;
  send_status: SendStatus | null;
  delete_state: string;
  is_read?: number;
  idempotency_key?: string | null;
  payload_hash?: string | null;
  outbox_status?: SendStatus | null;
}

interface Cursor { createdAt: string; id: string }

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertMailbox(identity: Identity, config: MailConfig): void {
  const email = normalizeEmail(identity.email);
  const allowed = config.allowedUsers.length === 0 || config.allowedUsers.map(normalizeEmail).includes(email);
  if (!identity.mailboxIds.includes(config.mailbox.id) || !allowed) {
    throw new AppError(403, 'mailbox_forbidden', 'No tienes acceso a este buzón.');
  }
}

function validateConfig(config: MailConfig): void {
  if (!config.mailbox?.id || !config.mailbox.address || !EMAIL_RE.test(normalizeEmail(config.mailbox.address))) {
    throw new AppError(500, 'mailbox_misconfigured', 'El buzón no está configurado correctamente.');
  }
  if (!config.archiveAddress || !EMAIL_RE.test(normalizeEmail(config.archiveAddress))) {
    throw new AppError(500, 'archive_misconfigured', 'La dirección de archivo no está configurada correctamente.');
  }
  if (!Number.isSafeInteger(config.retentionDays) || config.retentionDays < 1) {
    throw new AppError(500, 'retention_misconfigured', 'La retención no está configurada correctamente.');
  }
  if (!Number.isSafeInteger(config.storageBudgetBytes) || config.storageBudgetBytes < 0 ||
      !Number.isSafeInteger(config.maxMessageBytes) || config.maxMessageBytes < 0 ||
      !Number.isSafeInteger(config.maxComposeBytes) || config.maxComposeBytes < 1 ||
      !Number.isSafeInteger(config.maxAttachments) || config.maxAttachments < 1 ||
      !Number.isSafeInteger(config.maxAttachmentBytes) || config.maxAttachmentBytes < 1 ||
      !Number.isSafeInteger(config.dailyRecipientLimit) || config.dailyRecipientLimit < 1 ||
      !Number.isSafeInteger(config.monthlyRecipientLimit) || config.monthlyRecipientLimit < 1) {
    throw new AppError(500, 'limits_misconfigured', 'Los límites del buzón no están configurados correctamente.');
  }
  if ((config.mode === 'local') !== (config.provider === 'local')) {
    throw new AppError(500, 'provider_mode_mismatch', 'El proveedor no coincide con el modo del buzón.');
  }
}

function id(): string { return crypto.randomUUID(); }

function decodeHeaderValue(value: string, max = MAX_DECODED_HEADER): string {
  const bounded = value.replace(/[\r\n]/g, ' ').trim().slice(0, max);
  try {
    return decodeWords(bounded).replace(/[\r\n]/g, ' ').trim().slice(0, max);
  } catch {
    return bounded;
  }
}

function parseAddress(value: string): Address {
  const input = value.replace(/[\r\n]/g, ' ').trim().slice(0, MAX_ADDRESS_HEADER);
  try {
    const parsed = addressParser(decodeHeaderValue(input, MAX_ADDRESS_HEADER), { flatten: true });
    const mailbox = parsed.find((entry): entry is { address: string; name: string } =>
      typeof entry.address === 'string' && EMAIL_RE.test(entry.address),
    );
    if (mailbox) {
      const email = normalizeEmail(mailbox.address);
      const name = decodeHeaderValue(mailbox.name, MAX_DISPLAY_NAME)
        .replace(/^['"]|['"]$/g, '').slice(0, MAX_DISPLAY_NAME);
      return name ? { email, name } : { email };
    }
  } catch {
    // A malformed address header should never prevent us from retaining the
    // message; the envelope sender is selected by the caller as fallback.
  }
  const angle = input.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  const fallbackEmail = normalizeEmail(angle?.[2] ?? input.replace(/^.*?\s+/, ''));
  if (!EMAIL_RE.test(fallbackEmail)) return { email: input.slice(0, 320) };
  const fallbackName = decodeHeaderValue(angle?.[1] ?? '', MAX_DISPLAY_NAME)
    .replace(/^['"]|['"]$/g, '').slice(0, MAX_DISPLAY_NAME);
  return fallbackName ? { email: fallbackEmail, name: fallbackName } : { email: fallbackEmail };
}

function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const output: Address[] = [];
  for (const part of value.split(',')) {
    const address = parseAddress(part);
    if (EMAIL_RE.test(address.email) && !output.some((item) => item.email === address.email)) output.push(address);
  }
  return output;
}

function parseHeader(headers: Headers, name: string, max = 4096): string | undefined {
  const value = headers.get(name);
  if (!value) return undefined;
  return decodeHeaderValue(value, max);
}

function referencesFrom(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[^<>\r\n]{1,998}>/g)].map((match) => match[0]).slice(0, 50);
}

function encodeCursor(value: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  if (value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError(400, 'cursor_invalid', 'El cursor no es válido.');
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const decoded = atob(padded);
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder().decode(bytes)) as Cursor;
    if (!cursor || typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string' || cursor.id.length > 128) throw new Error('bad cursor');
    return cursor;
  } catch {
    throw new AppError(400, 'cursor_invalid', 'El cursor no es válido.');
  }
}

function parseLimit(value?: string): number {
  if (!value) return MAX_PAGE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new AppError(400, 'limit_invalid', 'El límite debe estar entre 1 y 30.');
  return limit;
}

function rowAddress(value: string | null | undefined, fallback = ''): Address {
  const parsed = parseJson<Address>(value, { email: fallback });
  return parsed && typeof parsed.email === 'string' ? parsed : { email: fallback };
}

function identityAddress(row: MessageRow, config: MailConfig): string {
  return row.identity_address || (row.direction === 'outgoing' ? row.from_email : config.mailbox.address);
}

function resolveSender(config: MailConfig, requested: unknown, suggested?: string): Address {
  if (requested !== undefined && (typeof requested !== 'string' || requested.length > 254)) throw new AppError(400, 'sender_invalid', 'La dirección remitente no es válida.');
  const identities = mailIdentities(config);
  const selected = requested === undefined ? identities.find(entry => entry.email === suggested)?.email ?? config.mailbox.address : normalizeEmail(requested as string);
  const address = identities.find(entry => normalizeEmail(entry.email) === selected);
  if (!address) throw new AppError(403, 'sender_forbidden', 'No puedes enviar desde esta dirección.');
  return { ...address, email: selected };
}

function rowToSummary(row: MessageRow, config: MailConfig, isRead = row.is_read === 1): MessageSummary {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    identityAddress: identityAddress(row, config),
    direction: row.direction,
    from: { email: row.from_email, ...(row.from_name ? { name: row.from_name } : {}) },
    to: parseJson<Address[]>(row.to_json, []),
    cc: parseJson<Address[]>(row.cc_json, []),
    subject: row.subject,
    createdAt: row.created_at,
    sizeBytes: Number(row.size_bytes || 0),
    isRead: row.direction === 'outgoing' ? true : isRead,
    archiveStatus: row.archive_status,
    ...(row.send_status ? { sendStatus: row.send_status } : {}),
  };
}

interface OutgoingSnapshot { bodyText?: string; attachments: AttachmentInfo[]; rawAttachments: OutgoingAttachment[] }

async function outgoingSnapshot(env: Env, config: MailConfig, row: MessageRow): Promise<OutgoingSnapshot | undefined> {
  if (row.direction !== 'outgoing') return undefined;
  // Rows created before snapshots were introduced may still have their body
  // in D1. Keep that nullable column readable, but never duplicate new text.
  if (!row.payload_key) {
    if (row.body_text != null) return { bodyText: row.body_text, attachments: [], rawAttachments: [] };
    throw new AppError(404, 'payload_not_available', 'El snapshot del envío ya no está disponible.');
  }
  let object: { body: unknown; text(): Promise<string> };
  try {
    object = await getObject(getMailStore(env, config), row.payload_key);
  } catch (error) {
    if (error instanceof AppError && error.code === 'raw_not_found') {
      throw new AppError(404, 'payload_not_available', 'El snapshot del envío ya no está disponible.');
    }
    throw error;
  }
  const payload = parseJson<{ text?: unknown; attachments?: unknown } | null>(await object.text(), null);
  if (!payload || typeof payload.text !== 'string') throw new AppError(500, 'payload_invalid', 'El snapshot del envío no es válido.');
  if (new TextEncoder().encode(payload.text).byteLength > config.maxComposeBytes) {
    throw new AppError(500, 'payload_invalid', 'El snapshot del envío supera el límite permitido.');
  }
  const rawAttachments: OutgoingAttachment[] = [];
  const attachments: AttachmentInfo[] = [];
  if (Array.isArray(payload.attachments) && payload.attachments.length <= config.maxAttachments) {
    for (const entry of payload.attachments) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.filename !== 'string' || typeof candidate.mimeType !== 'string' || typeof candidate.contentBase64 !== 'string') continue;
      const base64 = normalizeBase64(candidate.contentBase64);
      if (!base64 || !isMimeType(candidate.mimeType)) continue;
      const info = attachmentInfo({ filename: candidate.filename, mimeType: candidate.mimeType, contentBase64: base64 });
      if (!info) continue;
      rawAttachments.push({ filename: info.filename, mimeType: info.mimeType, contentBase64: base64 });
      attachments.push(info);
    }
  }
  return { bodyText: payload.text, attachments, rawAttachments };
}

function canonicalPayload(input: { from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; attachments: OutgoingAttachment[]; replyToMessageId?: string; archiveReplyToken?: string }): string {
  return JSON.stringify({
    from: normalizeEmail(input.from),
    to: input.to.map(normalizeEmail).sort(),
    cc: input.cc.map(normalizeEmail).sort(),
    bcc: input.bcc.map(normalizeEmail).sort(),
    subject: input.subject,
    text: input.text,
    attachments: input.attachments.map((attachment) => ({
      filename: sanitizeAttachmentFilename(attachment.filename),
      mimeType: attachment.mimeType.toLowerCase(),
      contentBase64: attachment.contentBase64,
    })),
    replyToMessageId: input.replyToMessageId ?? null,
    ...(input.archiveReplyToken ? { archiveReplyToken: input.archiveReplyToken } : {}),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getRow(db: D1Database, identity: Identity, config: MailConfig, messageId: string): Promise<MessageRow> {
  assertMailbox(identity, config);
  await ensureSchema(db);
  const row = await db.prepare(`SELECT m.*, CASE WHEN m.direction = 'outgoing' THEN 1 ELSE CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END END AS is_read, a.address AS identity_address FROM mail_messages m LEFT JOIN mail_read_states r ON r.message_id = m.id AND r.user_email = ? LEFT JOIN mail_message_identities a ON a.message_id = m.id WHERE m.id = ? AND m.mailbox_id = ? AND m.delete_state <> 'deleted'`)
    .bind(normalizeEmail(identity.email), messageId, config.mailbox.id).first<MessageRow>();
  if (!row) throw new AppError(404, 'message_not_found', 'El mensaje no existe en este buzón.');
  return row;
}

function replyHeaders(row: MessageRow): Record<string, string> {
  if (!row.rfc_message_id) return {};
  const references = parseJson<string[]>(row.references_json, []);
  const all = [...references, row.rfc_message_id].filter((value, index, values) => value && values.indexOf(value) === index).slice(-50);
  const output: Record<string, string> = { 'In-Reply-To': row.rfc_message_id };
  if (all.length) output.References = all.join(' ');
  return output;
}

function providerFor(config: MailConfig): OutboundProvider {
  if (config.provider === 'local') return localProvider;
  return mailjetProvider;
}

function validateAddressList(values: string[] | undefined, field: string): string[] {
  if (values !== undefined && !Array.isArray(values)) throw new AppError(400, `${field}_invalid`, 'La lista de destinatarios no es válida.');
  if ((values ?? []).some((value) => typeof value !== 'string')) throw new AppError(400, `${field}_invalid`, 'La lista de destinatarios no es válida.');
  const output = [...(values ?? [])].map((value) => normalizeEmail(value));
  if (output.some((value) => value.includes('\r') || value.includes('\n') || !EMAIL_RE.test(value))) throw new AppError(400, `${field}_invalid`, 'Una de las direcciones no es válida.');
  if (new Set(output).size !== output.length) throw new AppError(400, `${field}_duplicate`, 'No se permiten destinatarios repetidos.');
  return output;
}

interface NormalizedAttachment extends OutgoingAttachment { sizeBytes: number }

function normalizeAttachments(value: unknown, config: MailConfig): NormalizedAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > config.maxAttachments) {
    throw new AppError(400, 'attachment_limit', `Puedes adjuntar como máximo ${config.maxAttachments} archivos.`);
  }
  let total = 0;
  const output: NormalizedAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError(400, 'attachment_invalid', 'Uno de los adjuntos no es válido.');
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.filename !== 'string' || !candidate.filename.trim() || typeof candidate.mimeType !== 'string' || typeof candidate.contentBase64 !== 'string') {
      throw new AppError(400, 'attachment_invalid', 'Uno de los adjuntos no es válido.');
    }
    if (!isMimeType(candidate.mimeType)) throw new AppError(400, 'attachment_type', 'El tipo de uno de los adjuntos no es válido.');
    const contentBase64 = normalizeBase64(candidate.contentBase64);
    if (!contentBase64) throw new AppError(400, 'attachment_invalid', 'El contenido de uno de los adjuntos no es válido.');
    const sizeBytes = base64ByteLength(contentBase64);
    if (sizeBytes < 1) throw new AppError(400, 'attachment_empty', 'Uno de los adjuntos está vacío.');
    total += sizeBytes;
    if (total > config.maxAttachmentBytes) {
      throw new AppError(413, 'attachment_too_large', `Los adjuntos superan el límite de ${Math.round(config.maxAttachmentBytes / 1024 / 1024)} MB.`);
    }
    output.push({
      filename: sanitizeAttachmentFilename(candidate.filename),
      mimeType: candidate.mimeType.toLowerCase(),
      contentBase64,
      sizeBytes,
    });
  }
  return output;
}

function attachmentInfo(attachment: OutgoingAttachment): AttachmentInfo | null {
  const base64 = normalizeBase64(attachment.contentBase64);
  if (!base64 || !isMimeType(attachment.mimeType)) return null;
  return {
    filename: sanitizeAttachmentFilename(attachment.filename),
    mimeType: attachment.mimeType,
    sizeBytes: base64ByteLength(base64),
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function attachmentFilenameHeader(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function recipientRows(to: string[], cc: string[], bcc: string[]): OutboundRecipient[] {
  return [
    ...to.map((email) => ({ email, kind: 'to' as const })),
    ...cc.map((email) => ({ email, kind: 'cc' as const })),
    ...bcc.map((email) => ({ email, kind: 'bcc' as const })),
  ];
}

function providerResultStatus(result: ProviderResult): SendStatus {
  if (result.outcome === 'accepted') return 'accepted';
  if (result.outcome === 'definite_failure') return 'failed';
  return 'unknown';
}

async function persistProviderResult(db: D1Database, messageId: string, result: ProviderResult): Promise<void> {
  await updateRecipientResults(db, messageId, result.recipients.map((recipient) => ({
    email: recipient.email,
    kind: recipient.kind,
    providerId: recipient.providerId,
    providerUuid: recipient.providerUuid,
    status: recipient.status,
  })));
  await setOutboxStatus(db, messageId, providerResultStatus(result), result.code);
}

export async function listMessages(env: Env, config: MailConfig, identity: Identity, folder: Folder, cursor?: string, unreadOnly = false, address?: string): Promise<MessagePage> {
  validateConfig(config);
  assertMailbox(identity, config);
  if (folder !== 'inbox' && folder !== 'sent') throw new AppError(400, 'folder_invalid', 'La carpeta solicitada no es válida.');
  await ensureSchema(env.DB);
  const direction = folder === 'inbox' ? 'incoming' : 'outgoing';
  const decoded = decodeCursor(cursor);
  const limit = MAX_PAGE;
  const conditions = ['m.mailbox_id = ?', 'm.direction = ?', "m.delete_state = 'active'"];
  const values: unknown[] = [config.mailbox.id, direction];
  if (address !== undefined) {
    const selected = resolveSender(config, address);
    conditions.push("COALESCE(a.address, CASE WHEN m.direction = 'outgoing' THEN m.from_email ELSE ? END) = ?");
    values.push(config.mailbox.address, selected.email);
  }
  if (unreadOnly) { conditions.push('r.message_id IS NULL'); }
  if (decoded) {
    conditions.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
    values.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }
  const query = `SELECT m.*, CASE WHEN m.direction = 'outgoing' THEN 1 ELSE CASE WHEN r.message_id IS NULL THEN 0 ELSE 1 END END AS is_read, a.address AS identity_address FROM mail_messages m LEFT JOIN mail_read_states r ON r.message_id = m.id AND r.user_email = ? LEFT JOIN mail_message_identities a ON a.message_id = m.id WHERE ${conditions.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`;
  const result = await env.DB.prepare(query).bind(normalizeEmail(identity.email), ...values, limit + 1).all<MessageRow>();
  const rows = result.results ?? [];
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return { items: pageRows.map((row) => rowToSummary(row, config)), nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null };
}

export async function getMessage(env: Env, config: MailConfig, identity: Identity, messageId: string): Promise<MessageDetail> {
  const row = await getRow(env.DB, identity, config, messageId);
  const snapshot = await outgoingSnapshot(env, config, row);
  return {
    ...rowToSummary(row, config),
    ...(row.reply_to_json ? { replyTo: rowAddress(row.reply_to_json) } : {}),
    ...(snapshot?.attachments.length ? { attachments: snapshot.attachments } : {}),
    ...(row.rfc_message_id ? { rfcMessageId: row.rfc_message_id } : {}),
    references: parseJson<string[]>(row.references_json, []),
    expiresAt: row.expires_at,
    rawAvailable: Boolean(row.raw_key || row.payload_key),
    ...(snapshot?.bodyText !== undefined ? { bodyText: snapshot.bodyText } : {}),
  };
}

export async function getOutgoingAttachment(env: Env, config: MailConfig, identity: Identity, messageId: string, indexValue: number): Promise<Response> {
  const row = await getRow(env.DB, identity, config, messageId);
  if (row.direction !== 'outgoing') throw new AppError(404, 'attachment_not_found', 'El adjunto no está disponible.');
  if (!row.payload_key) throw new AppError(404, 'payload_not_available', 'El snapshot del envío ya no está disponible.');
  const index = Number(indexValue);
  if (!Number.isSafeInteger(index) || index < 0 || index > config.maxAttachments - 1) throw new AppError(404, 'attachment_not_found', 'El adjunto no está disponible.');
  const object = await getObject(getMailStore(env, config), row.payload_key);
  const payload = parseJson<{ attachments?: unknown } | null>(await object.text(), null);
  if (!payload || !Array.isArray(payload.attachments)) throw new AppError(404, 'attachment_not_found', 'El adjunto no está disponible.');
  const entry = payload.attachments[index];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new AppError(404, 'attachment_not_found', 'El adjunto no está disponible.');
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.filename !== 'string' || typeof candidate.mimeType !== 'string' || typeof candidate.contentBase64 !== 'string') {
    throw new AppError(404, 'attachment_not_found', 'El adjunto no está disponible.');
  }
  const base64 = normalizeBase64(candidate.contentBase64);
  if (!base64 || !isMimeType(candidate.mimeType)) throw new AppError(404, 'attachment_not_found', 'El adjunto no está disponible.');
  const filename = sanitizeAttachmentFilename(candidate.filename);
  const bytes = decodeBase64(base64);
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { headers: {
    'Content-Type': candidate.mimeType,
    'Content-Disposition': attachmentFilenameHeader(filename),
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
  } });
}

export async function getRaw(env: Env, config: MailConfig, identity: Identity, messageId: string): Promise<Response> {
  const row = await getRow(env.DB, identity, config, messageId);
  if (row.direction === 'incoming') {
    if (!row.raw_key) throw new AppError(404, 'raw_not_available', 'El original ya no está disponible.');
    const object = await getObject(getMailStore(env, config), row.raw_key);
    return new Response(object.body as BodyInit, { headers: { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${messageId}.eml"`, 'Cache-Control': 'no-store' } });
  }
  if (!row.payload_key) throw new AppError(404, 'payload_not_available', 'El snapshot del envío ya no está disponible.');
  const object = await getObject(getMailStore(env, config), row.payload_key);
  const payload = parseJson<Record<string, unknown>>(await object.text(), {});
  delete payload.bcc;
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${messageId}.json"`, 'Cache-Control': 'no-store' } });
}

export async function setRead(env: Env, config: MailConfig, identity: Identity, messageId: string, read: boolean): Promise<void> {
  const row = await getRow(env.DB, identity, config, messageId);
  if (row.direction !== 'incoming') return;
  await ensureSchema(env.DB);
  if (read) {
    await env.DB.prepare(`INSERT OR REPLACE INTO mail_read_states (message_id, user_email, read_at) VALUES (?, ?, ?)`).bind(messageId, normalizeEmail(identity.email), nowIso()).run();
  } else {
    await env.DB.prepare(`DELETE FROM mail_read_states WHERE message_id = ? AND user_email = ?`).bind(messageId, normalizeEmail(identity.email)).run();
  }
}

export async function sendMessage(env: Env, config: MailConfig, identity: Identity, input: SendInput, idempotencyKey: string): Promise<SendResult> {
  validateConfig(config);
  assertMailbox(identity, config);
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY || /[\r\n]/.test(idempotencyKey)) throw new AppError(400, 'idempotency_invalid', 'La clave de idempotencia no es válida.');
  if (config.mode === 'production' && config.provider === 'mailjet' && (!env.MAILJET_API_KEY || !env.MAILJET_API_SECRET)) throw new AppError(503, 'provider_not_configured', 'El proveedor de correo no está configurado.');
  if (config.archiveCopies?.enabled) assertArchiveLinkKey(env, config);
  if (!input || typeof input !== 'object' || typeof input.subject !== 'string' || typeof input.text !== 'string') throw new AppError(400, 'message_invalid', 'El mensaje no es válido.');
  if (input.subject.length > 255 || /[\r\n]/.test(input.subject)) throw new AppError(400, 'subject_invalid', 'El asunto no es válido.');
  if (input.archiveReplyToken !== undefined && (typeof input.archiveReplyToken !== 'string' || input.archiveReplyToken.length > 8192 || input.replyToMessageId)) throw new AppError(400, 'reply_invalid', 'El enlace de respuesta no es válido.');
  await ensureSchema(env.DB);
  const to = validateAddressList(input.to, 'to');
  const cc = validateAddressList(input.cc, 'cc');
  const bcc = validateAddressList(input.bcc, 'bcc');
  const all = new Set([...to, ...cc, ...bcc]);
  const archive = normalizeEmail(config.archiveAddress);
  if (!all.has(archive)) bcc.push(archive);
  const recipients = recipientRows(to, cc, bcc);
  if (!recipients.length || recipients.length > 10) throw new AppError(400, 'recipient_limit', 'El mensaje debe tener entre 1 y 10 destinatarios.');
  if (to.some((email) => cc.includes(email) || bcc.includes(email)) || cc.some((email) => bcc.includes(email))) throw new AppError(400, 'recipient_duplicate', 'No se permiten destinatarios repetidos.');
  const attachments = normalizeAttachments(input.attachments, config);
  const composeBytes = new TextEncoder().encode(JSON.stringify({ to, cc, bcc, subject: input.subject, text: input.text })).byteLength;
  if (composeBytes > config.maxComposeBytes) throw new AppError(413, 'compose_too_large', 'El mensaje supera el tamaño permitido.');
  const attachmentPayloadBytes = attachments.reduce((total, attachment) => total + attachment.contentBase64.length, 0);
  if (composeBytes + attachmentPayloadBytes + 8192 > config.maxComposeBytes + config.maxAttachmentBytes * 2) {
    throw new AppError(413, 'compose_too_large', 'El mensaje con adjuntos supera el tamaño permitido.');
  }

  let original: MessageRow | undefined;
  if (input.replyToMessageId) {
    try { original = await getRow(env.DB, identity, config, input.replyToMessageId); }
    catch (error) { if (!(error instanceof AppError && error.status === 404)) throw error; }
    if (!original || original.delete_state !== 'active') throw new AppError(404, 'reply_target_not_found', 'El mensaje original no existe en este buzón.');
    if (!original.rfc_message_id && original.direction === 'incoming') throw new AppError(409, 'reply_target_unthreadable', 'El mensaje original no tiene identificador de conversación.');
  }
  const archivedReply = input.archiveReplyToken ? await openArchiveReply(env, config, input.archiveReplyToken) : undefined;
  const address = resolveSender(config, input.from, original ? identityAddress(original, config) : archivedReply?.from);
  const headers: Record<string, string> = original ? replyHeaders(original) : archivedReply?.inReplyTo ? {
    'In-Reply-To': archivedReply.inReplyTo,
    References: archiveReferences([...archivedReply.references, archivedReply.inReplyTo]).join(' '),
  } : {};
  const canonical = canonicalPayload({ from: address.email, to, cc, bcc, subject: input.subject, text: input.text, attachments, replyToMessageId: input.replyToMessageId, archiveReplyToken: input.archiveReplyToken });
  const payloadHash = await sha256(canonical);
  const existing = await findIdempotency(env.DB, config.mailbox.id, idempotencyKey);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new AppError(409, 'idempotency_mismatch', 'La clave de idempotencia se usó con otro mensaje.');
    return { id: existing.id, status: existing.status, reused: true };
  }
  const archiveReplyToken = config.archiveCopies?.enabled ? await sealArchiveReply(env, config, {
    direction: 'outgoing', from: address.email, to, cc,
    subject: input.subject.slice(0, 251), inReplyTo: archiveMessageId(headers['In-Reply-To']),
    references: archiveReferences(referencesFrom(headers.References)),
  }) : undefined;
  const count = recipients.length;
  if (!await reserveRecipients(env.DB, config.mailbox.id, count, config.dailyRecipientLimit, config.monthlyRecipientLimit)) throw new AppError(429, 'recipient_quota', 'Se alcanzó la cuota de destinatarios.');

  const messageId = id();
  const at = nowIso();
  const expiresAt = addDaysIso(config.retentionDays);
  const payloadKey = `outgoing/${config.mailbox.id}/${at.slice(0, 10)}/${messageId}.json`;
  const payloadAttachments = attachments.map(({ filename, mimeType, contentBase64 }) => ({ filename, mimeType, contentBase64 }));
  const payload = { id: messageId, from: address, to, cc, bcc, subject: input.subject, text: input.text, attachments: payloadAttachments, headers, customId: messageId, createdAt: at, ...(archiveReplyToken ? { archiveReplyToken } : {}) };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  let storageReserved = false;
  try { storageReserved = await reserveStorage(env.DB, config.mailbox.id, payloadBytes, config.storageBudgetBytes); }
  catch {
    try { await releaseRecipients(env.DB, config.mailbox.id, count); } catch { /* preserve the primary storage error */ }
    throw new AppError(503, 'storage_unavailable', 'No se pudo reservar espacio para el envío.');
  }
  if (!storageReserved) {
    await releaseRecipients(env.DB, config.mailbox.id, count);
    try { await pauseStorage(env.DB, config.mailbox.id, config.storageBudgetBytes); } catch { /* best-effort operational marker */ }
    throw new AppError(507, 'storage_quota', 'La caché temporal alcanzó su capacidad.');
  }
  const messageSql = env.DB.prepare(`INSERT INTO mail_messages (id, mailbox_id, direction, from_email, from_name, to_json, cc_json, subject, reply_to_json, rfc_message_id, references_json, body_text, payload_key, size_bytes, created_at, sent_at, expires_at, archive_address, archive_status, send_status) VALUES (?, ?, 'outgoing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`)
    // Mailjet assigns the final transport Message-ID.  Never invent or send
    // one here; only preserve RFC identifiers received from the original.
    .bind(messageId, config.mailbox.id, address.email, address.name ?? '', json(to.map((email) => ({ email }))), json(cc.map((email) => ({ email }))), input.subject, original ? original.reply_to_json ?? json({ email: original.from_email, name: original.from_name }) : null, null, json(original ? [...parseJson<string[]>(original.references_json, []), original.rfc_message_id].filter(Boolean) : archivedReply ? archiveReferences([...archivedReply.references, archivedReply.inReplyTo || '']) : []), null, payloadKey, payloadBytes, at, at, expiresAt, archive);
  const recipientSql = recipients.map((recipient) => env.DB.prepare(`INSERT INTO mail_outbox_recipients (outbox_id, email, kind, updated_at) VALUES (?, ?, ?, ?)`).bind(messageId, recipient.email, recipient.kind, at));
  try {
    await insertOutbox(env.DB, { id: messageId, mailboxId: config.mailbox.id, key: idempotencyKey, hash: payloadHash, payloadKey, provider: config.provider, correlationId: messageId, messageSql, recipientStatements: recipientSql });
  } catch (error) {
    await releaseStorage(env.DB, config.mailbox.id, payloadBytes);
    await releaseRecipients(env.DB, config.mailbox.id, count);
    if (error instanceof AppError && error.code === 'idempotency_conflict') {
      const raced = await findIdempotency(env.DB, config.mailbox.id, idempotencyKey);
      if (raced?.payload_hash === payloadHash) return { id: raced.id, status: raced.status, reused: true };
      throw new AppError(409, 'idempotency_mismatch', 'La clave de idempotencia se usó con otro mensaje.');
    }
    throw error;
  }
  try {
    await putJson(getMailStore(env, config), payloadKey, payload);
  } catch {
    try {
      await setOutboxStatus(env.DB, messageId, 'failed', 'payload_store_failed');
      await env.DB.prepare(`UPDATE mail_messages SET payload_key = NULL, size_bytes = 0 WHERE id = ?`).bind(messageId).run();
    } catch { /* retain the pending/failed row for operator reconciliation */ }
    try { await releaseStorage(env.DB, config.mailbox.id, payloadBytes, true); } catch { /* the failed row remains auditable */ }
    throw new AppError(503, 'payload_store_failed', 'No se pudo conservar el envío para procesarlo.');
  }
  if (!await claimOutbox(env.DB, messageId)) {
    const raced = await findIdempotency(env.DB, config.mailbox.id, idempotencyKey);
    return { id: messageId, status: raced?.status ?? 'unknown', reused: true };
  }
  const outbound: OutboundMessage = { id: messageId, from: address, to: recipients, subject: input.subject, text: input.text, attachments: payloadAttachments, headers: Object.fromEntries(Object.entries(headers).filter(([name]) => SAFE_HEADER_NAMES.has(name.toLowerCase()))), customId: messageId, archiveAddress: archive, archiveReplyToken };
  let result: ProviderResult;
  try {
    result = await providerFor(config).send(env, config, outbound);
  } catch {
    // A thrown provider error after the conditional claim is ambiguous. Keep
    // the immutable payload and expose unknown so a later operator can decide
    // whether to reconcile it; never issue a blind second send here.
    result = { outcome: 'unknown', recipients: recipients.map((recipient) => ({ ...recipient, status: 'unknown' })), code: 'provider_unknown', safeMessage: 'El proveedor no confirmó el resultado.' };
  }
  try {
    await persistProviderResult(env.DB, messageId, result);
  } catch {
    // The provider response cannot safely be replayed after a persistence
    // failure. Preserve the outbox payload and report an ambiguous attempt.
    try { await setOutboxStatus(env.DB, messageId, 'unknown', 'result_persist_failed'); } catch { /* D1 may be unavailable too */ }
    return { id: messageId, status: 'unknown', reused: false };
  }
  if (config.provider === 'local' && result.outcome === 'accepted') await env.DB.prepare(`UPDATE mail_messages SET archive_status = 'smtp_accepted' WHERE id = ? AND archive_address = ?`).bind(messageId, archive).run();
  return { id: messageId, status: providerResultStatus(result), reused: false };
}

export async function deliverIncomingArchive(env: Env, config: MailConfig, message: IncomingEmail): Promise<{ archived: boolean; cacheRaw: ReadableStream<Uint8Array> }> {
  let cacheRaw = message.raw;
  if (!config.archiveCopies?.enabled) {
    let archived = false;
    try { await message.forward(config.archiveAddress); archived = true; } catch { /* the cache may still retain the original */ }
    return { archived, cacheRaw };
  }
  let token: string | undefined;
  const subject = parseHeader(message.headers, 'subject', 998) || '';
  const headerSender = parseAddress(parseHeader(message.headers, 'from', MAX_ADDRESS_HEADER) || message.from);
  const senderLabel = headerSender.name || headerSender.email || config.mailbox.name;
  const replyAddress = parseAddress(parseHeader(message.headers, 'reply-to') || headerSender.email);
  const parentId = archiveMessageId(parseHeader(message.headers, 'message-id', 998));
  const references = archiveReferences(referencesFrom(parseHeader(message.headers, 'references', 8192)));
  if (config.archiveCopies?.enabled) {
    try {
      token = await sealArchiveReply(env, config, {
        direction: 'incoming', from: normalizeEmail(message.to), to: EMAIL_RE.test(replyAddress.email) && replyAddress.email.length <= 254 ? [replyAddress.email] : [],
        cc: [], subject: subject.slice(0, 251), inReplyTo: parentId, references,
      });
    } catch { console.warn('webmail_archive_link_unavailable'); }
  }
  const size = Number(message.rawSize);
  const bounded = config.archiveCopies?.incomingMode !== 'forward-with-notice' && Number.isSafeInteger(size) && size > 0 && size <= config.archiveCopies.maxDecoratedBytes;
  if (token && env.ARCHIVE_EMAIL_COPY && bounded) {
    const [archiveRaw, storageRaw] = cacheRaw.tee();
    cacheRaw = storageRaw;
    try {
      const original = await readArchiveOriginal(archiveRaw, size, config.archiveCopies!.maxDecoratedBytes);
      const parsed = await parseEmailContent(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer);
      const copyAttachments: EmailAttachment[] = [];
      for (const attachment of parsed.attachments.slice(0, 30)) {
        if (attachment.inline && attachment.contentId) {
          copyAttachments.push({ filename: attachment.filename, type: attachment.mimeType, content: attachment.content, disposition: 'inline', contentId: attachment.contentId });
        } else {
          copyAttachments.push({ filename: attachment.filename, type: attachment.mimeType, content: attachment.content, disposition: 'attachment' });
        }
      }
      copyAttachments.push({ filename: 'original.eml', type: 'message/rfc822', content: original, disposition: 'attachment' });
      if (copyAttachments.length > 32) throw new Error('archive_attachment_limit');
      const copy = archiveCopyContent(config, {
        direction: 'incoming', token, subject, sender: headerSender.email, senderName: headerSender.name,
        recipients: [message.to], text: parsed.bodyText, html: parsed.html, htmlStyles: parsed.styles, originalAttached: true,
      });
      const accepted = await env.ARCHIVE_EMAIL_COPY.send({
        from: { email: config.mailbox.address, name: senderLabel }, to: config.archiveAddress,
        subject: subject.slice(0, 255) || 'Correo recibido', text: copy.text, html: copy.html,
        ...(EMAIL_RE.test(replyAddress.email) && replyAddress.email.length <= 254 ? { replyTo: { email: replyAddress.email, name: replyAddress.name || senderLabel } } : {}),
        attachments: copyAttachments,
      });
      if (!accepted.messageId) throw new Error('archive_acceptance_unknown');
      return { archived: true, cacheRaw };
    } catch { console.warn('webmail_archive_copy_fallback'); }
  }
  // Large originals and failures keep the unrestricted original forwarding path.
  // All archive work occurs before D1/Turso. A failed optional notice never rejects
  // an original already accepted by the durable destination.
  let archived = false;
  try { await message.forward(config.archiveAddress); archived = true; } catch { /* the cache may still retain the original */ }
  if (archived && token && env.ARCHIVE_EMAIL_COPY) {
    try {
      const copy = archiveCopyContent(config, {
        direction: 'incoming', token, subject, sender: headerSender.email, senderName: headerSender.name,
        recipients: [message.to], notice: true,
      });
      await env.ARCHIVE_EMAIL_COPY.send({ from: { email: config.mailbox.address, name: senderLabel }, to: config.archiveAddress,
        subject: subject.slice(0, 255) || 'Correo recibido', text: copy.text, html: copy.html });
    } catch { console.warn('webmail_archive_notice_failed'); }
  }
  return { archived, cacheRaw };
}

export async function receiveEmail(env: Env, config: MailConfig, message: IncomingEmail): Promise<void> {
  validateConfig(config);
  const recipient = normalizeEmail(message.to);
  if (!mailIdentities(config).some(entry => normalizeEmail(entry.email) === recipient)) {
    message.setReject('La dirección de destino no está configurada.');
    return;
  }
  // Archive delivery never depends on database availability or cache capacity.
  const { archived: forwarded, cacheRaw } = await deliverIncomingArchive(env, config, message);
  let schemaReady = true;
  try { await ensureSchema(env.DB); } catch { schemaReady = false; }
  const receiptId = id();
  const receivedAt = nowIso();
  const size = Number(message.rawSize);
  if (!Number.isSafeInteger(size) || size < 0 || size > config.maxMessageBytes) {
    if (!forwarded) message.setReject('El mensaje excede el límite o no se pudo conservar.');
    return;
  }
  if (!schemaReady) {
    if (!forwarded) message.setReject('No se pudo entregar ni conservar el mensaje.');
    return;
  }
  let storageOk = false;
  try {
    storageOk = await reserveStorage(env.DB, config.mailbox.id, size, config.storageBudgetBytes);
  } catch {
    // Forwarding is an independent delivery path.  A D1 outage must not
    // prevent delivery to the configured archive address.
    if (!forwarded) message.setReject('No se pudo entregar ni conservar el mensaje.');
    return;
  }
  if (!storageOk) {
    try { await pauseStorage(env.DB, config.mailbox.id, config.storageBudgetBytes); } catch { /* forwarding remains authoritative */ }
  }
  const rawKey = `incoming/${config.mailbox.id}/${receivedAt.slice(0, 10)}/${receiptId}.eml`;
  let cached = false;
  if (storageOk) {
    try {
      await putStream(getMailStore(env, config), rawKey, cacheRaw, size);
      cached = true;
    } catch {
      try { await releaseStorage(env.DB, config.mailbox.id, size); } catch { /* keep forwarding independent of counter repair */ }
    }
  }
  if (!cached) {
    if (!forwarded) message.setReject('No se pudo entregar ni conservar el mensaje.');
    return;
  }
  const headers = message.headers;
  const envelopeFrom = parseAddress(message.from || 'unknown@example.invalid');
  const headerFrom = parseHeader(headers, 'from', MAX_ADDRESS_HEADER);
  const parsedHeaderFrom = headerFrom ? parseAddress(headerFrom) : undefined;
  const from = parsedHeaderFrom && EMAIL_RE.test(parsedHeaderFrom.email) ? parsedHeaderFrom : envelopeFrom;
  const to = parseAddressList(parseHeader(headers, 'to') || message.to).slice(0, 50);
  const cc = parseAddressList(parseHeader(headers, 'cc')).slice(0, 50);
  const replyToHeader = parseAddress(parseHeader(headers, 'reply-to') || '');
  const hasReplyTo = EMAIL_RE.test(replyToHeader.email);
  const subject = parseHeader(headers, 'subject', 998) || '';
  const rfcMessageId = parseHeader(headers, 'message-id', 998);
  const references = referencesFrom(parseHeader(headers, 'references', 8192));
  const expiresAt = addDaysIso(config.retentionDays, Date.parse(receivedAt));
  const messageId = id();
  try {
    const insert = env.DB.prepare(`INSERT INTO mail_messages (id, mailbox_id, direction, from_email, from_name, to_json, cc_json, subject, reply_to_json, rfc_message_id, references_json, raw_key, size_bytes, created_at, received_at, expires_at, receipt_id, archive_address, archive_status) VALUES (?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(messageId, config.mailbox.id, from.email, from.name ?? '', json(to), json(cc), subject, hasReplyTo ? json(replyToHeader) : null, rfcMessageId ?? null, json(references), rawKey, size, receivedAt, receivedAt, expiresAt, receiptId, config.archiveAddress, forwarded ? 'forward_accepted' : 'failed');
    await env.DB.batch([insert, env.DB.prepare('INSERT INTO mail_message_identities (message_id, address) VALUES (?, ?)').bind(messageId, recipient)]);
  } catch {
    // Keep the private object: it may be the only retained copy when indexing fails.
    return;
  }
}

interface WebhookEvent { event?: string; email?: string; MessageID?: string | number; Message_GUID?: string; CustomID?: string; time?: number; [key: string]: unknown }

function normalizeEvents(events: unknown): WebhookEvent[] {
  if (Array.isArray(events)) return events.filter((event): event is WebhookEvent => Boolean(event && typeof event === 'object'));
  if (events && typeof events === 'object') return [events as WebhookEvent];
  return [];
}

async function webhookRow(env: Env, config: MailConfig, event: WebhookEvent): Promise<{ outboxId: string; email: string; archive: boolean } | null> {
  const email = normalizeEmail(typeof event.email === 'string' ? event.email : '');
  if (!email) return null;
  const customId = typeof event.CustomID === 'string' ? event.CustomID : '';
  const providerId = event.MessageID == null ? '' : String(event.MessageID);
  const providerUuid = typeof event.Message_GUID === 'string' ? event.Message_GUID : '';
  const row = customId ? await env.DB.prepare(`SELECT r.outbox_id, r.email FROM mail_outbox_recipients r JOIN mail_outbox o ON o.id = r.outbox_id WHERE o.id = ? AND o.mailbox_id = ? AND lower(r.email) = ?`).bind(customId, config.mailbox.id, email).first<{ outbox_id: string; email: string }>() : null;
  const byProvider = row ?? (providerId || providerUuid ? await env.DB.prepare(`SELECT r.outbox_id, r.email FROM mail_outbox_recipients r JOIN mail_outbox o ON o.id = r.outbox_id WHERE o.mailbox_id = ? AND lower(r.email) = ? AND (r.provider_id = ? OR r.provider_uuid = ?)`)
    .bind(config.mailbox.id, email, providerId || null, providerUuid || null).first<{ outbox_id: string; email: string }>() : null);
  return byProvider ? { outboxId: byProvider.outbox_id, email: byProvider.email, archive: normalizeEmail(config.archiveAddress) === email } : null;
}

export async function processWebhook(env: Env, config: MailConfig, events: unknown): Promise<void> {
  validateConfig(config);
  await ensureSchema(env.DB);
  for (const event of normalizeEvents(events)) {
    const type = typeof event.event === 'string' ? event.event.toLowerCase() : '';
    if (!['sent', 'bounce', 'blocked', 'spam'].includes(type)) continue;
    const eventKey = await sha256(JSON.stringify({ type, id: event.MessageID ?? event.Message_GUID ?? '', email: event.email ?? '', time: event.time ?? 0, custom: event.CustomID ?? '' }));
    const target = await webhookRow(env, config, event);
    // Keep the dedupe marker and all derived state in one D1 batch.  A
    // provider retry must remain eligible when any later mutation fails.
    if (!target) {
      await env.DB.prepare(`INSERT OR IGNORE INTO mail_webhook_events (event_key, received_at) VALUES (?, ?)`).bind(eventKey, nowIso()).run();
      continue;
    }
    const status = type === 'sent' ? 'smtp_accepted' : 'failed';
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`INSERT OR IGNORE INTO mail_webhook_events (event_key, received_at) VALUES (?, ?)`).bind(eventKey, nowIso()),
    ];
    if (type === 'sent') {
      statements.push(env.DB.prepare(`UPDATE mail_outbox_recipients SET status = 'accepted', updated_at = ? WHERE outbox_id = ? AND lower(email) = ? AND status <> 'failed'`).bind(nowIso(), target.outboxId, target.email));
    } else {
      statements.push(env.DB.prepare(`UPDATE mail_outbox_recipients SET status = 'failed', updated_at = ? WHERE outbox_id = ? AND lower(email) = ?`).bind(nowIso(), target.outboxId, target.email));
    }
    if (target.archive) {
      statements.push(env.DB.prepare(`UPDATE mail_messages SET archive_status = ? WHERE id = ? AND archive_status NOT IN ('failed','unknown')`).bind(status, target.outboxId));
    }
    if (type !== 'sent') {
      const at = nowIso();
      statements.push(
        env.DB.prepare(`UPDATE mail_outbox SET status = CASE WHEN status = 'failed' THEN status ELSE 'failed' END, error_code = ?, updated_at = ? WHERE id = ?`).bind(`provider_${type}`, at, target.outboxId),
        env.DB.prepare(`UPDATE mail_messages SET send_status = 'failed', archive_status = CASE WHEN archive_status = 'pending' THEN 'failed' ELSE archive_status END WHERE id = ? AND send_status <> 'failed'`).bind(target.outboxId),
      );
    }
    await env.DB.batch(statements);
  }
}

export async function cleanup(env: Env, config: MailConfig): Promise<{ deleted: number; held: number }> {
  validateConfig(config);
  try { await getMailStore(env, config).purgeStaging?.(); }
  catch { /* The message index cleanup can continue if staging maintenance is unavailable. */ }
  await ensureSchema(env.DB);
  const now = nowIso();
  const candidates = await env.DB.prepare(`SELECT m.*, o.idempotency_key, o.payload_hash, o.status AS outbox_status FROM mail_messages m LEFT JOIN mail_outbox o ON o.id = m.id WHERE m.mailbox_id = ? AND m.expires_at <= ? AND m.delete_state IN ('active','deleting') AND m.archive_status NOT IN ('pending','failed','unknown') AND (m.send_status IS NULL OR m.send_status NOT IN ('pending','sending','unknown')) ORDER BY m.expires_at ASC, m.id ASC LIMIT 20`).bind(config.mailbox.id, now).all<MessageRow>();
  let deleted = 0;
  for (const row of candidates.results ?? []) {
    if (row.delete_state === 'active') {
      const marked = await env.DB.prepare(`UPDATE mail_messages SET delete_state = 'deleting', delete_started_at = ? WHERE id = ? AND delete_state = 'active'`).bind(now, row.id).run();
      if ((marked.meta.changes ?? 0) === 0) continue;
    }
    try {
      if (row.raw_key) await deleteObject(getMailStore(env, config), row.raw_key);
      if (row.payload_key) await deleteObject(getMailStore(env, config), row.payload_key);
    } catch {
      continue;
    }
    if (row.idempotency_key && row.payload_hash && row.outbox_status) {
      try {
        await addTombstone(env.DB, config.mailbox.id, row.idempotency_key, row.payload_hash, row.id, row.outbox_status, config.retentionDays);
      } catch {
        // The object is already marked deleting; leave the row so the next
        // bounded cleanup pass can retry tombstone/index deletion.
        continue;
      }
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM mail_read_states WHERE message_id = ?`).bind(row.id),
      env.DB.prepare(`DELETE FROM mail_outbox_recipients WHERE outbox_id = ?`).bind(row.id),
      env.DB.prepare(`DELETE FROM mail_outbox WHERE id = ?`).bind(row.id),
      env.DB.prepare(`DELETE FROM mail_messages WHERE id = ? AND delete_state = 'deleting'`).bind(row.id),
      env.DB.prepare(`UPDATE mail_storage_counters SET used_bytes = CASE WHEN used_bytes >= ? THEN used_bytes - ? ELSE 0 END, paused = CASE WHEN used_bytes <= ? THEN 0 ELSE paused END, updated_at = ? WHERE mailbox_id = ?`).bind(row.size_bytes, row.size_bytes, config.storageBudgetBytes, now, config.mailbox.id),
    ]);
    deleted += 1;
  }
  const heldRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM mail_messages WHERE mailbox_id = ? AND delete_state IN ('active','deleting') AND expires_at <= ? AND (archive_status IN ('pending','failed','unknown') OR send_status IN ('pending','sending','unknown'))`).bind(config.mailbox.id, now).first<{ count: number }>();
  await env.DB.prepare(`DELETE FROM mail_idempotency_tombstones WHERE expires_at <= ?`).bind(now).run();
  await env.DB.prepare(`DELETE FROM mail_webhook_events WHERE received_at <= ?`).bind(addDaysIso(-Math.max(30, config.retentionDays + 30))).run();
  return { deleted, held: Number(heldRow?.count ?? 0) };
}

export async function getCacheUsage(env: Env, config: MailConfig): Promise<{ usedBytes: number; budgetBytes: number; paused: boolean }> {
  validateConfig(config);
  return getStorageUsage(env.DB, config.mailbox.id, config.storageBudgetBytes);
}
