import type { Env, MailConfig } from '../types';
import { AppError } from '../errors';
import type { OutboundMessage, OutboundProvider, ProviderResult } from './types';
import { archiveCopyContent } from '../services/archive-copy';

function basicAuth(key: string, secret: string): string {
  const bytes = new TextEncoder().encode(`${key}:${secret}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function providerKind(email: string, message: OutboundMessage): 'to' | 'cc' | 'bcc' {
  return message.to.find((recipient) => recipient.email === email)?.kind ?? 'to';
}

export const mailjetProvider: OutboundProvider = {
  async send(env: Env, config: MailConfig, message: OutboundMessage): Promise<ProviderResult> {
    if (!env.MAILJET_API_KEY || !env.MAILJET_API_SECRET) {
      throw new AppError(503, 'provider_not_configured', 'El proveedor de correo no está configurado.');
    }
    const attachments = message.attachments.map((attachment) => ({
      ContentType: attachment.mimeType,
      Filename: attachment.filename,
      Base64Content: attachment.contentBase64,
    }));
    const ordinary = (recipients: OutboundMessage['to']) => ({
        From: { Email: message.from.email, Name: message.from.name },
        To: recipients.filter((recipient) => recipient.kind === 'to').map(({ email }) => ({ Email: email })),
        Cc: recipients.filter((recipient) => recipient.kind === 'cc').map(({ email }) => ({ Email: email })),
        Bcc: recipients.filter((recipient) => recipient.kind === 'bcc').map(({ email }) => ({ Email: email })),
        Subject: message.subject,
        TextPart: message.text,
        ...(attachments.length ? { Attachments: attachments } : {}),
        Headers: message.headers,
        CustomID: message.customId,
        TrackOpens: 'disabled',
        TrackClicks: 'disabled',
      });
    const groups: Array<OutboundMessage['to']> = [];
    const messages: Array<Record<string, unknown>> = [];
    if (config.archiveCopies?.enabled) {
      if (!message.archiveReplyToken) throw new AppError(503, 'archive_copy_not_configured', 'Falta preparar la copia de archivo.');
      const archive = message.to.filter(recipient => recipient.email === message.archiveAddress);
      const customers = message.to.filter(recipient => recipient.email !== message.archiveAddress);
      if (archive.length !== 1) throw new AppError(503, 'archive_copy_not_configured', 'Falta preparar la copia de archivo.');
      if (customers.length) { groups.push(customers); messages.push(ordinary(customers)); }
      const copy = archiveCopyContent(config, {
        direction: 'outgoing', token: message.archiveReplyToken, subject: message.subject,
        sender: message.from.email, recipients: customers.map(recipient => recipient.email), text: message.text,
      });
      groups.push(archive);
      messages.push({ ...ordinary([]), To: [{ Email: message.archiveAddress }], TextPart: copy.text, HTMLPart: copy.html });
    } else {
      groups.push(message.to); messages.push(ordinary(message.to));
    }
    // The private archive is a separate message within the same Send API call.
    // Customer recipients receive exactly the original content, without its notice.
    const body = { Messages: messages };
    let response: Response;
    try {
      response = await fetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: {
          Authorization: basicAuth(env.MAILJET_API_KEY, env.MAILJET_API_SECRET),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { outcome: 'unknown', recipients: message.to.map((recipient) => ({ ...recipient, status: 'unknown' })), code: 'provider_timeout', safeMessage: 'El proveedor no confirmó si aceptó el mensaje.' };
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { outcome: 'unknown', recipients: message.to.map((recipient) => ({ ...recipient, status: 'unknown' })), code: 'provider_redirect', safeMessage: 'El proveedor no confirmó el resultado.' };
    }
    const raw = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!response.ok) {
      if (response.status >= 500) return { outcome: 'unknown', recipients: message.to.map((recipient) => ({ ...recipient, status: 'unknown' })), code: `provider_http_${response.status}`, safeMessage: 'El proveedor no confirmó el resultado.' };
      return { outcome: 'definite_failure', recipients: message.to.map((recipient) => ({ ...recipient, status: 'failed' })), code: `provider_http_${response.status}`, safeMessage: 'El proveedor rechazó el mensaje.' };
    }
    const results = (parsed as { Messages?: Array<Record<string, unknown>> } | null)?.Messages;
    if (!Array.isArray(results) || results.length !== groups.length) {
      return { outcome: 'unknown', recipients: message.to.map(recipient => ({ ...recipient, status: 'unknown' })), code: 'provider_partial_response', safeMessage: 'El proveedor devolvió una respuesta incompleta.' };
    }
    const recipients: ProviderResult['recipients'] = [];
    for (const [index, result] of results.entries()) {
      const group = groups[index];
      if (result.Status === 'error') {
        recipients.push(...group.map(recipient => ({ ...recipient, status: 'failed' as const })));
        continue;
      }
      const accepted: ProviderResult['recipients'] = [];
      for (const field of ['To', 'Cc', 'Bcc'] as const) {
        const values = Array.isArray(result[field]) ? result[field] as Array<Record<string, unknown>> : [];
        for (const value of values) {
          const email = typeof value.Email === 'string' ? value.Email.toLowerCase() : '';
          if (!email) continue;
          accepted.push({ email, kind: providerKind(email, message), providerId: value.MessageID == null ? undefined : String(value.MessageID), providerUuid: value.MessageUUID == null ? undefined : String(value.MessageUUID), status: 'accepted' });
        }
      }
      if (result.Status !== 'success' || accepted.length !== group.length || new Set(accepted.map(value => value.email)).size !== group.length || accepted.some(value => !group.some(recipient => recipient.email === value.email))) {
        recipients.push(...group.map(recipient => ({ ...recipient, status: 'unknown' as const })));
      } else {
        recipients.push(...accepted);
      }
    }
    if (recipients.some(recipient => recipient.status === 'unknown')) {
      return { outcome: 'unknown', recipients, code: 'provider_partial_response', safeMessage: 'El proveedor devolvió una respuesta incompleta.' };
    }
    if (recipients.some(recipient => recipient.status === 'failed')) return { outcome: 'definite_failure', recipients, code: 'provider_rejected', safeMessage: 'El proveedor rechazó una parte del envío. Revisa Enviados antes de repetirlo.' };
    return { outcome: 'accepted', recipients };
  },
};
