import PostalMime from 'postal-mime';
import { parseDocument } from 'htmlparser2';
import { isInlineImageMime, isMimeType, sanitizeAttachmentFilename } from './attachments';
import { sanitizeEmailHtml } from './email-html';

export interface ParsedEmailAttachment {
  filename: string;
  mimeType: string;
  content: ArrayBuffer;
  contentId?: string;
  inline: boolean;
}

export interface ParsedEmailContent {
  bodyText: string;
  html: string;
  styles: string;
  remoteImages: number;
  attachments: ParsedEmailAttachment[];
}

type PostalAttachment = {
  filename?: string | null;
  mimeType?: string;
  content?: Uint8Array | ArrayBuffer | string;
  contentId?: string;
  disposition?: 'attachment' | 'inline' | null;
  related?: boolean;
};

type PostalMessage = {
  text?: string;
  html?: string | string[];
  attachments?: PostalAttachment[];
};

const blockedTags = new Set(['script', 'style', 'head', 'svg', 'form', 'noscript', 'template']);
const newlineTags = new Set(['br', 'p', 'div', 'section', 'article', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'tr']);

function htmlToText(html: string): string {
  const document = parseDocument(html, { decodeEntities: true });
  function walk(node: { type?: string; name?: string; data?: string; children?: unknown[] }): string {
    if (node.type === 'text') return node.data ?? '';
    const tag = node.name?.toLowerCase();
    if (tag && blockedTags.has(tag)) return '';
    const content = (node.children ?? [])
      .map((child) => walk(child as { type?: string; name?: string; data?: string; children?: unknown[] }))
      .join('');
    return tag && newlineTags.has(tag) ? `${content}\n` : content;
  }
  return walk(document as unknown as { children?: unknown[] })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toArrayBuffer(value: Uint8Array | ArrayBuffer | string): ArrayBuffer {
  if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function normalizeContentId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^<|>$/g, '').slice(0, 255);
  return cleaned || undefined;
}

export async function parseEmailContent(buffer: ArrayBuffer): Promise<ParsedEmailContent> {
  const parser = new PostalMime({ maxNestingDepth: 30, maxHeadersSize: 65_536 });
  const message = await parser.parse(buffer) as PostalMessage;
  const rawHtml = Array.isArray(message.html) ? message.html.join('\n') : message.html;
  const sanitized = rawHtml ? sanitizeEmailHtml(rawHtml) : { html: '', styles: '', remoteImages: 0 };
  const bodyText = message.text?.trim() || (rawHtml ? htmlToText(rawHtml) : '');
  const attachments: ParsedEmailAttachment[] = [];
  for (const attachment of message.attachments ?? []) {
    if (!attachment.content) continue;
    const mimeType = isMimeType(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream';
    const contentId = normalizeContentId(attachment.contentId);
    // A Content-ID alone does not make a file invisible as an attachment. Only
    // parts explicitly marked inline (or without an attachment disposition)
    // are treated as embedded images.
    const inline = Boolean(contentId && isInlineImageMime(mimeType) && attachment.disposition !== 'attachment');
    attachments.push({
      filename: sanitizeAttachmentFilename(attachment.filename),
      mimeType,
      content: toArrayBuffer(attachment.content),
      ...(contentId ? { contentId } : {}),
      inline,
    });
  }
  return {
    bodyText,
    html: sanitized.html,
    styles: sanitized.styles,
    remoteImages: sanitized.remoteImages,
    attachments,
  };
}
