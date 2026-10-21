import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml, textToHtml } from '../shared/email-html';

describe('email HTML sanitizer', () => {
  it('keeps formatting and inline images while removing active content and remote CSS', () => {
    const result = sanitizeEmailHtml([
      '<html><head><style>.card { color: #123456; background: url(https://tracker.test/bg); }</style><script>alert(1)</script></head>',
      '<body><table class="card" background="https://tracker.test/table"><tr><td>',
      '<a href="javascript:alert(1)" onclick="alert(2)">bad</a>',
      '<a href="https://example.test/?a=1&b=2">good</a>',
      '<img src="https://tracker.test/pixel.gif" onerror="alert(3)">',
      '<img src="cid:logo@test">',
      '</td></tr></table><form><input value="secret"></form></body></html>',
    ].join(''));

    expect(result.html).toContain('<table class="card"');
    expect(result.html).toContain('<a href="https://example.test/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">good</a>');
    expect(result.html).toContain('<img src="https://tracker.test/pixel.gif">');
    expect(result.html).toContain('<img src="cid:logo@test">');
    expect(result.html).not.toContain('javascript:');
    expect(result.html).not.toContain('onclick');
    expect(result.html).not.toContain('onerror');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('<form');
    expect(result.html).not.toContain('<input');
    expect(result.html).not.toContain('background=');
    expect(result.remoteImages).toBe(1);
    expect(result.styles).toContain('.card');
    expect(result.styles).not.toContain('tracker.test');
  });

  it('escapes text alternatives into safe HTML', () => {
    expect(textToHtml('<b>Hola</b> & "equipo"')).toBe('<div style="white-space:pre-wrap;overflow-wrap:anywhere">&lt;b&gt;Hola&lt;/b&gt; &amp; &quot;equipo&quot;</div>');
  });
  it('preserves the body styling in a safe wrapper', () => {
    const result = sanitizeEmailHtml('<body class="newsletter" style="background:#123456;color:white" onload="alert(1)"><p>Hola</p></body>');
    expect(result.html).toBe('<div class="newsletter" style="background:#123456;color:white"><p>Hola</p></div>');
  });
});
