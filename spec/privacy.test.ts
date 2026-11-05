import { describe, expect, it } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/types';

const env = { APP_ENV: 'production', COMPANY_CONFIG: JSON.stringify({
  brand: { name: 'Empresa <segura>' }, appOrigin: 'https://mail.company.example',
  mailbox: { address: 'contacto@company.example' }, archiveAddress: 'private-archive@gmail.com',
  allowedUsers: ['private-owner@gmail.com'], retentionDays: 180,
}) } as Env;
describe('public privacy disclosure boundary', () => {
  it('shows processing and retention without private archive, user or credential details', async () => {
    const response = await worker.fetch(new Request('https://mail.company.example/privacy'), env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Empresa &lt;segura&gt;');
    expect(html).toContain('180 días');
    expect(html).toContain('contacto@company.example');
    expect(html).not.toContain('private-archive');
    expect(html).not.toContain('private-owner');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('supports HEAD without a body and rejects writes', async () => {
    expect(await (await worker.fetch(new Request('https://mail.company.example/privacy', { method: 'HEAD' }), env)).text()).toBe('');
    expect((await worker.fetch(new Request('https://mail.company.example/privacy', { method: 'POST' }), env)).status).toBe(405);
  });
  it('continues to require authentication for mailbox APIs', async () => {
    const response = await worker.fetch(new Request('https://mail.company.example/api/inbox'), env);
    expect(response.status).toBe(503); // Deliberately no Access credentials in this public-page fixture.
    expect(await response.text()).not.toContain('private-archive');
  });
});
