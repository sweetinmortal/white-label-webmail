import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../worker/errors';
import type { Env, Identity } from '../worker/types';

const mocks = vi.hoisted(() => ({
  auth: {
    authenticate: vi.fn(),
    authenticateWebhook: vi.fn(),
    checkMutationOrigin: vi.fn(),
  },
  service: {
    cleanup: vi.fn(),
    getCacheUsage: vi.fn(),
    getMessage: vi.fn(),
    getOutgoingAttachment: vi.fn(),
    getRaw: vi.fn(),
    listMessages: vi.fn(),
    processWebhook: vi.fn(),
    receiveEmail: vi.fn(),
    sendMessage: vi.fn(),
    setRead: vi.fn(),
  },
  dev: {
    seedLocal: vi.fn(),
  },
  usageAlerts: {
    checkUsageAlerts: vi.fn(),
    sendUsageAlertTest: vi.fn(),
  },
}));

vi.mock('../worker/auth', () => mocks.auth);
vi.mock('../worker/services/mail', () => mocks.service);
vi.mock('../worker/dev', () => mocks.dev);
vi.mock('../worker/services/usage-alerts', () => mocks.usageAlerts);

import worker from '../worker/index';

const identity: Identity = { email: 'owner@example.net', mailboxIds: ['contacto'] };

const productionCompany = {
  brand: { name: 'Mi Empresa', logo: '/brand/logo.svg', primaryColor: '#0875d1', locale: 'es' },
  appOrigin: 'https://webmail.company.example',
  mailbox: { id: 'contacto', address: 'contacto@company.example', name: 'Mi Empresa Systems' },
  archiveAddress: 'owner@example.net',
  allowedUsers: ['owner@example.net'],
  provider: 'mailjet',
  cleanupEnabled: true,
};

function env(overrides: Partial<Env> = {}, companyOverrides: Record<string, unknown> = {}): Env {
  return {
    APP_ENV: 'production',
    COMPANY_CONFIG: JSON.stringify({ ...productionCompany, ...companyOverrides }),
    ACCESS_TEAM_DOMAIN: 'qa-company.cloudflareaccess.com',
    ACCESS_AUD: 'webmail-audience',
    MAILJET_WEBHOOK_USER: 'hook-user',
    MAILJET_WEBHOOK_PASSWORD: 'a'.repeat(24),
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) } as unknown as Fetcher,
    ...overrides,
  } as Env;
}

function jsonRequest(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://webmail.company.example${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      origin: 'https://webmail.company.example',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function localEnv(): Env {
  return env({ APP_ENV: 'local' }, {
    appOrigin: 'http://127.0.0.1:8788',
    provider: 'local',
    cleanupEnabled: false,
  });
}

function emailMessage() {
  return {
    from: 'sender@example.com',
    to: 'contacto@company.example',
    raw: new Response('raw email').body!,
    rawSize: 9,
    headers: new Headers({ subject: 'Test', from: 'sender@example.com', to: 'contacto@company.example' }),
    forward: vi.fn(async () => undefined),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage & { forward: ReturnType<typeof vi.fn>; setReject: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.authenticate.mockResolvedValue(identity);
  mocks.auth.authenticateWebhook.mockResolvedValue(undefined);
  mocks.auth.checkMutationOrigin.mockImplementation(() => undefined);
  mocks.service.getCacheUsage.mockResolvedValue({ usedBytes: 0, budgetBytes: 2_000_000_000, paused: false });
  mocks.service.listMessages.mockResolvedValue({ items: [], nextCursor: null });
  mocks.service.getMessage.mockResolvedValue({ id: 'm1' });
  mocks.service.getRaw.mockReturnValue(new Response('raw message', { headers: { 'content-type': 'message/rfc822' } }));
  mocks.service.getOutgoingAttachment.mockReturnValue(new Response('attachment', { headers: { 'content-type': 'image/png' } }));
  mocks.service.sendMessage.mockResolvedValue({ id: 'm1', status: 'accepted', reused: false });
  mocks.service.processWebhook.mockResolvedValue(undefined);
  mocks.service.receiveEmail.mockResolvedValue(undefined);
  mocks.service.cleanup.mockResolvedValue({ deleted: 0, held: 0 });
  mocks.dev.seedLocal.mockResolvedValue(undefined);
  mocks.usageAlerts.checkUsageAlerts.mockResolvedValue({ status: 'disabled' });
  mocks.usageAlerts.sendUsageAlertTest.mockResolvedValue({ status: 'notified', used: 1, limit: 50 });
});

describe('API router ordering and boundary enforcement', () => {
  it('authenticates before any inbox/session read reaches the service layer', async () => {
    mocks.auth.authenticate.mockRejectedValue(new AppError(401, 'UNAUTHENTICATED', 'login required'));
    const response = await worker.fetch(jsonRequest('/api/inbox'), env());
    expect(response.status).toBe(401);
    expect(mocks.service.listMessages).not.toHaveBeenCalled();
    expect(mocks.service.getCacheUsage).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns only the enabled threshold and seat limit needed by the alert button', async () => {
    const response = await worker.fetch(jsonRequest('/api/session'), env({}, {
      usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50, delivery: 'cloudflare' },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { usageAlerts: unknown };
    expect(body.usageAlerts).toEqual({ enabled: true, thresholdPercent: 95, limit: 50 });
  });

  it('requires origin validation for send and read-state mutations before service calls', async () => {
    mocks.auth.checkMutationOrigin.mockImplementation(() => {
      throw new AppError(403, 'ORIGIN_REJECTED', 'bad origin');
    });
    const send = await worker.fetch(jsonRequest('/api/send', 'POST', {
      to: ['recipient@example.com'], subject: 'Hi', text: 'Hello',
    }, { 'idempotency-key': 'attempt_1234567890' }), env());
    const read = await worker.fetch(jsonRequest('/api/messages/m1/read', 'PATCH', { read: true }), env());
    expect(send.status).toBe(403);
    expect(read.status).toBe(403);
    expect(mocks.service.sendMessage).not.toHaveBeenCalled();
    expect(mocks.service.setRead).not.toHaveBeenCalled();
    expect(mocks.auth.checkMutationOrigin).toHaveBeenCalledTimes(2);
  });

  it('protects the usage-alert test endpoint with authentication and mutation-origin checks', async () => {
    const accepted = await worker.fetch(jsonRequest('/api/usage-alerts/test', 'POST', { to: ['attacker@example.com'], thresholdPercent: 1 }), env());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ status: 'notified', used: 1, limit: 50 });
    expect(mocks.auth.checkMutationOrigin).toHaveBeenCalledOnce();
    expect(mocks.usageAlerts.sendUsageAlertTest).toHaveBeenCalledOnce();
    expect(mocks.usageAlerts.sendUsageAlertTest.mock.calls[0]).toHaveLength(2);

    const get = await worker.fetch(jsonRequest('/api/usage-alerts/test', 'GET'), env());
    expect(get.status).toBe(404);
    expect(mocks.usageAlerts.sendUsageAlertTest).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.auth.authenticate.mockRejectedValue(new AppError(401, 'UNAUTHENTICATED', 'login required'));
    const unauthenticated = await worker.fetch(jsonRequest('/api/usage-alerts/test', 'POST', { to: ['attacker@example.com'] }), env());
    expect(unauthenticated.status).toBe(401);
    expect(mocks.auth.checkMutationOrigin).not.toHaveBeenCalled();
    expect(mocks.usageAlerts.sendUsageAlertTest).not.toHaveBeenCalled();
  });

  it('rejects a usage-alert test when the request origin check fails', async () => {
    mocks.auth.checkMutationOrigin.mockImplementation(() => {
      throw new AppError(403, 'ORIGIN_REJECTED', 'bad origin');
    });
    const response = await worker.fetch(jsonRequest('/api/usage-alerts/test', 'POST'), env());
    expect(response.status).toBe(403);
    expect(mocks.usageAlerts.sendUsageAlertTest).not.toHaveBeenCalled();
  });

  it('keeps webhook Basic authentication independent from Access authentication', async () => {
    mocks.auth.authenticate.mockRejectedValue(new AppError(401, 'UNAUTHENTICATED', 'no Access JWT'));
    const response = await worker.fetch(jsonRequest('/api/webhooks/mailjet', 'POST', [{ event: 'sent' }], {
      authorization: 'Basic dGVzdDp0ZXN0',
    }), env());
    expect(response.status).toBe(200);
    expect(mocks.auth.authenticateWebhook).toHaveBeenCalledOnce();
    expect(mocks.auth.authenticate).not.toHaveBeenCalled();
    expect(mocks.service.processWebhook).toHaveBeenCalledOnce();
  });

  it('does not expose local seed in production, even after Access authentication', async () => {
    const response = await worker.fetch(jsonRequest('/api/dev/seed', 'POST', {}), env());
    expect(response.status).toBe(404);
    expect(mocks.dev.seedLocal).not.toHaveBeenCalled();
  });

  it('routes attachment downloads by index and rejects other methods', async () => {
    const response = await worker.fetch(jsonRequest('/api/messages/m1/attachments/0'), env());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('attachment');
    expect(mocks.service.getOutgoingAttachment).toHaveBeenCalledWith(expect.anything(), expect.anything(), identity, 'm1', 0);

    const rejected = await worker.fetch(jsonRequest('/api/messages/m1/attachments/0', 'POST'), env());
    expect(rejected.status).toBe(405);
    expect(mocks.service.getOutgoingAttachment).toHaveBeenCalledOnce();
  });

  it('applies security headers to successful raw-message responses', async () => {
    const response = await worker.fetch(jsonRequest('/api/messages/m1/raw'), env());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('raw message');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('email and scheduled handlers', () => {
  it('rejects malformed production configuration without forwarding', async () => {
    const message = emailMessage();
    await worker.email(message, env({ COMPANY_CONFIG: '{invalid json' }));
    expect(message.setReject).toHaveBeenCalledWith('Mailbox configuration unavailable.');
    expect(message.forward).not.toHaveBeenCalled();
    expect(mocks.service.receiveEmail).not.toHaveBeenCalled();
  });

  it('rejects local configuration on the email trigger without forwarding', async () => {
    const message = emailMessage();
    await worker.email(message, localEnv());
    expect(message.setReject).toHaveBeenCalledWith('Local-only configuration cannot receive real email.');
    expect(message.forward).not.toHaveBeenCalled();
    expect(mocks.service.receiveEmail).not.toHaveBeenCalled();
  });

  it('honors cleanupEnabled in scheduled invocations', async () => {
    await worker.scheduled({} as ScheduledController, localEnv());
    expect(mocks.service.cleanup).not.toHaveBeenCalled();

    await worker.scheduled({} as ScheduledController, env({}, { cleanupEnabled: true }));
    expect(mocks.service.cleanup).toHaveBeenCalledOnce();
  });
});
