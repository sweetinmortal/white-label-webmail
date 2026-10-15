import PostalMime from 'postal-mime';
import { parseDocument } from 'htmlparser2';

type WorkerRequest = { buffer: ArrayBuffer };
type ParsedAttachment = {
  filename: string;
  mimeType: string;
  content: ArrayBuffer;
};

type PostalAttachment = {
  filename?: string;
  mimeType?: string;
  content?: Uint8Array | ArrayBuffer;
};

type PostalMessage = {
  text?: string;
  html?: string | string[];
  attachments?: PostalAttachment[];
};

const blockedTags = new Set(['script', 'style', 'head', 'svg', 'form', 'noscript', 'template']);
const newlineTags = new Set(['br', 'p', 'div', 'section', 'article', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'tr']);

function cleanFilename(name: string): string {
  const withoutPath = name.replace(/[\\/]/g, '-').replace(/[\u0000-\u001f]/g, '').trim();
  return withoutPath.slice(0, 180) || 'adjunto';
}

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

function toArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const parser = new PostalMime({ maxNestingDepth: 30, maxHeadersSize: 65_536 });
    const message = (await parser.parse(event.data.buffer)) as PostalMessage;
    const html = Array.isArray(message.html) ? message.html.join('\n') : message.html;
    const bodyText = message.text?.trim() || (html ? htmlToText(html) : '');
    const attachments: ParsedAttachment[] = (message.attachments ?? [])
      .filter((attachment): attachment is PostalAttachment & { content: Uint8Array | ArrayBuffer } => Boolean(attachment.content))
      .map((attachment) => ({
        filename: cleanFilename(attachment.filename ?? 'adjunto'),
        mimeType: attachment.mimeType || 'application/octet-stream',
        content: toArrayBuffer(attachment.content),
      }));

    const workerScope = self as unknown as {
      postMessage(message: unknown, transfer?: Transferable[]): void;
    };
    workerScope.postMessage(
      { bodyText, attachments },
      attachments.map((attachment) => attachment.content as Transferable),
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo leer el mensaje.' });
  }
};

export {};
