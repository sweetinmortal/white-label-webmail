import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailjetProvider } from '../worker/providers/mailjet';
import type { Env, MailConfig } from '../worker/types';
import type { OutboundMessage } from '../worker/providers/types';

const message: OutboundMessage = {
  id: 'provider-test',
  from: { email: 'contact@example.com', name: 'Example Company' },
  to: [{ email: 'archive@example.com', kind: 'to' }],
  subject: 'Provider contract',
  text: 'A test message',
  attachments: [],
  headers: {},
  customId: 'provider-test',
  archiveAddress: 'archive@example.com',
};
const env = { MAILJET_API_KEY: 'test-key', MAILJET_API_SECRET: 'test-secret' } as Env;
const archiveConfig: MailConfig = {
  brand: { name: 'Example Company', logo: '/logo.svg', primaryColor: '#0875d1', locale: 'es' },
  appOrigin: 'https://mail.example.com', mailbox: { id: 'primary', address: 'contact@example.com', name: 'Example Company' },
  archiveAddress: 'archive@example.com', allowedUsers: [], retentionDays: 90, cleanupEnabled: true,
  storageBudgetBytes: 1000, maxMessageBytes: 10000, maxComposeBytes: 10000, maxAttachments: 5, maxAttachmentBytes: 5 * 1024 * 1024, dailyRecipientLimit: 50, monthlyRecipientLimit: 500,
  mode: 'production', provider: 'mailjet', archiveCopies: { enabled: true, maxDecoratedBytes: 3 * 1024 * 1024 },
  accessTeamDomain: 'example.com', accessAudience: 'test',
};
const archivedMessage: OutboundMessage = {
  ...message,
  to: [
    { email: 'customer@example.net', kind: 'to' },
    { email: 'archive@example.com', kind: 'bcc' },
  ],
  archiveReplyToken: 'v1.opaque.reply-token',
};

function accepted(email: string, id: number) {
  return { Status: 'success', To: [{ Email: email, MessageID: id, MessageUUID: `uuid-${id}` }] };
}

afterEach(() => vi.unstubAllGlobals());

describe('Mailjet transport contract', () => {
  it('uses the case-sensitive Mailjet sender fields and disables tracking', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ Messages: [{
      Status: 'success',
      To: [{ Email: 'archive@example.com', MessageID: 123, MessageUUID: 'provider-uuid' }],
    }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await mailjetProvider.send(env, {} as MailConfig, message);
    expect(result.outcome).toBe('accepted');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.mailjet.com/v3.1/send');
    const payload = JSON.parse(init.body as string).Messages[0];
    expect(payload.From).toEqual({ Email: 'contact@example.com', Name: 'Example Company' });
    expect(payload.From).not.toHaveProperty('email');
    expect(payload.TrackOpens).toBe('disabled');
    expect(payload.TrackClicks).toBe('disabled');
  });

  it('rejects redirects without forwarding credentials or assuming rejection', async () => {
    const response = new Response('redirect', { status: 307, headers: { Location: 'https://other.example/send' } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response);
    vi.stubGlobal('fetch', fetchMock);
    const result = await mailjetProvider.send(env, {} as MailConfig, message);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: 'unknown', code: 'provider_redirect' });
    expect(result.recipients[0].status).toBe('unknown');
  });

  it('sends customer and private archive content in one call, with the notice only in the archive message', async () => {
    const fetchMock = vi.fn(async () => Response.json({ Messages: [
      accepted('customer@example.net', 101), accepted('archive@example.com', 102),
    ] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await mailjetProvider.send(env, archiveConfig, archivedMessage);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(result.recipients.map(({ email, status }) => ({ email, status }))).toEqual([
      { email: 'customer@example.net', status: 'accepted' }, { email: 'archive@example.com', status: 'accepted' },
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.Messages).toHaveLength(2);
    const [customer, archive] = payload.Messages;
    expect(customer.To).toEqual([{ Email: 'customer@example.net' }]);
    expect(customer.Bcc).toEqual([]);
    expect(customer.TextPart).toBe('A test message');
    expect(customer).not.toHaveProperty('HTMLPart');
    expect(customer.TextPart).not.toContain('Copia del correo enviado');
    expect(archive.To).toEqual([{ Email: 'archive@example.com' }]);
    expect(archive.Bcc).toEqual([]);
    expect(archive.TextPart.match(/Responder en el webmail:/g)).toHaveLength(1);
    expect(archive.TextPart).toContain('Copia archivada por Example Company. Remitente original: contact@example.com.');
    expect(archive.HTMLPart).toContain('Copia archivada por Example Company. Remitente original: contact@example.com.');
  });

  it('keeps a customer accepted when the archive message has a definite error', async () => {
    const fetchMock = vi.fn(async () => Response.json({ Messages: [
      accepted('customer@example.net', 201), { Status: 'error', Errors: [{ ErrorMessage: 'rejected' }] },
    ] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await mailjetProvider.send(env, archiveConfig, archivedMessage);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('definite_failure');
    expect(result.recipients.map(({ email, status }) => ({ email, status }))).toEqual([
      { email: 'customer@example.net', status: 'accepted' }, { email: 'archive@example.com', status: 'failed' },
    ]);
  });

  it.each([
    ['missing archive result', [accepted('customer@example.net', 301)]],
    ['changed customer recipient', [accepted('someone-else@example.net', 302), accepted('archive@example.com', 303)]],
  ])('returns unknown for %s without a second provider call', async (_label, messages) => {
    const fetchMock = vi.fn(async () => Response.json({ Messages: messages }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await mailjetProvider.send(env, archiveConfig, archivedMessage);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: 'unknown', code: 'provider_partial_response' });
    expect(result.recipients.find(({ email }) => email === 'customer@example.net')?.status).toBe('unknown');
  });
});
