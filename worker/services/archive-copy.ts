import type { MailConfig } from '../types';
import { textToHtml } from '../../shared/email-html';
import { archiveReplyUrl } from './archive-links';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

export interface ArchiveCopyContent { text: string; html: string }

export interface ArchiveCopyInput {
  direction: 'incoming' | 'outgoing';
  token: string;
  subject: string;
  sender: string;
  senderName?: string;
  recipients: string[];
  text?: string;
  html?: string;
  htmlStyles?: string;
}

export function archiveCopyContent(config: MailConfig, input: ArchiveCopyInput): ArchiveCopyContent {
  const url = archiveReplyUrl(config, input.token);
  const senderLabel = input.senderName ? `${input.senderName} <${input.sender}>` : input.sender;
  const archiveLine = `Copia archivada por ${config.brand.name}. Remitente original: ${senderLabel}.`;
  const text = [
    ...(input.text ? [input.text] : []),
    '--',
    archiveLine,
    'Para responder, usa el webmail; no respondas desde Gmail.',
    `Responder en el webmail: ${url}`,
  ].join('\n\n');
  const color = /^#[a-f0-9]{6}$/i.test(config.brand.primaryColor) ? config.brand.primaryColor : '#0875d1';
  const body = input.html
    ? `${input.htmlStyles ? `<style>${input.htmlStyles}</style>` : ''}${input.html}`
    : input.text ? textToHtml(input.text) : '';
  const footer = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font:13px/1.5 Arial,sans-serif;color:#6b7280"><a href="${escape(url)}" style="display:inline-block;margin:0 0 8px;padding:7px 12px;border:1px solid ${color};border-radius:6px;color:${color};text-decoration:none;font-weight:600">Responder en el webmail</a><br>Para responder, usa el webmail; no respondas desde Gmail.<br>${escape(archiveLine)}</div>`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.subject || 'Correo')}</title></head><body style="margin:0;padding:0;background:#ffffff">${body}${footer}</body></html>`;
  return { text, html };
}
