export interface SplitQuotedPlainText {
  visible: string;
  quoted: string | null;
}

export interface SplitQuotedOptions {
  /** Allow a draft whose body contains only a quote header and quoted text. */
  allowEmptyVisible?: boolean;
}

const QUOTE_HEADERS = [
  /^\s*El .+ escribió:\s*$/i,
  /^\s*On .+ wrote:\s*$/i,
  /^\s*-{2,}\s*(?:Original Message|Mensaje original)\s*-{2,}\s*$/i,
];

function outlookHeaderStart(lines: string[]): number | null {
  for (let index = 1; index < lines.length; index += 1) {
    if (!/^\s*(?:De|From):\s+\S/i.test(lines[index])) continue;
    const following = lines.slice(index + 1, index + 7).join('\n');
    if (/(?:^|\n)\s*(?:Enviado|Sent|Fecha|Date|Para|To|Asunto|Subject):/i.test(following)) return index;
  }
  return null;
}

function trailingQuoteStart(lines: string[]): number | null {
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  let start = end;
  let hasQuote = false;
  while (start >= 0) {
    const line = lines[start];
    if (/^\s*>/.test(line)) {
      hasQuote = true;
      start -= 1;
      continue;
    }
    if (!line.trim()) {
      start -= 1;
      continue;
    }
    break;
  }
  start += 1;
  return hasQuote && start > 0 ? start : null;
}

/**
 * Split a plain-text message into the part written for this message and the
 * quoted conversation below it. Gmail and Outlook use different separators,
 * while older clients only prefix quoted lines with `>`.
 */
export function splitQuotedPlainText(value: string, options: SplitQuotedOptions = {}): SplitQuotedPlainText {
  const normalized = value.replace(/\r\n?/g, '\n');
  if (!normalized) return { visible: '', quoted: null };
  const lines = normalized.split('\n');

  let headerStart: number | null = null;
  for (let index = options.allowEmptyVisible ? 0 : 1; index < lines.length; index += 1) {
    if (QUOTE_HEADERS.some((pattern) => pattern.test(lines[index]))) {
      headerStart = index;
      break;
    }
  }
  if (headerStart === null) headerStart = outlookHeaderStart(lines);
  const start = headerStart ?? trailingQuoteStart(lines);
  if (start === null) return { visible: normalized, quoted: null };

  const visible = lines.slice(0, start).join('\n').trimEnd();
  const quoted = lines.slice(start).join('\n').trim();
  if ((!visible.trim() && !options.allowEmptyVisible) || !quoted) return { visible: normalized, quoted: null };
  return { visible, quoted };
}

/** Remove one or more nested `>` quote markers for Gmail-like display. */
export function cleanQuotedText(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*(?:>\s*)+/, ''))
    .join('\n')
    .trim();
}
