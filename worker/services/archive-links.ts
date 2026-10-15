import type { ArchiveReplyContext } from '../../shared/contracts';
import type { Env, MailConfig } from '../types';
import { AppError } from '../errors';
import { mailIdentities } from '../config';

export interface ArchiveReplyData {
  from?: string;
  direction: 'incoming' | 'outgoing';
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo?: string;
  references: string[];
}
const encoder = new TextEncoder();
const EMAIL = /^[^\s@<>;,\r\n]+@[^\s@<>;,\r\n]+\.[^\s@<>;,\r\n]+$/;
const MESSAGE_ID = /^<[^<>\s\r\n]{1,996}>$/;
const MAX_TOKEN = 8192;

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('canonical');
  return bytes;
}
function invalid(): AppError {
  return new AppError(400, 'ARCHIVE_LINK_INVALID', 'Este enlace de respuesta no es válido para este webmail.');
}
function keyBytes(env: Env, config: MailConfig): Uint8Array {
  // A public development key is permitted only by the loopback-only local mode.
  if (config.mode === 'local') return new Uint8Array(32).fill(37);
  try {
    const value = env.ARCHIVE_LINK_KEY;
    if (!value || value.length !== 43) throw new Error('key');
    const bytes = decode(value);
    if (bytes.length !== 32) throw new Error('key');
    return bytes;
  } catch {
    throw new AppError(503, 'ARCHIVE_LINK_NOT_CONFIGURED', 'Los enlaces del archivo principal no están configurados.');
  }
}
export function assertArchiveLinkKey(env: Env, config: MailConfig): void { keyBytes(env, config); }
function additionalData(config: MailConfig): Uint8Array {
  return encoder.encode(`webmail-archive-reply:v1|${config.appOrigin}|${config.mailbox.id}`);
}
function addresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10 || value.some(v => typeof v !== 'string' || v.length > 254 || !EMAIL.test(v))) throw invalid();
  return [...new Set(value.map(v => v.toLowerCase()))];
}
function validate(value: unknown): ArchiveReplyData {
  const data = value as ArchiveReplyData;
  if (!data || !['incoming', 'outgoing'].includes(data.direction) || typeof data.subject !== 'string' || data.subject.length > 255 || /[\x00-\x1f\x7f]/.test(data.subject)) throw invalid();
  const to = addresses(data.to), cc = addresses(data.cc);
  if (to.length + cc.length > 10 || !Array.isArray(data.references) || data.references.length > 5 || data.references.some(v => typeof v !== 'string' || !MESSAGE_ID.test(v)) || data.references.join(' ').length > 2048) throw invalid();
  if (data.inReplyTo !== undefined && (typeof data.inReplyTo !== 'string' || !MESSAGE_ID.test(data.inReplyTo))) throw invalid();
  if (data.from !== undefined && (typeof data.from !== 'string' || data.from.length > 254 || !EMAIL.test(data.from))) throw invalid();
  return { direction: data.direction, ...(data.from ? { from: data.from.toLowerCase() } : {}), to, cc: cc.filter(v => !to.includes(v)), subject: data.subject, references: data.references, ...(data.inReplyTo ? { inReplyTo: data.inReplyTo } : {}) };
}
export function archiveReferences(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values.filter(v => MESSAGE_ID.test(v)).reverse()) {
    if (result.length >= 5 || [...result, value].join(' ').length > 2048) break;
    result.unshift(value);
  }
  return result;
}
export function archiveMessageId(value?: string): string | undefined {
  return value && MESSAGE_ID.test(value) ? value : undefined;
}
export async function sealArchiveReply(env: Env, config: MailConfig, input: ArchiveReplyData): Promise<string> {
  const data = validate(input);
  const plaintext = encoder.encode(JSON.stringify(data));
  if (plaintext.byteLength > 6000) throw invalid();
  const key = await crypto.subtle.importKey('raw', keyBytes(env, config) as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(config) as BufferSource }, key, plaintext);
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function openArchiveReply(env: Env, config: MailConfig, token: unknown): Promise<ArchiveReplyData> {
  // This function never authenticates a user. Every HTTP caller must first pass
  // the normal Access/JWT checks, and sending must also pass mutation-origin checks.
  if (typeof token !== 'string' || token.length > MAX_TOKEN) throw invalid();
  const bytes = keyBytes(env, config);
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw invalid();
    const iv = decode(parts[1]), ciphertext = decode(parts[2]);
    if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > 6016) throw invalid();
    const key = await crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: additionalData(config) as BufferSource }, key, ciphertext as BufferSource);
    return validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
  } catch { throw invalid(); }
}
export async function archiveReplyContext(env: Env, config: MailConfig, token: string): Promise<ArchiveReplyContext> {
  const data = await openArchiveReply(env, config, token);
  const from = mailIdentities(config).find(identity => identity.email === data.from)?.email ?? config.mailbox.address;
  return { token, ...(data.from ? { from } : {}), to: data.to, cc: data.cc, subject: data.subject, direction: data.direction };
}
export function archiveReplyUrl(config: MailConfig, token: string): string {
  const url = new URL('/', config.appOrigin);
  url.searchParams.set('reply', token);
  return url.href;
}
