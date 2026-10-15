import { describe, expect, it } from 'vitest';
import { archiveReplyContext, assertArchiveLinkKey, openArchiveReply, sealArchiveReply } from '../worker/services/archive-links';
import type { Env, MailConfig } from '../worker/types';

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');

function config(overrides: Partial<MailConfig> = {}): MailConfig {
  return {
    brand: { name: 'Mi Empresa', logo: '/logo.svg', primaryColor: '#0875d1', locale: 'es' },
    appOrigin: 'https://mail.example.com',
    mailbox: { id: 'primary', address: 'inbox@example.com', name: 'Equipo' },
    archiveAddress: 'archive@example.com',
    allowedUsers: [], retentionDays: 90, cleanupEnabled: true, storageBudgetBytes: 1000,
    maxMessageBytes: 10000, maxComposeBytes: 10000, dailyRecipientLimit: 50, monthlyRecipientLimit: 500,
    mode: 'production', provider: 'mailjet', archiveCopies: { enabled: true, maxDecoratedBytes: 3 * 1024 * 1024 },
    accessTeamDomain: 'example.com', accessAudience: 'test', ...overrides,
  };
}

const env = (archiveKey = key) => ({ ARCHIVE_LINK_KEY: archiveKey } as Env);
const reply = {
  direction: 'incoming' as const,
  to: ['maria@example.com'],
  cc: ['copias@example.com'],
  subject: 'Re: propuesta para el sitio — acción: revisar',
  inReplyTo: '<mensaje-actual@example.com>',
  references: ['<mensaje-anterior@example.com>'],
};

describe('archive reply links', () => {
  it('round-trips UTF-8 reply data without exposing email addresses in the token', async () => {
    const token = await sealArchiveReply(env(), config(), reply);
    expect(await openArchiveReply(env(), config(), token)).toEqual(reply);
    expect(token).not.toContain('maria@example.com');
    expect(token).not.toContain('copias@example.com');
    expect(await archiveReplyContext(env(), config(), token)).toEqual({
      token, to: reply.to, cc: reply.cc, subject: reply.subject, direction: 'incoming',
    });
  });

  it('rejects tampered, malformed, wrong-key, and wrong-tenant tokens', async () => {
    const token = await sealArchiveReply(env(), config(), reply);
    const parts = token.split('.');
    const last = parts[2].at(-1)!;
    parts[2] = `${parts[2].slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    const tampered = parts.join('.');

    const cases: Array<[string, Env, MailConfig, unknown]> = [
      ['tampered ciphertext', env(), config(), tampered],
      ['malformed encoding', env(), config(), 'v1.!.not_base64'],
      ['wrong key', env(Buffer.from(new Uint8Array(32).fill(9)).toString('base64url')), config(), token],
      ['wrong origin', env(), config({ appOrigin: 'https://other.example.com' }), token],
      ['wrong mailbox', env(), config({ mailbox: { id: 'another-mailbox', address: 'other@example.com', name: 'Other' } }), token],
    ];
    for (const [label, testEnv, testConfig, candidate] of cases) {
      await expect(openArchiveReply(testEnv, testConfig, candidate), label).rejects.toMatchObject({ code: 'ARCHIVE_LINK_INVALID' });
    }
  });

  it('requires a configured 32-byte key in production', () => {
    expect(() => assertArchiveLinkKey({} as Env, config())).toThrowError(expect.objectContaining({ code: 'ARCHIVE_LINK_NOT_CONFIGURED' }));
    expect(() => assertArchiveLinkKey({ ARCHIVE_LINK_KEY: 'too-short' } as Env, config())).toThrowError(expect.objectContaining({ code: 'ARCHIVE_LINK_NOT_CONFIGURED' }));
  });
});
