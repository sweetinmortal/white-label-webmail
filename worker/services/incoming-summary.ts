import type { Env, MailConfig } from '../types';
import { parseJson } from '../store/schema';
import type { ClaimedSummaryBatch, SummaryBatchStatus, SummaryItemRow } from '../store/incoming-summary';
import { claimSummaryBatch, finalizeSummaryBatch, pendingSummaryCount, recoverStaleSummaryBatches } from '../store/incoming-summary';
import { archiveReplyUrl, sealArchiveReply } from './archive-links';

const MAX_BATCHES_PER_RUN = 10;

export type SummarySendOutcome = Extract<SummaryBatchStatus, 'accepted' | 'failed' | 'unknown'>;

export interface SummarySendResult {
  outcome: SummarySendOutcome;
  providerMessageId?: string;
  code?: string;
}

export interface SummaryFlushResult {
  status: 'idle' | 'disabled' | 'deferred' | 'sent' | 'unknown' | 'failed' | 'persistence_failed';
  sent: number;
  pending: number;
  code?: string;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function formatDate(value: string, locale: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone, timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat('es', options).format(date);
    } catch {
      return value;
    }
  }
}

function summarySubject(config: MailConfig, count: number): string {
  return `Resumen de ${count} correos recibidos · ${config.brand.name}`.slice(0, 255);
}

function cleanSubject(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function replySubject(value: string): string {
  return (cleanSubject(value) || 'Correo recibido').slice(0, 251);
}

function summaryContent(config: MailConfig, items: Array<SummaryItemRow & { url: string }>): { text: string; html: string } {
  const timeZone = config.incomingSummary?.timeZone ?? 'UTC';
  const notice = 'Responde desde el webmail para conservar la identidad institucional y el hilo del mensaje. No respondas a este resumen.';
  const text = [
    `Resumen de ${items.length} correos recibidos en ${config.brand.name}.`,
    notice,
    '',
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.sender_name ? `${item.sender_name} <${item.sender_email}>` : item.sender_email}`,
      `Asunto: ${cleanSubject(item.subject) || '(sin asunto)'}`,
      `Recibido en: ${item.recipient_address}`,
      `Fecha: ${formatDate(item.received_at, config.brand.locale, timeZone)}`,
      `Responder en el webmail: ${item.url}`,
      '',
    ]),
    'Este resumen se genera automáticamente cada lote de correos entrantes.',
  ].join('\n');
  const color = /^#[a-f0-9]{6}$/i.test(config.brand.primaryColor) ? config.brand.primaryColor : '#0875d1';
  const cards = items.map((item, index) => {
    const sender = item.sender_name ? `${escape(item.sender_name)} &lt;${escape(item.sender_email)}&gt;` : escape(item.sender_email);
    return `<li style="margin:0 0 16px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;list-style:none">
      <div style="font:600 15px/1.4 Arial,sans-serif;color:#111827">${index + 1}. ${sender}</div>
      <div style="margin-top:7px;font:600 16px/1.4 Arial,sans-serif;color:#111827">${escape(cleanSubject(item.subject) || '(sin asunto)')}</div>
      <div style="margin-top:7px;font:13px/1.55 Arial,sans-serif;color:#4b5563">Recibido en: ${escape(item.recipient_address)}</div>
      <div style="font:13px/1.55 Arial,sans-serif;color:#4b5563">Fecha: ${escape(formatDate(item.received_at, config.brand.locale, timeZone))}</div>
      <a href="${escape(item.url)}" style="display:inline-block;margin-top:12px;padding:8px 13px;border:1px solid ${color};border-radius:6px;color:${color};text-decoration:none;font:600 14px/1.2 Arial,sans-serif">Responder en el webmail</a>
    </li>`;
  }).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(summarySubject(config, items.length))}</title></head><body style="margin:0;padding:0;background:#f7f8fa"><div style="max-width:760px;margin:0 auto;padding:24px 16px"><div style="padding:20px;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff"><h1 style="margin:0;font:700 22px/1.3 Arial,sans-serif;color:#111827">Resumen de ${items.length} correos recibidos</h1><p style="margin:10px 0 0;font:14px/1.6 Arial,sans-serif;color:#4b5563">${escape(notice)}</p><ul style="margin:20px 0 0;padding:0">${cards}</ul><p style="margin:18px 0 0;font:12px/1.5 Arial,sans-serif;color:#6b7280">${escape(config.brand.name)} · Este resumen se genera automáticamente cada lote de correos entrantes.</p></div></div></body></html>`;
  return { text, html };
}

export async function sendSummaryBatch(env: Env, config: MailConfig, claimed: ClaimedSummaryBatch): Promise<SummarySendResult> {
  const summary = config.incomingSummary;
  if (!summary?.enabled || !summary.from) return { outcome: 'failed', code: 'summary_not_configured' };
  if (!env.ARCHIVE_EMAIL_COPY) return { outcome: 'unknown', code: 'binding_missing' };
  const items: Array<SummaryItemRow & { url: string }> = [];
  try {
    for (const item of claimed.items) {
      const token = await sealArchiveReply(env, config, {
        direction: 'incoming',
        from: item.reply_from,
        to: parseJson<string[]>(item.reply_to_json, []).filter((email) => typeof email === 'string').slice(0, 10),
        cc: [],
        subject: replySubject(item.subject),
        ...(item.in_reply_to ? { inReplyTo: item.in_reply_to } : {}),
        references: parseJson<string[]>(item.references_json, []).slice(0, 5),
      });
      items.push({ ...item, url: archiveReplyUrl(config, token) });
    }
  } catch {
    return { outcome: 'failed', code: 'link_unavailable' };
  }
  const content = summaryContent(config, items);
  try {
    const result = await env.ARCHIVE_EMAIL_COPY.send({
      from: { email: summary.from.email, name: summary.from.name || summary.from.email },
      to: config.archiveAddress,
      subject: summarySubject(config, items.length),
      text: content.text,
      html: content.html,
    });
    if (!result || typeof result.messageId !== 'string' || !result.messageId) {
      return { outcome: 'unknown', code: 'acceptance_unknown' };
    }
    return { outcome: 'accepted', providerMessageId: result.messageId };
  } catch {
    // The binding may have handed the message to the provider before failing.
    // Never resend automatically; surface the batch as unknown for an operator.
    return { outcome: 'unknown', code: 'provider_exception' };
  }
}

export async function flushIncomingSummaries(env: Env, config: MailConfig): Promise<SummaryFlushResult> {
  const summary = config.incomingSummary;
  if (!summary?.enabled) return { status: 'disabled', sent: 0, pending: 0 };
  if (!env.ARCHIVE_EMAIL_COPY) return { status: 'deferred', sent: 0, pending: await pendingSummaryCount(env.DB, config.mailbox.id), code: 'binding_missing' };
  try { await recoverStaleSummaryBatches(env.DB, config.mailbox.id); }
  catch { /* A recovery sweep must not prevent a new complete batch from sending. */ }
  let sent = 0;
  for (let attempt = 0; attempt < MAX_BATCHES_PER_RUN; attempt += 1) {
    const pending = await pendingSummaryCount(env.DB, config.mailbox.id);
    if (pending < summary.batchSize) return { status: sent ? 'sent' : 'idle', sent, pending };
    const claimed = await claimSummaryBatch(env.DB, config.mailbox.id, summary.batchSize);
    if (!claimed) return { status: sent ? 'sent' : 'idle', sent, pending: await pendingSummaryCount(env.DB, config.mailbox.id) };
    let result: SummarySendResult;
    try { result = await sendSummaryBatch(env, config, claimed); }
    catch { result = { outcome: 'failed', code: 'summary_prepare_failed' }; }
    try { await finalizeSummaryBatch(env.DB, claimed.batch.id, result.outcome, result.providerMessageId, result.code); }
    catch { return { status: 'persistence_failed', sent, pending: await pendingSummaryCount(env.DB, config.mailbox.id).catch(() => 0), code: 'result_persist_failed' }; }
    if (result.outcome === 'accepted') { sent += 1; continue; }
    return {
      status: result.outcome === 'unknown' ? 'unknown' : 'failed',
      sent,
      pending: await pendingSummaryCount(env.DB, config.mailbox.id),
      code: result.code,
    };
  }
  return { status: 'sent', sent, pending: await pendingSummaryCount(env.DB, config.mailbox.id) };
}
