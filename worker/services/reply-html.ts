import { escapeHtml } from '../../shared/email-html';

interface ReplyParts {
  visible: string;
  attribution: string;
  quote: string;
}

const ATTRIBUTION = /^\s*(?:El .+ escribió:|On .+ wrote:)\s*$/i;

function normalize(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function withoutLegacyMarkers(value: string): string {
  const lines = value.split('\n');
  const content = lines.filter((line) => line.trim());
  if (!content.length || !content.every((line) => /^\s*>/.test(line))) return value;
  return lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n').trim();
}

function parseReplyParts(text: string): ReplyParts | null {
  const lines = normalize(text).split('\n');
  const headerIndex = lines.findIndex((line, index) => (
    ATTRIBUTION.test(line) && (index === 0 || !lines[index - 1].trim())
  ));
  if (headerIndex < 0) return null;
  const attribution = lines[headerIndex].trim();
  const quote = withoutLegacyMarkers(lines.slice(headerIndex + 1).join('\n')).trim();
  if (!attribution || !quote) return null;
  return {
    visible: lines.slice(0, headerIndex).join('\n').trim(),
    attribution,
    quote,
  };
}

function linesToHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>\n');
}

const DEFAULT_ACCENT = '#0875d1';

function safeAccent(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_ACCENT;
}

/**
 * Builds the HTML alternative for a reply. The Gmail classes let Gmail hide
 * the quoted content behind its three-dot control. Gmail only recognizes its
 * own class; the semantic blockquote, `type="cite"` marker, and table-based
 * quote card keep the same content readable in Outlook, Apple Mail,
 * Thunderbird and other clients that do not implement Gmail's behavior.
 */
export function renderReplyHtml(text: string, primaryColor?: string): string | undefined {
  const parts = parseReplyParts(text);
  if (!parts) return undefined;
  const accent = safeAccent(primaryColor);
  const fontStyle = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;';
  const bodyStyle = `${fontStyle}color:#222;`;
  const attributionStyle = `${fontStyle}font-size:12px;color:#64748b;margin:0 0 8px`;
  const quoteCellStyle = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#374151;background:#f7f9fc;border-top:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:12px 14px;vertical-align:top;';
  const visible = parts.visible
    ? `<div dir="ltr" style="${bodyStyle}">${linesToHtml(parts.visible)}</div>`
    : '';
  return `${visible}<div class="gmail_quote" style="margin-top:18px">` +
    `<div dir="ltr" class="gmail_attr" style="${attributionStyle}">${escapeHtml(parts.attribution)}<br></div>` +
    '<blockquote type="cite" class="gmail_quote" style="margin:0;padding:0;border:0">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">' +
    '<tr>' +
    `<td width="3" bgcolor="${accent}" style="width:3px;background:${accent};font-size:0;line-height:0;vertical-align:top">&nbsp;</td>` +
    `<td bgcolor="#f7f9fc" style="${quoteCellStyle}">${linesToHtml(parts.quote)}</td>` +
    '</tr></table></blockquote></div>';
}
