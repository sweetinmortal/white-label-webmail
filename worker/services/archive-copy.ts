import type { MailConfig } from '../types';
import { archiveReplyUrl } from './archive-links';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
export interface ArchiveCopyContent { text: string; html: string }
export function archiveCopyContent(config: MailConfig, input: {
  direction: 'incoming' | 'outgoing'; token: string; subject: string;
  sender: string; recipients: string[]; text?: string; originalAttached?: boolean;
}): ArchiveCopyContent {
  const url = archiveReplyUrl(config, input.token);
  const instruction = 'Esta es una copia de archivo. No respondas desde Gmail: responde siempre desde el webmail de la empresa.';
  const title = input.direction === 'incoming' ? 'Copia del correo recibido' : 'Copia del correo enviado';
  const originalNote = input.originalAttached
    ? 'El correo original completo, incluidos sus adjuntos, se conserva en original.eml.'
    : input.text === undefined ? 'El correo original se conserva en esta misma conversación de Gmail.' : '';
  const text = [config.brand.name, title, instruction, `Responder en el webmail: ${url}`, originalNote,
    `Asunto: ${input.subject}`, `De: ${input.sender}`, `Para: ${input.recipients.join(', ')}`,
    ...(input.text === undefined ? [] : ['', input.text]),
  ].filter(value => value !== '').join('\n\n');
  const color = /^#[a-f0-9]{6}$/i.test(config.brand.primaryColor) ? config.brand.primaryColor : '#0875d1';
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#162235"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:24px 12px"><table role="presentation" style="width:100%;max-width:640px;margin:auto;background:white;border:1px solid #e1e7ef;border-radius:12px"><tr><td style="padding:24px"><h2 style="margin:0 0 12px;color:${color}">${escape(config.brand.name)}</h2><p style="font-weight:bold">${title}</p><p>${instruction}</p><p style="margin:24px 0"><a href="${escape(url)}" style="display:inline-block;background:${color};color:white;text-decoration:none;padding:14px 20px;border-radius:8px;font-weight:bold">Responder en el webmail</a></p>${originalNote ? `<p style="font-size:13px;color:#526071">${originalNote}</p>` : ''}<hr style="border:0;border-top:1px solid #e1e7ef"><p><strong>Asunto:</strong> ${escape(input.subject)}<br><strong>De:</strong> ${escape(input.sender)}<br><strong>Para:</strong> ${escape(input.recipients.join(', '))}</p>${input.text === undefined ? '' : `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(input.text)}</div>`}<p style="font-size:12px;color:#526071">El botón abre ${escape(config.appOrigin)} y requiere una sesión autorizada.</p></td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

export async function readArchiveOriginal(stream: ReadableStream<Uint8Array>, expectedSize: number, limit: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > limit) throw new Error('archive_original_size');
  const bytes = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedSize - offset) throw new Error('archive_original_size');
      bytes.set(value, offset); offset += value.byteLength;
    }
    if (offset !== expectedSize) throw new Error('archive_original_size');
    return bytes;
  } catch (error) {
    // Awaiting cancellation of one tee branch can wait forever for the other
    // branch. The cache still owns that second branch and will consume it.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
