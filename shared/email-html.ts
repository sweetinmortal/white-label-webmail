import { parseDocument } from 'htmlparser2';

type HtmlNode = {
  type?: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
};

export interface SanitizedEmailHtml {
  html: string;
  styles: string;
  remoteImages: number;
}

const BLOCKED = new Set([
  'script', 'noscript', 'iframe', 'object', 'embed', 'applet', 'svg', 'math', 'template',
  'meta', 'link', 'base', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
  'video', 'audio', 'source', 'track', 'canvas', 'dialog',
]);
const UNWRAP = new Set(['html', 'head', 'body', 'form']);
const ALLOWED = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav',
  'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr',
  'tt', 'u', 'ul', 'var', 'wbr',
]);
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const GLOBAL_ATTRS = new Set([
  'style', 'class', 'id', 'title', 'dir', 'lang', 'align', 'valign', 'width', 'height',
  'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'role',
]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'name']),
  img: new Set(['src', 'alt', 'width', 'height', 'border', 'hspace', 'vspace', 'loading']),
  font: new Set(['color', 'face', 'size']),
  table: new Set(['background', 'summary']),
  td: new Set(['background', 'nowrap', 'scope', 'abbr', 'axis']),
  th: new Set(['background', 'nowrap', 'scope', 'abbr', 'axis']),
  ol: new Set(['start', 'type', 'reversed']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  time: new Set(['datetime']),
  col: new Set(['span', 'width']),
  hr: new Set(['size', 'noshade']),
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!));
}

export { escapeHtml };

export function textToHtml(value: string): string {
  return `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(value)}</div>`;
}

function sanitizeCss(value: string): string {
  let output = value.replace(/\/\*[\s\S]*?\*\//g, '');
  output = output.replace(/@(?:import|charset|namespace)[^;]*(?:;|$)/gi, '');
  output = output.replace(/(?:expression|behavior|-moz-binding)\s*:/gi, '');
  output = output.replace(/url\s*\(\s*(['"]?)\s*(?:javascript|vbscript|data:text\/html)[\s\S]*?\)/gi, 'none');
  output = output.replace(/url\s*\(\s*(['"]?)\s*(?:https?:)?\/\/[\s\S]*?\)/gi, 'none');
  output = output.replace(/<\/?style/gi, '');
  output = output.replace(/[<>]/g, '');
  return output.trim();
}

function normalizeUrl(value: string, kind: 'link' | 'image'): string | null {
  const url = value.trim();
  if (!url) return null;
  const candidate = url.startsWith('//') ? `https:${url}` : url;
  if (kind === 'link') {
    if (/^(?:https?|mailto|tel):/i.test(candidate) || candidate.startsWith('#')) return candidate;
    return null;
  }
  if (/^cid:/i.test(candidate)) return candidate;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(candidate)) return candidate;
  if (/^https?:/i.test(candidate)) return candidate;
  return null;
}

function isRemote(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

function attributes(node: HtmlNode, tag: string, state: { remoteImages: number }): string {
  const allowed = TAG_ATTRS[tag];
  let output = '';
  for (const [rawName, rawValue] of Object.entries(node.attribs ?? {})) {
    const name = rawName.toLowerCase();
    if (name.startsWith('on') || name.startsWith('data-') || name.startsWith('aria-')) continue;
    if (!GLOBAL_ATTRS.has(name) && !allowed?.has(name)) continue;
    let value = rawValue;
    if (name === 'style') {
      value = sanitizeCss(value);
      if (!value) continue;
    } else if (name === 'href') {
      const url = normalizeUrl(value, 'link');
      if (!url) continue;
      value = url;
    } else if (name === 'src' || name === 'background') {
      const url = normalizeUrl(value, 'image');
      if (!url) continue;
      if (isRemote(url)) {
        if (name === 'background') continue;
        state.remoteImages += 1;
      }
      value = url;
    } else if (name === 'srcset' || name === 'poster') {
      continue;
    }
    output += ` ${name}="${escapeHtml(value)}"`;
    if (tag === 'a' && name === 'href') {
      output += ' target="_blank" rel="noopener noreferrer"';
    }
  }
  return output;
}

function walk(node: HtmlNode, state: { remoteImages: number; styles: string[] }): string {
  if (node.type === 'text') return escapeHtml(node.data ?? '');
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return '';
  const tag = (node.name ?? '').toLowerCase();
  if (tag === 'style') {
    const css = sanitizeCss((node.children ?? []).map((child) => child.data ?? '').join(''));
    if (css) state.styles.push(css);
    return '';
  }
  if (BLOCKED.has(tag) || tag === 'title') return '';
  const children = (node.children ?? []).map((child) => walk(child, state)).join('');
  // Retain body presentation without introducing a second document body.
  if (tag === 'body') return `<div${attributes(node, tag, state)}>${children}</div>`;
  if (UNWRAP.has(tag)) return children;
  if (!ALLOWED.has(tag)) return children;
  const attrs = attributes(node, tag, state);
  return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${children}</${tag}>`;
}

export function sanitizeEmailHtml(input: string): SanitizedEmailHtml {
  const document = parseDocument(input, { decodeEntities: true }) as unknown as HtmlNode;
  const state = { remoteImages: 0, styles: [] as string[] };
  const html = (document.children ?? []).map((child) => walk(child, state)).join('');
  return { html, styles: state.styles.join('\n'), remoteImages: state.remoteImages };
}
