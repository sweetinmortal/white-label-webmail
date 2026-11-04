import type { Address, MessageDetail } from '../../shared/contracts';
import { safeLocale } from './format';

type ReplySource = Pick<MessageDetail, 'bodyText' | 'createdAt' | 'from'>;

function normalizedBody(value: string | null | undefined): string {
  return value?.replace(/\r\n?/g, '\n').replace(/\s+$/, '') ?? '';
}

function replyAddress(address: Address): string {
  const name = address.name?.trim();
  return name ? `${name} (${address.email})` : address.email;
}

/**
 * Formats the attribution Gmail uses in Spanish replies:
 * `El jue, 22 oct 2026 a la(s) 1:57 p.m., Nombre (correo) escribió:`.
 */
export function formatReplyDate(value: string, locale = 'es-EC'): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const safe = safeLocale(locale);
  const span = safe.toLowerCase().startsWith('es');
  const date = new Intl.DateTimeFormat(safe, {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  }).format(parsed);
  const time = new Intl.DateTimeFormat(safe, {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(parsed)
    .replace(/([ap])\.\s*m\./i, '$1.m.')
    .replace(/[\u202f\u00a0]/g, ' ');
  return `${date} ${span ? 'a la(s)' : 'at'} ${time}`;
}

/**
 * Builds the quoted block for a reply. Gmail shows the attribution and the
 * original body as plain lines, without `>` markers.
 */
export function buildReplyQuote(replyTo: ReplySource, locale = 'es-EC'): string {
  const original = normalizedBody(replyTo.bodyText);
  if (!original) return '';
  const safe = safeLocale(locale);
  const spanish = safe.toLowerCase().startsWith('es');
  return `${spanish ? 'El' : 'On'} ${formatReplyDate(replyTo.createdAt, safe)}, ${replyAddress(replyTo.from)} ${spanish ? 'escribió' : 'wrote'}:\n${original}`;
}

/** Builds the plain-text card Gmail inserts when forwarding a message. */
export function buildForwardQuote(source: MessageDetail, locale = 'es-EC'): string {
  const original = normalizedBody(source.bodyText);
  const safe = safeLocale(locale);
  const spanish = safe.toLowerCase().startsWith('es');
  const recipients = source.to.map(replyAddress).join(', ');
  const copied = source.cc.map(replyAddress).join(', ');
  const lines = [
    spanish ? '---------- Mensaje reenviado ---------' : '---------- Forwarded message ---------',
    `${spanish ? 'De' : 'From'}: ${replyAddress(source.from)}`,
    `${spanish ? 'Fecha' : 'Date'}: ${formatReplyDate(source.createdAt, safe)}`,
    `${spanish ? 'Asunto' : 'Subject'}: ${source.subject || '(sin asunto)'}`,
    `${spanish ? 'Para' : 'To'}: ${recipients}`,
    ...(copied ? [`${spanish ? 'Cc' : 'Cc'}: ${copied}`] : []),
  ];
  return original ? `${lines.join('\n')}\n\n${original}` : lines.join('\n');
}

/**
 * Joins the draft's editable body with its collapsed attribution. Keeping the
 * two parts separate in the composer lets the quote stay behind the three-dot
 * control while D1 still stores a normal single text payload.
 */
export function joinComposeText(text: string, quote: string): string {
  const visible = text.replace(/\s+$/, '');
  const attribution = quote.trim();
  if (!attribution) return visible;
  return visible.trim() ? `${visible}\n\n${attribution}` : attribution;
}
