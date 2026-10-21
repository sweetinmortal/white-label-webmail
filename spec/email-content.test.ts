import { describe, expect, it } from 'vitest';
import { parseEmailContent } from '../shared/email-content';

function rawMessage(): ArrayBuffer {
  const raw = [
    'From: Ana <ana@example.net>',
    'To: reader@example.net',
    'Subject: HTML con imagen',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '<html><body><p>Hola <b>equipo</b></p><img src="cid:logo@test"><img src="https://tracker.test/pixel.gif"><script>bad()</script></body></html>',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@test>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--rel--',
    '--mix',
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Disposition: attachment; filename="doc.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0=',
    '--mix',
    'Content-Type: image/png; name="other.png"',
    'Content-ID: <other@test>',
    'Content-Disposition: attachment; filename="other.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--mix--',
    '',
  ].join('\r\n');
  return new TextEncoder().encode(raw).buffer;
}

describe('parsed email content', () => {
  it('returns a sanitized HTML body, CID metadata, and ordinary attachments', async () => {
    const parsed = await parseEmailContent(rawMessage());

    expect(parsed.html).toContain('<p>Hola <b>equipo</b></p>');
    expect(parsed.html).toContain('cid:logo@test');
    expect(parsed.html).not.toContain('<script>');
    expect(parsed.bodyText).toContain('Hola equipo');
    expect(parsed.remoteImages).toBe(1);
    expect(parsed.attachments).toHaveLength(3);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'logo.png', mimeType: 'image/png', contentId: 'logo@test', inline: true });
    expect(parsed.attachments[1]).toMatchObject({ filename: 'doc.pdf', mimeType: 'application/pdf', inline: false });
    expect(parsed.attachments[2]).toMatchObject({ filename: 'other.png', mimeType: 'image/png', contentId: 'other@test', inline: false });
    expect(Array.from(new Uint8Array(parsed.attachments[0].content))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
