import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import type { MessageDetail, SessionInfo } from '../shared/contracts';
import ReaderPanel from '../ui/components/ReaderPanel';
import type { Attachment } from '../ui/lib/api';

type ReaderProps = ComponentProps<typeof ReaderPanel>;
type DomNode = { type?: string; name?: string; attribs?: Record<string, string>; data?: string; childNodes?: DomNode[] };

const session: SessionInfo = {
  user: { email: 'reader@example.test' },
  brand: { name: 'Example', logo: '', primaryColor: '#0875d1', locale: 'es-EC' },
  mailbox: { id: 'mailbox-1', address: 'reader@example.test', name: 'Reader' },
  retentionDays: 30,
  maxComposeBytes: 100_000,
  maxAttachments: 5,
  maxAttachmentBytes: 100_000,
  mode: 'production',
  cache: { usedBytes: 0, budgetBytes: 1_000_000, paused: false },
};

const incomingDetail: MessageDetail = {
  id: 'message-1',
  mailboxId: 'mailbox-1',
  direction: 'incoming',
  from: { email: 'sender@example.test', name: 'Sender' },
  to: [{ email: 'reader@example.test' }],
  cc: [],
  subject: 'Security review',
  createdAt: '2026-11-04T12:00:00.000Z',
  sizeBytes: 100,
  isRead: false,
  archiveStatus: 'pending',
  references: [],
  expiresAt: '2026-12-04T12:00:00.000Z',
  rawAvailable: true,
};

const noOp = () => {};
const baseProps: ReaderProps = {
  session,
  detail: incomingDetail,
  isSpam: false,
  bodyText: 'Plain text body',
  html: '',
  styles: '',
  remoteImages: 0,
  attachments: [],
  loading: false,
  error: null,
  spamBusy: false,
  spamError: null,
  onBack: noOp,
  onMarkRead: noOp,
  onSetSpam: noOp,
  onDownload: noOp,
  onDownloadAttachment: noOp,
  onReply: noOp,
  onForward: noOp,
  onRetry: noOp,
};

function renderReader(props: Partial<ReaderProps> = {}) {
  return renderToStaticMarkup(createElement(ReaderPanel, { ...baseProps, ...props }));
}

function parseMarkup(markup: string) {
  const root = parseDocument(markup) as unknown as DomNode;
  const elements: DomNode[] = [];
  const visit = (node: DomNode) => {
    if (node.name) elements.push(node);
    node.childNodes?.forEach(visit);
  };
  visit(root);
  const textOf = (node: DomNode): string => node.type === 'text'
    ? node.data ?? ''
    : (node.childNodes ?? []).map(textOf).join('');
  return { elements, text: textOf(root), textOf };
}

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

describe('ReaderPanel spam rendering', () => {
  it('shows the spam warning, plain text, and a restore action', () => {
    const markup = renderReader({
      detail: { ...incomingDetail, isSpam: true, spamReason: 'Suspicious sender' },
      isSpam: true,
      bodyText: 'Plain message text',
    });
    const dom = parseMarkup(markup);
    const buttons = dom.elements.filter((element) => element.name === 'button').map(dom.textOf);

    expect(dom.text).toContain('Este mensaje está en Spam.');
    expect(dom.text).toContain('Plain message text');
    expect(dom.text).toContain('Motivo: Suspicious sender');
    expect(buttons).toContain('No es spam');
  });

  it('keeps hostile HTML, styles, URLs, and attachment payloads out of the active spam DOM', () => {
    const suspiciousHtml = '<a href="javascript:alert(1)">unsafe link text</a><img src="https://tracker.invalid/pixel" onerror="alert(1)"><iframe src="https://attacker.invalid"></iframe><script>alert(1)</script>';
    const suspiciousStyles = 'body{background:url(https://tracker.invalid/bg)} @import url(https://attacker.invalid/style.css)';
    const attachments: Attachment[] = [
      { filename: 'active.html', mimeType: 'text/html', content: bytes('<script>alert(1)</script>') },
      { filename: 'tracking.svg', mimeType: 'image/svg+xml', content: bytes('<svg onload="alert(1)"></svg>'), inline: true, contentId: 'tracking' },
    ];
    const spamReason = '<img src=x onerror=alert(1)>';
    const markup = renderReader({
      detail: { ...incomingDetail, isSpam: true, spamReason },
      isSpam: true,
      bodyText: 'Plain text <a href="javascript:alert(1)">literal text</a>',
      html: suspiciousHtml,
      styles: suspiciousStyles,
      remoteImages: 3,
      attachments,
    });
    const dom = parseMarkup(markup);
    const activeTags = new Set(['a', 'iframe', 'img', 'script', 'object', 'embed', 'form', 'style']);

    expect(dom.elements.some((element) => activeTags.has(element.name ?? ''))).toBe(false);
    expect(dom.elements.some((element) => Object.keys(element.attribs ?? {}).some((name) => /^(href|src|srcdoc|style|on)/i.test(name)))).toBe(false);
    expect(dom.elements.some((element) => element.attribs?.class?.split(/\s+/).includes('attachments'))).toBe(false);
    expect(dom.text).toContain('Plain text <a href="javascript:alert(1)">literal text</a>');
    expect(dom.text).toContain(spamReason);
    expect(dom.text).not.toContain('unsafe link text');
    expect(dom.text).not.toContain('active.html');
    expect(dom.text).not.toContain('tracking.svg');
  });

  it('retains the HTML preview for a normal incoming message', () => {
    const markup = renderReader({
      html: '<p>Normal HTML preview</p>',
      styles: '.message-marker{border:9px solid red}',
      remoteImages: 1,
    });
    const dom = parseMarkup(markup);
    const iframe = dom.elements.find((element) => element.name === 'iframe');

    expect(iframe).toBeDefined();
    expect(iframe?.attribs?.srcdoc).toContain('Normal HTML preview');
    expect(iframe?.attribs?.srcdoc).toContain('border:9px solid red');
    expect(dom.text).toContain('Mostrar imágenes');
  });

  it('does not offer spam classification for outgoing messages', () => {
    const markup = renderReader({ detail: { ...incomingDetail, direction: 'outgoing' }, isSpam: false });
    const dom = parseMarkup(markup);
    const buttons = dom.elements.filter((element) => element.name === 'button').map(dom.textOf);

    expect(buttons).not.toContain('Marcar como spam');
    expect(buttons).not.toContain('No es spam');
  });
});
