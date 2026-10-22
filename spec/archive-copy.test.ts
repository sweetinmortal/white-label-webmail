import { describe, expect, it } from 'vitest';
import { archiveCopyContent } from '../worker/services/archive-copy';
import type { MailConfig } from '../worker/types';

function config(overrides: Partial<MailConfig> = {}): MailConfig {
  return {
    brand: { name: 'Equipo', logo: '/logo.svg', primaryColor: '#0875d1', locale: 'es' },
    appOrigin: 'https://mail.example.com:8443',
    mailbox: { id: 'primary', address: 'inbox@example.com', name: 'Equipo' },
    archiveAddress: 'archive@example.com', allowedUsers: [], retentionDays: 90, cleanupEnabled: true,
    storageBudgetBytes: 1000, maxMessageBytes: 10000, maxComposeBytes: 10000, maxAttachments: 5, maxAttachmentBytes: 5 * 1024 * 1024,
    dailyRecipientLimit: 50, monthlyRecipientLimit: 500, mode: 'production', provider: 'mailjet',
    archiveCopies: { enabled: true, maxDecoratedBytes: 3 * 1024 * 1024 }, accessTeamDomain: 'example.com', accessAudience: 'test',
    ...overrides,
  };
}

describe('archive copy content', () => {
  it('builds the link from the configured origin and keeps it in the plaintext alternative', () => {
    const token = 'v1.header.payload';
    const copy = archiveCopyContent(config(), {
      direction: 'incoming', token, subject: 'Actualización', sender: 'sender@example.net', recipients: ['inbox@example.com'],
    });

    expect(copy.text).toContain('https://mail.example.com:8443/?reply=v1.header.payload');
    expect(copy.html).toContain('href="https://mail.example.com:8443/?reply=v1.header.payload"');
    expect(copy.text).toContain('Copia archivada por Equipo. Remitente original: sender@example.net.');
    expect(copy.text).not.toContain('Copia del correo recibido');
  });

  it('escapes hostile brand name, sender name, subject, recipients, and body in HTML', () => {
    const copy = archiveCopyContent(config({ brand: { name: '<script>alert(1)</script>', logo: '/logo.svg', primaryColor: '#0875d1', locale: 'es' } }), {
      direction: 'outgoing', token: 'opaque-token',
      subject: '<script>subject()</script> & "quoted"',
      sender: 'Equipo <img src=x onerror=alert(1)>',
      recipients: ['person@example.net <svg onload=alert(1)>'],
      text: '<svg onload=alert(1)> & \'plain text\'',
    });

    expect(copy.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(copy.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(copy.html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(copy.html).toContain('&amp; &quot;quoted&quot;');
    expect(copy.html).toContain('&#39;plain text&#39;');
    expect(copy.html).not.toContain('<script>alert(1)</script>');
    expect(copy.html).not.toContain('<img src=x');
    expect(copy.html).not.toContain('<svg onload=');
    expect(copy.html).toContain('&lt;script&gt;subject()&lt;/script&gt;');
  });
});
