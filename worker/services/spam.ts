import type { D1Database } from '@cloudflare/workers-types';
import type { MailConfig } from '../types';
import { ensureSchema, nowIso } from '../store/schema';

export interface SpamVerdict { isSpam: boolean; reason: string; source: string }

/** Quarantine is reversible and never suppresses the original's forwarding.
 * Upstream positive spam headers are hints, not authentication or Gmail labels.
 * Negative hints cannot whitelist a message or override another positive signal.
 */
export function classifyIncomingSpam(headers: Headers, from: string, config: MailConfig): SpamVerdict {
  const clean: SpamVerdict = { isSpam: false, reason: '', source: 'none' };
  if (config.spamProtection?.enabled === false) return clean;
  if (config.spamProtection?.blockedSenders?.includes(from.trim().toLowerCase())) {
    return { isSpam: true, reason: 'Remitente bloqueado por la empresa.', source: 'blocked_sender' };
  }
  // Cloudflare prepends its own Authentication-Results; later headers may be
  // supplied by the sender. Be conservative with combined/malformed values.
  const firstAuth = (headers.get('authentication-results') ?? '').split(',')[0];
  if (/^\s*mx\.cloudflare\.net(?:\s+\d+)?\s*;/i.test(firstAuth)
    && /;\s*dmarc=fail(?:\s|;|$)/i.test(firstAuth.replace(/\([^)]*\)/g, ''))) {
    return { isSpam: true, reason: 'La comprobación DMARC de Cloudflare falló.', source: 'cloudflare_dmarc' };
  }
  if (/^yes(?:\s|,|$)/i.test((headers.get('x-spam-flag') ?? '').trim())
    || /^yes(?:\s|,|$)/i.test((headers.get('x-spam-status') ?? '').trim())
    || /^(?:spam|uce|malicious|phish)(?:\s|,|$)/i.test((headers.get('x-cfemailsecurity-disposition') ?? '').trim())) {
    return { isSpam: true, reason: 'Una cabecera del mensaje indica posible spam.', source: 'upstream_hint' };
  }
  // X-Cf-Spamh-Score has no current documented threshold; do not invent one.
  return clean;
}

/** Apply new company block rules to cached incoming messages, preserving every
 * manual restore and avoiding any MIME download or deletion of original copies.
 */
export async function quarantineBlockedSenders(db: D1Database, config: MailConfig): Promise<number> {
  const senders = config.spamProtection?.blockedSenders ?? [];
  if (config.spamProtection?.enabled === false || !senders.length) return 0;
  await ensureSchema(db);
  let changed = 0;
  for (let offset = 0; offset < senders.length; offset += 50) {
    const chunk = senders.slice(offset, offset + 50);
    const result = await db.prepare(`INSERT INTO mail_message_spam (message_id, mailbox_id, is_spam, reason, source, updated_at) SELECT m.id, m.mailbox_id, 1, 'Remitente bloqueado por la empresa.', 'blocked_sender', ? FROM mail_messages m WHERE m.mailbox_id = ? AND m.direction = 'incoming' AND m.delete_state = 'active' AND LOWER(m.from_email) IN (${chunk.map(() => '?').join(',')}) ON CONFLICT(message_id) DO UPDATE SET is_spam=1,reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at WHERE mail_message_spam.mailbox_id=excluded.mailbox_id AND mail_message_spam.source NOT IN ('manual','rule','blocked_sender')`)
      .bind(nowIso(), config.mailbox.id, ...chunk).run();
    changed += result.meta.changes ?? 0;
  }
  return changed;
}
