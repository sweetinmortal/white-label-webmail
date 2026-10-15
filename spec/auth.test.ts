import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticate, authenticateWebhook, checkMutationOrigin } from '../worker/auth';
import { loadConfig } from '../worker/config';
import { AppError } from '../worker/errors';
import type { Env, MailConfig } from '../worker/types';

const mailbox = {
  id: 'contacto',
  address: 'contacto@company.example',
  name: 'Mi Empresa Systems',
};

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    COMPANY_CONFIG: JSON.stringify({
      brand: { name: 'Mi Empresa', logo: '/brand/logo.svg', primaryColor: '#0875d1', locale: 'es' },
      appOrigin: 'https://webmail.company.example',
      mailbox,
      archiveAddress: 'owner@example.net',
      allowedUsers: ['owner@example.net'],
      provider: 'mailjet',
    }),
    APP_ENV: 'production',
    ACCESS_TEAM_DOMAIN: 'qa-example-team.cloudflareaccess.com',
    ACCESS_AUD: 'webmail-audience',
    ...overrides,
  } as Env;
}

function localConfigEnv(overrides: Record<string, unknown> = {}): Env {
  return envWith({
    APP_ENV: 'local',
    COMPANY_CONFIG: JSON.stringify({
      brand: { name: 'Mi Empresa', logo: '/brand/logo.svg', primaryColor: '#0875d1', locale: 'es' },
      mailbox,
      archiveAddress: 'owner@example.net',
      allowedUsers: ['owner@example.net'],
      ...overrides,
    }),
    ACCESS_TEAM_DOMAIN: undefined,
    ACCESS_AUD: undefined,
  });
}

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

let issuerCounter = 0;
async function signedAccessToken(overrides: { email?: string; audience?: string; issuer?: string; expiration?: number } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = `qa-key-${++issuerCounter}`;
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const team = `qa-${issuerCounter}.cloudflareaccess.com`;
  const issuer = overrides.issuer ?? `https://${team}`;
  const audience = overrides.audience ?? 'webmail-audience';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${issuer}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch in auth test: ${url}`);
  }));
  const token = await new SignJWT({ email: overrides.email ?? 'owner@example.net' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
  return { token, team, audience };
}

function accessConfig(env: Env): MailConfig {
  return loadConfig(env);
}

function expectAppError(action: () => unknown, expected: { status: number; code: string }): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject(expected);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Access authentication boundaries', () => {
  it('accepts a real RS256 JWT only when JWKS, issuer, audience, exp and allowlist all match', async () => {
    const env = envWith();
    const config = accessConfig(env);
    const signed = await signedAccessToken();
    const identity = await authenticate(
      request('https://webmail.company.example/', { 'cf-access-jwt-assertion': signed.token }),
      { ...env, ACCESS_TEAM_DOMAIN: signed.team, ACCESS_AUD: signed.audience },
      { ...config, accessTeamDomain: signed.team, accessAudience: signed.audience },
    );
    expect(identity).toEqual({ email: 'owner@example.net', mailboxIds: ['contacto'] });
  });

  it('rejects an expired JWT even when its RSA signature is valid', async () => {
    const env = envWith();
    const config = accessConfig(env);
    const signed = await signedAccessToken({ expiration: Math.floor(Date.now() / 1000) - 30 });
    await expect(authenticate(
      request('https://webmail.company.example/', { 'cf-access-jwt-assertion': signed.token }),
      { ...env, ACCESS_TEAM_DOMAIN: signed.team, ACCESS_AUD: signed.audience },
      { ...config, accessTeamDomain: signed.team, accessAudience: signed.audience },
    )).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('rejects a validly signed token with the wrong audience or user', async () => {
    const env = envWith();
    const config = accessConfig(env);
    const wrongAudience = await signedAccessToken({ audience: 'other-audience' });
    await expect(authenticate(
      request('https://webmail.company.example/', { 'cf-access-jwt-assertion': wrongAudience.token }),
      { ...env, ACCESS_TEAM_DOMAIN: wrongAudience.team, ACCESS_AUD: 'webmail-audience' },
      { ...config, accessTeamDomain: wrongAudience.team, accessAudience: 'webmail-audience' },
    )).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

    const unauthorized = await signedAccessToken({ email: 'stranger@example.com' });
    await expect(authenticate(
      request('https://webmail.company.example/', { 'cf-access-jwt-assertion': unauthorized.token }),
      { ...env, ACCESS_TEAM_DOMAIN: unauthorized.team, ACCESS_AUD: unauthorized.audience },
      { ...config, accessTeamDomain: unauthorized.team, accessAudience: unauthorized.audience },
    )).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('does not trust the spoofable cf-access-authenticated-user-email header', async () => {
    const env = envWith();
    const config = accessConfig(env);
    await expect(authenticate(
      request('https://webmail.company.example/', { 'cf-access-authenticated-user-email': 'owner@example.net' }),
      env,
      config,
    )).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('allows local auth only on loopback and never uses DEV_AUTH_EMAIL in production', async () => {
    const localEnv = localConfigEnv({ DEV_AUTH_EMAIL: 'owner@example.net' });
    const localConfig = loadConfig(localEnv);
    await expect(authenticate(
      request('http://127.0.0.1:8788/'),
      localEnv,
      localConfig,
    )).resolves.toEqual({ email: 'owner@example.net', mailboxIds: ['contacto'] });
    await expect(authenticate(
      request('http://192.0.2.10:8788/'),
      localEnv,
      localConfig,
    )).rejects.toMatchObject({ status: 403, code: 'LOCAL_ONLY' });

    const productionEnv = envWith({ DEV_AUTH_EMAIL: 'owner@example.net' });
    const productionConfig = loadConfig(productionEnv);
    await expect(authenticate(
      request('https://webmail.company.example/'),
      productionEnv,
      productionConfig,
    )).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});

describe('CSRF origin and webhook authentication boundaries', () => {
  it('rejects missing, hostile, and cross-site mutation origins', () => {
    const config = loadConfig(envWith());
    expect(() => checkMutationOrigin(request('https://webmail.company.example/'), config))
      .toThrowError(new AppError(403, 'ORIGIN_REJECTED', 'La solicitud no procede de este webmail.'));
    expectAppError(() => checkMutationOrigin(request('https://webmail.company.example/', { origin: 'https://evil.example' }), config), {
      status: 403, code: 'ORIGIN_REJECTED',
    });
    expectAppError(() => checkMutationOrigin(request('https://webmail.company.example/', {
      origin: config.appOrigin,
      'sec-fetch-site': 'cross-site',
    }), config), { status: 403, code: 'ORIGIN_REJECTED' });
    expect(() => checkMutationOrigin(request('https://webmail.company.example/', {
      origin: config.appOrigin,
      'sec-fetch-site': 'same-origin',
    }), config)).not.toThrow();
  });

  it('accepts valid webhook Basic credentials and rejects altered credentials', async () => {
    const password = 'a'.repeat(24);
    const env = { MAILJET_WEBHOOK_USER: 'mailjet-hook', MAILJET_WEBHOOK_PASSWORD: password } as Env;
    const valid = `Basic ${btoa(`mailjet-hook:${password}`)}`;
    await expect(authenticateWebhook(request('https://webmail.company.example/webhooks/mailjet', { authorization: valid }), env)).resolves.toBeUndefined();
    await expect(authenticateWebhook(request('https://webmail.company.example/webhooks/mailjet', {
      authorization: `Basic ${btoa(`mailjet-hook:${'b'.repeat(24)}`)}`,
    }), env)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('fails closed when webhook secrets are missing or too short', async () => {
    await expect(authenticateWebhook(request('https://webmail.company.example/webhooks/mailjet'), {} as Env))
      .rejects.toMatchObject({ status: 503, code: 'WEBHOOK_NOT_CONFIGURED' });
    await expect(authenticateWebhook(request('https://webmail.company.example/webhooks/mailjet'), {
      MAILJET_WEBHOOK_USER: 'mailjet-hook', MAILJET_WEBHOOK_PASSWORD: 'short',
    } as Env)).rejects.toMatchObject({ status: 503, code: 'WEBHOOK_NOT_CONFIGURED' });
  });
});

describe('production configuration boundaries', () => {
  it('rejects an unavailable provider, a self-archive address, and out-of-range budgets', () => {
    const invalids = [
      { provider: 'sendgrid' },
      { archiveAddress: mailbox.address },
      { storageBudgetBytes: 1048575 },
      { maxMessageBytes: 26214401 },
      { dailyRecipientLimit: 201 },
      { monthlyRecipientLimit: 6001 },
    ];
    for (const override of invalids) {
      const config = JSON.parse(envWith().COMPANY_CONFIG!);
      Object.assign(config, override);
      const env = envWith({ COMPANY_CONFIG: JSON.stringify(config) });
      expectAppError(() => loadConfig(env), { status: 503, code: 'CONFIG_INVALID' });
    }
  });

  it('rejects external or data URLs as brand logos', () => {
    for (const logo of ['https://evil.example/logo.svg', 'data:image/svg+xml;base64,abc', '../logo.svg']) {
      const config = JSON.parse(envWith().COMPANY_CONFIG!);
      config.brand.logo = logo;
      expectAppError(() => loadConfig(envWith({ COMPANY_CONFIG: JSON.stringify(config) })), {
        status: 503, code: 'CONFIG_INVALID',
      });
    }
  });

  it('enforces the Access-sized allowlist and HTTPS production origin', () => {
    const config = JSON.parse(envWith().COMPANY_CONFIG!);
    config.allowedUsers = Array.from({ length: 51 }, (_, index) => `user${index}@example.com`);
    expectAppError(() => loadConfig(envWith({ COMPANY_CONFIG: JSON.stringify(config) })), {
      status: 503, code: 'CONFIG_INVALID',
    });
    config.allowedUsers = ['owner@example.net'];
    config.appOrigin = 'http://webmail.company.example';
    expectAppError(() => loadConfig(envWith({ COMPANY_CONFIG: JSON.stringify(config) })), {
      status: 503, code: 'CONFIG_INVALID',
    });
  });
});
