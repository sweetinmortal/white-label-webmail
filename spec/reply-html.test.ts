import { describe, expect, it } from 'vitest';
import { renderReplyHtml } from '../worker/services/reply-html';

const header = 'El jue, 22 oct 2026 a la(s) 1:57 p.m., Cliente Ejemplo (cliente@example.test) escribió:';

describe('reply HTML', () => {
  it('renders a Gmail-compatible quote with a standard blockquote fallback', () => {
    const html = renderReplyHtml(`Mi respuesta\n\n${header}\nHola\nmundo`);
    expect(html).toContain('<div dir="ltr"');
    expect(html).toContain('>Mi respuesta</div>');
    expect(html).toContain('class="gmail_quote"');
    expect(html).toContain('class="gmail_attr"');
    expect(html).toContain('type="cite"');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('bgcolor="#0875d1"');
    expect(html).toContain('bgcolor="#f7f9fc"');
    expect(html).toContain(`${header}<br>`);
    expect(html).toContain('Hola<br>\nmundo');
    expect(html).not.toContain('&gt; Hola');
  });

  it('uses a valid brand accent and falls back for unsafe colors', () => {
    const branded = renderReplyHtml(`Hola\n\n${header}\nUno`, '#123abc');
    expect(branded).toContain('bgcolor="#123abc"');
    expect(branded).toContain('background:#123abc');

    const invalid = renderReplyHtml(`Hola\n\n${header}\nUno`, 'red;background:url(x)');
    expect(invalid).toContain('bgcolor="#0875d1"');
    expect(invalid).not.toContain('url(');
  });

  it('escapes user and quoted HTML instead of emitting it', () => {
    const html = renderReplyHtml(`<script>alert("x")</script>\n\n${header}\n<img src=x onerror=alert(1)>`);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('normalizes legacy quoted lines before putting them in HTML', () => {
    const html = renderReplyHtml(`Respuesta\n\n${header}\n> uno\n> dos`);
    expect(html).toContain('uno<br>\ndos');
    expect(html).not.toContain('&gt; uno');
  });

  it('does not add HTML when the message has no quoted reply', () => {
    expect(renderReplyHtml('Solo una respuesta')).toBeUndefined();
  });

  it('supports quote-only replies and English attribution', () => {
    const html = renderReplyHtml(`${header}\nHola`);
    expect(html).toContain('class="gmail_quote"');
    expect(html).not.toContain('<div dir="ltr" style="font-family:Arial');
    expect(renderReplyHtml('Reply\n\nOn Thu, Oct 22, 2026 at 10:00 AM Client <client@example.net> wrote:\n> hello'))
      .toContain('type="cite"');
  });
});
