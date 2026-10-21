import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, MailConfig } from '../worker/types';
import { sendMessage } from '../worker/services/mail';
import { checkUsageAlerts, sendUsageAlertTest } from '../worker/services/usage-alerts';
import { claimUsageNotice, finishUsageNotice } from '../worker/store/usage-alerts';

vi.mock('../worker/services/mail', () => ({ sendMessage: vi.fn() }));

const ACCOUNT_ID = '11111111111111111111111111111111';
const TOKEN = 'test-token-must-not-leak';

function config(overrides: Record<string, unknown> = {}): MailConfig {
  return {
    brand: { name: 'Mi Empresa', logo: '/logo.svg', primaryColor: '#000', locale: 'es' },
    appOrigin: 'https://mail.example',
    mailbox: { id: 'Mi Empresa', address: 'contact@example.com', name: 'Mi Empresa' },
    archiveAddress: 'archive@example.com',
    allowedUsers: ['admin@example.com'],
    retentionDays: 180,
    cleanupEnabled: true,
    storageBudgetBytes: 1_000_000,
    maxMessageBytes: 25 * 1024 * 1024,
    maxComposeBytes: 100_000, maxAttachments: 5, maxAttachmentBytes: 5 * 1024 * 1024,
    dailyRecipientLimit: 100,
    monthlyRecipientLimit: 1000,
    mode: 'production',
    provider: 'mailjet',
    accessTeamDomain: 'example.com',
    accessAudience: 'audience',
    usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50 },
    ...overrides,
  } as MailConfig;
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CF_USAGE_API_TOKEN: TOKEN,
    ...overrides,
  } as Env;
}

function page(users: Array<Record<string, unknown>>, totalPages = 1): Response {
  return Response.json({ success: true, result_info: { total_pages: totalPages }, result: users });
}

function monthKeyNow(): string {
  const now = new Date();
  return `usage-alert:access-seats:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function testKeyNow(): string {
  return `usage-alert:test:access-seats:${new Date().toISOString().slice(0, 13)}`;
}

async function realDatabase(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] }));
  return { mf, db: await mf.getD1Database('DB') };
}

describe('checkUsageAlerts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    vi.mocked(sendMessage).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not fetch when alerts are disabled, credentials are missing, or the native binding is missing', async () => {
    const fetchMock = vi.mocked(fetch);
    await expect(checkUsageAlerts(env(), config({ usageAlerts: { enabled: false, thresholdPercent: 95, zeroTrustSeatLimit: 50 } })))
      .resolves.toEqual({ status: 'disabled' });
    await expect(checkUsageAlerts(env({ CF_USAGE_API_TOKEN: undefined }), config()))
      .resolves.toEqual({ status: 'unconfigured' });
    await expect(checkUsageAlerts(env(), config({ usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50, delivery: 'cloudflare' } })))
      .resolves.toEqual({ status: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('counts Access seats across bounded pages without returning user PII', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(page([
        { access_seat: true, gateway_seat: false, email: 'private-one@example.com' },
        { access_seat: true, gateway_seat: true, name: 'Private Person' },
        { access_seat: false, gateway_seat: true },
      ], 2))
      .mockResolvedValueOnce(page([
        { access_seat: true, gateway_seat: false, email: 'private-two@example.com' },
        { access_seat: false, gateway_seat: false },
      ], 2));

    const result = await checkUsageAlerts(env(), config());
    expect(result).toEqual({ status: 'below-threshold', used: 3, limit: 50 });
    expect(JSON.stringify(result)).not.toMatch(/private-one|private-two|Private Person/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${'https://api.cloudflare.com/client/v4/accounts/'}${ACCOUNT_ID}/access/users?per_page=1000&page=1`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${'https://api.cloudflare.com/client/v4/accounts/'}${ACCOUNT_ID}/access/users?per_page=1000&page=2`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not alert at 47/50 and starts at 48/50; legacy delivery keeps the monthly Mailjet key', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, index) => ({ access_seat: index < 47 }))))
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, index) => ({ access_seat: index < 48 }))))
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, index) => ({ access_seat: index < 48 }))));
    vi.mocked(sendMessage)
      .mockResolvedValueOnce({ id: 'alert-1', status: 'accepted', reused: false })
      .mockResolvedValueOnce({ id: 'alert-1', status: 'accepted', reused: true });

    await expect(checkUsageAlerts(env(), config())).resolves.toEqual({ status: 'below-threshold', used: 47, limit: 50 });
    await expect(checkUsageAlerts(env(), config())).resolves.toEqual({ status: 'notified', used: 48, limit: 50 });
    await expect(checkUsageAlerts(env(), config())).resolves.toEqual({ status: 'notified', used: 48, limit: 50 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(sendMessage).mock.calls[0];
    const secondCall = vi.mocked(sendMessage).mock.calls[1];
    expect(firstCall[2]).toEqual({ email: 'admin@example.com', mailboxIds: ['Mi Empresa'] });
    expect(firstCall[3].to).toEqual(['archive@example.com']);
    expect(firstCall[3].text).toContain('USO: 48/50');
    expect(firstCall[4]).toBe('usage-alert:access-seats:2026-10');
    expect(secondCall[4]).toBe(firstCall[4]);
  });

  it('uses the native binding and a real D1 claim, then reuses the accepted monthly notice', async () => {
    vi.useRealTimers();
    const { mf, db } = await realDatabase();
    try {
      vi.mocked(fetch).mockImplementation(async () => page(Array.from({ length: 50 }, (_, index) => ({ access_seat: index < 48 }))));
      const send = vi.fn(async () => ({ messageId: 'native-message-1' }));
      const nativeEnv = env({ DB: db, USAGE_ALERT_EMAIL: { send } });
      const nativeConfig = config({ usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50, delivery: 'cloudflare' } });

      await expect(checkUsageAlerts(nativeEnv, nativeConfig)).resolves.toEqual({ status: 'notified', used: 48, limit: 50 });
      await expect(checkUsageAlerts(nativeEnv, nativeConfig)).resolves.toEqual({ status: 'notified', used: 48, limit: 50 });

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith({
        from: 'contact@example.com', to: 'archive@example.com',
        subject: expect.stringContaining('95%'), text: expect.stringContaining('USO: 48/50'),
      });
      expect(send.mock.calls[0][0]).not.toHaveProperty('bcc');
      expect(sendMessage).not.toHaveBeenCalled();
      const row = await db.prepare('SELECT status, provider_id FROM mail_usage_alerts WHERE mailbox_id = ? AND idempotency_key = ?')
        .bind('Mi Empresa', monthKeyNow()).first<{ status: string; provider_id: string }>();
      expect(row).toEqual({ status: 'accepted', provider_id: 'native-message-1' });
    } finally { await mf.dispose(); }
  }, 30000);

  it('claims a key atomically in real SQLite D1 and reuses its accepted outcome', async () => {
    vi.useRealTimers();
    const { mf, db } = await realDatabase();
    try {
      const claims = await Promise.all([
        claimUsageNotice(db, 'Mi Empresa', 'usage-alert:concurrent'),
        claimUsageNotice(db, 'Mi Empresa', 'usage-alert:concurrent'),
      ]);
      expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
      expect(claims.filter((claim) => claim.kind === 'pending')).toHaveLength(1);
      await finishUsageNotice(db, 'Mi Empresa', 'usage-alert:concurrent', 'accepted', 'one-provider-id');
      await expect(claimUsageNotice(db, 'Mi Empresa', 'usage-alert:concurrent')).resolves.toEqual({ kind: 'accepted', providerId: 'one-provider-id' });
    } finally { await mf.dispose(); }
  }, 30000);

  it('holds an ambiguous native send as unknown and never automatically retries it', async () => {
    vi.useRealTimers();
    const { mf, db } = await realDatabase();
    try {
      vi.mocked(fetch).mockImplementation(async () => page(Array.from({ length: 48 }, () => ({ access_seat: true }))));
      const send = vi.fn(async () => { throw { code: 'E_DELIVERY_FAILED', message: `private address ${TOKEN}` }; });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const nativeEnv = env({ DB: db, USAGE_ALERT_EMAIL: { send } });
      const nativeConfig = config({ usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50, delivery: 'cloudflare' } });
      await expect(checkUsageAlerts(nativeEnv, nativeConfig)).resolves.toMatchObject({ status: 'pending', used: 48 });
      await expect(checkUsageAlerts(nativeEnv, nativeConfig)).resolves.toMatchObject({ status: 'pending', used: 48 });
      expect(send).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('usage_email_send_failed', { code: 'E_DELIVERY_FAILED' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
      const row = await db.prepare('SELECT status FROM mail_usage_alerts WHERE mailbox_id = ?')
        .bind('Mi Empresa').first<{ status: string }>();
      expect(row?.status).toBe('unknown');
    } finally { await mf.dispose(); }
  }, 30000);

  it('sends a manual PRUEBA below threshold using real count and fixed native destination, deduped once per hour', async () => {
    vi.useRealTimers();
    const { mf, db } = await realDatabase();
    try {
      vi.mocked(fetch).mockImplementation(async () => page([{ access_seat: true }]));
      const send = vi.fn(async () => ({ messageId: 'test-message-1' }));
      const nativeEnv = env({ DB: db, USAGE_ALERT_EMAIL: { send } });
      const nativeConfig = config({ usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50, delivery: 'cloudflare' } });
      await expect(sendUsageAlertTest(nativeEnv, nativeConfig)).resolves.toEqual({ status: 'notified', used: 1, limit: 50 });
      await expect(sendUsageAlertTest(nativeEnv, nativeConfig)).resolves.toEqual({ status: 'notified', used: 1, limit: 50 });
      expect(send).toHaveBeenCalledOnce();
      const input = send.mock.calls[0][0];
      expect(input.subject).toContain('PRUEBA');
      expect(input.text).toContain('no indica que se haya alcanzado el umbral');
      expect(input.text).toContain('USO real consultado: 1/50');
      expect(input.from).toBe('contact@example.com');
      expect(input.to).toBe('archive@example.com');
      expect(input).not.toHaveProperty('bcc');
      expect(sendMessage).not.toHaveBeenCalled();
      const row = await db.prepare('SELECT idempotency_key, status FROM mail_usage_alerts WHERE mailbox_id = ?')
        .bind('Mi Empresa').first<{ idempotency_key: string; status: string }>();
      expect(row).toEqual({ idempotency_key: testKeyNow(), status: 'accepted' });
    } finally { await mf.dispose(); }
  }, 30000);

  it('returns error without partial counts or sending on malformed, oversized, excessive-pagination, or HTTP failures', async () => {
    const fetchMock = vi.mocked(fetch);
    const cases: Array<() => Response> = [
      () => Response.json({ success: true, result_info: { total_pages: 1 }, result: [{ email: 'private@example.com' }] }),
      () => Response.json({ success: true, result_info: { total_pages: 11 }, result: [] }),
      () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
      () => new Response('upstream failure', { status: 503 }),
    ];
    for (const response of cases) {
      fetchMock.mockResolvedValueOnce(response());
      const result = await checkUsageAlerts(env(), config());
      expect(result).toEqual({ status: 'error' });
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('logs only a safe HTTP status and fixed D1 claim code without leaking response data or token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`private response ${TOKEN}`, {
      status: 503,
      headers: { 'x-private-diagnostic': TOKEN },
    }));
    await expect(checkUsageAlerts(env(), config())).resolves.toEqual({ status: 'error' });
    expect(warn).toHaveBeenLastCalledWith('usage_access_check_failed', { cause: 'http_error', httpStatus: 503 });

    vi.mocked(fetch).mockImplementation(async () => page(Array.from({ length: 48 }, () => ({ access_seat: true }))));
    const failingDb = { batch: vi.fn(async () => { throw new Error(`private SQL ${TOKEN}`); }) } as unknown as D1Database;
    const nativeConfig = config({ usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50, delivery: 'cloudflare' } });
    await expect(checkUsageAlerts(env({ DB: failingDb, USAGE_ALERT_EMAIL: { send: vi.fn() } }), nativeConfig))
      .resolves.toMatchObject({ status: 'error', used: 48, limit: 50 });
    expect(warn).toHaveBeenLastCalledWith('usage_notice_claim_failed', { code: 'db_claim_failed' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private response');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private SQL');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not return or log credentials or provider details when a page fails', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(page([{ access_seat: true }], 2)).mockRejectedValueOnce(new Error(TOKEN));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await checkUsageAlerts(env(), config());
    expect(result).toEqual({ status: 'error' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('runs the actual usage checker in workerd and reaches the mocked Access API', async () => {
    // The surrounding unit suite stubs Node's global fetch and clock; Miniflare
    // needs the real host fetch/timers to dispatch requests to its workerd VM.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const entry = fileURLToPath(new URL('../worker/services/usage-alerts.ts', import.meta.url));
    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      plugins: [{
        name: 'workerd-usage-alert-test-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/mail$/ }, () => ({ path: 'mail', namespace: 'usage-stub' }));
          builder.onResolve({ filter: /^\.\.\/store\/usage-alerts$/ }, () => ({ path: 'store', namespace: 'usage-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'usage-stub' }, ({ path }) => ({
            loader: 'js',
            contents: path === 'mail'
              ? 'export async function sendMessage() { globalThis.__usageMailCalls += 1; throw new Error("unexpected_mail_send"); }'
              : 'export async function claimUsageNotice() { throw new Error("unexpected_notice_claim"); } export async function finishUsageNotice() {}',
          }));
        },
      }],
    });
    const configForWorker = {
      mailbox: { id: 'test-mailbox', address: 'sender@example.test' },
      archiveAddress: 'archive@example.test',
      allowedUsers: ['operator@example.test'],
      usageAlerts: { enabled: true, thresholdPercent: 95, zeroTrustSeatLimit: 50 },
    };
    const script = `${bundled.outputFiles[0].text}\n` +
      `export default { async fetch(_request, env) { globalThis.__usageMailCalls = 0; ` +
      `const result = await checkUsageAlerts(env, ${JSON.stringify(configForWorker)}); ` +
      `return Response.json({ result, mailCalls: globalThis.__usageMailCalls }); } };`;
    const outboundRequests: string[] = [];
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2026-07-17',
      bindings: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CF_USAGE_API_TOKEN: TOKEN },
      outboundService: async (request) => {
        outboundRequests.push(request.url);
        return Response.json({
          success: true,
          result_info: { total_pages: 1 },
          result: [{ access_seat: true }],
        });
      },
    }));
    try {
      const response = await mf.dispatchFetch('http://localhost/usage-check');
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        result: { status: 'below-threshold', used: 1, limit: 50 },
        mailCalls: 0,
      });
      expect(outboundRequests).toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/users?per_page=1000&page=1`,
      ]);
    } finally {
      await mf.dispose();
    }
  }, 30000);

  it('maps ambiguous legacy outbox outcomes to pending and definite failure to error', async () => {
    vi.mocked(fetch).mockImplementation(async () => page(Array.from({ length: 48 }, () => ({ access_seat: true }))));
    vi.mocked(sendMessage)
      .mockResolvedValueOnce({ id: 'alert-1', status: 'unknown', reused: false })
      .mockResolvedValueOnce({ id: 'alert-1', status: 'failed', reused: true });
    await expect(checkUsageAlerts(env(), config())).resolves.toMatchObject({ status: 'pending', used: 48, limit: 50 });
    await expect(checkUsageAlerts(env(), config())).resolves.toMatchObject({ status: 'error', used: 48, limit: 50 });
  });
});
