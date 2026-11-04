const QUOTE_SELECTOR = [
  '.gmail_quote',
  '.gmail_extra',
  'blockquote',
  '[id="appendonsend"]',
  '[id="divRplyFwdMsg"]',
  '[id^="yahoo_quoted_"]',
  '.yahoo_quoted',
].join(',');

export const QUOTED_HTML_STYLES = `
details.trimmed-quote { display: block !important; margin: 18px 0 0 !important; padding: 10px 0 0 !important; border-top: 1px solid #e5e7eb !important; }
details.trimmed-quote > summary { width: 36px !important; height: 27px !important; display: flex !important; align-items: center !important; justify-content: center !important; list-style: none !important; border: 1px solid #dadce0 !important; border-radius: 14px !important; color: #5f6368 !important; background: #f8f9fa !important; font: 16px/1 Arial, Helvetica, sans-serif !important; cursor: pointer !important; }
details.trimmed-quote > summary::-webkit-details-marker { display: none !important; }
details.trimmed-quote > summary:hover { color: #075da8 !important; background: #e6f1fc !important; }
details.trimmed-quote > summary:focus-visible { outline: 2px solid rgb(8 117 209 / 40%) !important; outline-offset: 2px !important; }
details.trimmed-quote > .quoted-html { margin-top: 12px !important; padding-left: 13px !important; border-left: 2px solid #e5e7eb !important; color: #5f6368 !important; }
`;

/**
 * Move common Gmail/Outlook quote containers into a closed native <details>
 * control. Doing this before the sanitized message is put in the sandbox keeps
 * the interaction working without scripts inside the email iframe.
 */
export function collapseQuotedHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html;
  let document: Document;
  try {
    document = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }
  const body = document.body;
  if (!body) return html;
  const candidates = Array.from(body.querySelectorAll(QUOTE_SELECTOR)) as HTMLElement[];
  const roots = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node)));
  if (!roots.length) return html;

  // Never hide the whole message. Some senders wrap the visible text in a
  // blockquote; in that case leave the original HTML untouched.
  const withoutQuotes = body.cloneNode(true) as HTMLElement;
  for (const node of Array.from(withoutQuotes.querySelectorAll(QUOTE_SELECTOR))) node.remove();
  if (!withoutQuotes.textContent?.trim()) return html;

  const details = document.createElement('details');
  details.className = 'trimmed-quote';
  const summary = document.createElement('summary');
  summary.setAttribute('aria-label', 'Mostrar texto citado');
  summary.title = 'Mostrar texto citado';
  summary.textContent = '•••';
  const quote = document.createElement('div');
  quote.className = 'quoted-html';
  for (const node of roots) quote.appendChild(node);
  details.append(summary, quote);
  body.appendChild(details);
  return body.innerHTML;
}
