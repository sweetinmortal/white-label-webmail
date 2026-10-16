import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readFile } from 'node:fs/promises';
import { authenticate } from '../worker/auth';
import { authenticateGoogle, cleanupGoogleAuth, GOOGLE_FLOW_COOKIE, GOOGLE_SESSION_COOKIE, handleGoogleAuth } from '../worker/google-auth';
import { loadConfig } from '../worker/config';
import type { Env, MailConfig } from '../worker/types';
import worker from '../worker/index';

const APP_ORIGIN = 'https://mail.company.example';
const CLIENT_ID = '123456789012-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-google-client-secret-for-tests-000000';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const KEY_ID = 'google-test-key';
let mf: Miniflare;
let db: D1Database;
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

function fixture(options: { clientId?: string; clientSecret?: string; allowedUsers?: string[]; appOrigin?: string; mailboxId?: string } = {}): { env: Env; config: MailConfig } {
  const env = {
    DB: db,
    ASSETS: {} as Fetcher,
    APP_ENV: 'production',
    GOOGLE_CLIENT_ID: options.clientId ?? CLIENT_ID,
    GOOGLE_CLIENT_SECRET: options.clientSecret ?? CLIENT_SECRET,
    COMPANY_CONFIG: JSON.stringify({
      brand: { name: 'Mi Empresa', logo: '/brand/logo.svg', primaryColor: '#0875d1', locale: 'es' },
      appOrigin: options.appOrigin ?? APP_ORIGIN,
      mailbox: { id: options.mailboxId ?? 'company', address: 'contacto@company.example', name: 'Mi Empresa' },
      archiveAddress: 'archive@example.net',
      allowedUsers: options.allowedUsers ?? ['owner@gmail.com', 'admin@company.example'],
      provider: 'mailjet',
      auth: { provider: 'google' },
    }),
  } as Env;
  return { env, config: loadConfig(env) };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, init);
}

function startRequest(env: Env, config: MailConfig, returnTo?: unknown, origin = APP_ORIGIN): Promise<Response | null> {
  return handleGoogleAuth(request('/api/auth/google/start', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(returnTo === undefined ? {} : { returnTo }),
  }), env, config);
}

function cookieValue(response: Response, name: string): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${name}=([^;,]*)`).exec(raw);
  return match?.[1] ?? '';
}

function cookieHeader(name: string, value: string): string {
  return `${name}=${value}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function beginFlow(returnTo = '/inbox?search=hello#latest') {
  const { env, config } = fixture();
  const response = await startRequest(env, config, returnTo);
  expect(response?.status).toBe(200);
  const body = await response!.json() as { url: string };
  const authorization = new URL(body.url);
  const state = authorization.searchParams.get('state')!;
  const nonce = authorization.searchParams.get('nonce')!;
  const flowCookie = cookieValue(response!, GOOGLE_FLOW_COOKIE);
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(flowCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { env, config, response: response!, authorization, state, nonce, flowCookie, returnTo };
}

function installGoogleFetch(idToken: string) {
  const publicKeyJwk = { ...publicJwk, kid: KEY_ID, alg: 'RS256', use: 'sig' };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === TOKEN_ENDPOINT) {
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ id_token: idToken }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === JWKS_ENDPOINT) {
      return new Response(JSON.stringify({ keys: [publicKeyJwk] }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected Google auth network request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function signedIdToken(options: {
  nonce: string;
  email?: string;
  emailVerified?: boolean;
  issuer?: string;
  audience?: string;
  subject?: string;
  issuedAt?: number;
  expiresAt?: number;
  hd?: string;
  omitEmailVerified?: boolean;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    email: options.email ?? 'owner@gmail.com',
    nonce: options.nonce,
    ...(options.omitEmailVerified ? {} : { email_verified: options.emailVerified ?? true }),
    ...(options.hd === undefined ? {} : { hd: options.hd }),
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject(options.subject ?? 'synthetic-google-subject')
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
}

async function callback(flow: Awaited<ReturnType<typeof beginFlow>>, code = 'synthetic-auth-code', flowCookie = flow.flowCookie): Promise<Response | null> {
  const url = `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`;
  return handleGoogleAuth(request(url, { headers: { cookie: cookieHeader(GOOGLE_FLOW_COOKIE, flowCookie) } }), flow.env, flow.config);
}

async function sessionCount(): Promise<number> {
  const result = await db.prepare('SELECT COUNT(*) AS count FROM mail_auth_sessions').first<{ count: number }>();
  return result!.count;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  }));
  db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('../migrations/0004_auth.sql', import.meta.url), 'utf8');
  const statements = migration.replace(/^\s*--.*$/gm, '').split(';').map(statement => statement.trim()).filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey) as Record<string, unknown>;
});

beforeEach(async () => {
  await Promise.all([
    db.prepare('DELETE FROM mail_auth_transactions').run(),
    db.prepare('DELETE FROM mail_auth_sessions').run(),
  ]);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await mf.dispose(); });

describe('Google sign-in setup and CSRF boundaries', () => {
  it('reports the configured public provider and starts a PKCE flow with one-use state and a host-only flow cookie', async () => {
    const flow = await beginFlow();
    const { authorization, state, flowCookie } = flow;
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')).toBe('openid email');

    const options = await handleGoogleAuth(request('/api/auth/options'), flow.env, flow.config);
    expect(await options!.json()).toMatchObject({ provider: 'google', brand: { name: 'Mi Empresa' } });

    const transaction = await db.prepare('SELECT * FROM mail_auth_transactions WHERE state_hash = ?')
      .bind(await sha256Hex(state)).first<Record<string, unknown>>();
    expect(transaction).toMatchObject({ return_to: flow.returnTo });
    expect(transaction?.state_hash).not.toBe(state);
    expect(transaction?.browser_hash).toBe(await sha256Hex(flowCookie));
    expect(transaction?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction?.nonce).toBe(authorization.searchParams.get('nonce'));
    const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transaction!.verifier as string)))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(authorization.searchParams.get('code_challenge')).toBe(expectedChallenge);
    const flowCookieHeader = flow.response.headers.get('set-cookie') ?? '';
    expect(flowCookieHeader).toContain('HttpOnly');
    expect(flowCookieHeader).toContain('Secure');
    expect(flowCookieHeader).toContain('SameSite=Lax');
    expect(flowCookieHeader).not.toContain('Domain=');
  });

  it('rejects cross-origin starts and external or API return paths without creating a transaction', async () => {
    const { env, config } = fixture();
    await expect(startRequest(env, config, '/', 'https://attacker.example'))
      .rejects.toMatchObject({ status: 403, code: 'ORIGIN_REJECTED' });
    for (const returnTo of ['https://attacker.example/steal', '//attacker.example/path', '/api/session', '/\\attacker.example']) {
      await expect(startRequest(env, config, returnTo)).rejects.toMatchObject({ status: 400, code: 'INVALID_RETURN_PATH' });
    }
    const count = await db.prepare('SELECT COUNT(*) AS count FROM mail_auth_transactions').first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('fails closed if the Google client configuration is incomplete and enforces the per-installation start cap', async () => {
    const incomplete = fixture({ clientId: '' });
    await expect(startRequest(incomplete.env, incomplete.config)).rejects.toMatchObject({ status: 503, code: 'GOOGLE_NOT_CONFIGURED' });
    const missingSecret = fixture({ clientSecret: '' });
    await expect(startRequest(missingSecret.env, missingSecret.config)).rejects.toMatchObject({ status: 503, code: 'GOOGLE_NOT_CONFIGURED' });

    const { env, config } = fixture();
    for (let index = 0; index < 10; index++) await startRequest(env, config);
    await expect(startRequest(env, config)).rejects.toMatchObject({ status: 429, code: 'AUTH_RATE_LIMITED' });
  });
});

describe('Google callback validation and session lifecycle', () => {
  it('binds state to the browser cookie, exchanges the PKCE verifier, stores only a session hash, and consumes state once', async () => {
    const flow = await beginFlow('/inbox?filter=unread#top');
    const otherFlow = await beginFlow('/');
    const idToken = await signedIdToken({ nonce: flow.nonce });
    const fetchMock = installGoogleFetch(idToken);

    const wrongBrowser = await callback(flow, 'synthetic-code', otherFlow.flowCookie);
    expect(new URL(wrongBrowser!.headers.get('location')!).searchParams.get('authError')).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();

    const transaction = await db.prepare('SELECT verifier FROM mail_auth_transactions WHERE state_hash = ?')
      .bind(await sha256Hex(flow.state)).first<{ verifier: string }>();
    const success = await callback(flow);
    expect(success?.status).toBe(303);
    expect(success?.headers.get('location')).toBe(`${APP_ORIGIN}${flow.returnTo}`);
    const sessionToken = cookieValue(success!, GOOGLE_SESSION_COOKIE);
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(success!.headers.get('set-cookie')).toContain('HttpOnly');
    expect(success!.headers.get('set-cookie')).toContain('Secure');
    expect(success!.headers.get('set-cookie')).toContain('SameSite=Lax');

    const form = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(form.get('code_verifier')).toBe(transaction?.verifier);
    expect(form.get('code')).toBe('synthetic-auth-code');
    const storedSession = await db.prepare('SELECT * FROM mail_auth_sessions WHERE token_hash = ?')
      .bind(await sha256Hex(sessionToken)).first<Record<string, unknown>>();
    expect(storedSession).toMatchObject({
      email: 'owner@gmail.com', subject: 'synthetic-google-subject',
      auth_context: JSON.stringify([flow.config.appOrigin, flow.config.googleClientId, flow.config.mailbox.id]),
    });
    expect(storedSession?.token_hash).not.toBe(sessionToken);
    await expect(authenticateGoogle(request('/', { headers: { cookie: cookieHeader(GOOGLE_SESSION_COOKIE, sessionToken) } }), flow.env, flow.config))
      .resolves.toEqual({ email: 'owner@gmail.com', mailboxIds: ['company'] });

    const otherClient = fixture({ clientId: '987654321098-other.apps.googleusercontent.com' });
    const sessionCookie = cookieHeader(GOOGLE_SESSION_COOKIE, sessionToken);
    const originalRequest = request('/', { headers: { cookie: sessionCookie } });
    await expect(authenticateGoogle(originalRequest, otherClient.env, otherClient.config))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

    const otherClientLogout = await handleGoogleAuth(request('/api/auth/logout', {
      method: 'POST', headers: { origin: APP_ORIGIN, cookie: sessionCookie },
    }), otherClient.env, otherClient.config);
    expect(otherClientLogout?.status).toBe(204);
    await expect(authenticateGoogle(originalRequest, flow.env, flow.config)).resolves.toMatchObject({ email: 'owner@gmail.com' });

    const otherOrigin = fixture({ appOrigin: 'https://mail.other-company.example' });
    await expect(authenticateGoogle(new Request(`${otherOrigin.config.appOrigin}/`, { headers: { cookie: sessionCookie } }), otherOrigin.env, otherOrigin.config))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    const otherMailbox = fixture({ mailboxId: 'other-company' });
    await expect(authenticateGoogle(originalRequest, otherMailbox.env, otherMailbox.config))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(await sessionCount()).toBe(1);

    const replay = await callback(flow);
    expect(replay?.status).toBe(303);
    expect(new URL(replay!.headers.get('location')!).searchParams.get('authError')).toBe('failed');
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === TOKEN_ENDPOINT)).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([url]) => [TOKEN_ENDPOINT, JWKS_ENDPOINT].includes(String(url)))).toBe(true);
    expect(await sessionCount()).toBe(1);
  });

  it.each([
    ['wrong issuer', { issuer: 'https://issuer.attacker.example' }, 'failed'],
    ['wrong audience', { audience: 'another-client.apps.googleusercontent.com' }, 'failed'],
    ['wrong nonce', { nonce: 'different-synthetic-nonce' }, 'failed'],
    ['unverified email', { emailVerified: false }, 'failed'],
    ['missing verified-email claim', { omitEmailVerified: true }, 'failed'],
    ['expired ID token', { expiresAt: Math.floor(Date.now() / 1000) - 30 }, 'failed'],
    ['stale issued-at claim', { issuedAt: Math.floor(Date.now() / 1000) - 3600 }, 'failed'],
  ] as const)('rejects a Google ID token with %s', async (_label, overrides, authError) => {
    const flow = await beginFlow('/inbox');
    const idToken = await signedIdToken({ nonce: flow.nonce, ...overrides });
    installGoogleFetch(idToken);
    const response = await callback(flow);
    expect(response?.status).toBe(303);
    expect(new URL(response!.headers.get('location')!).searchParams.get('authError')).toBe(authError);
    expect(await sessionCount()).toBe(0);
  });

  it('rejects a non-RS256 ID token even when it is signed with the test key material', async () => {
    const flow = await beginFlow('/inbox');
    const idToken = await new SignJWT({ email: 'owner@gmail.com', email_verified: true, nonce: flow.nonce })
      .setProtectedHeader({ alg: 'HS256', kid: KEY_ID })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setSubject('synthetic-google-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('synthetic-hmac-key-for-negative-test'));
    installGoogleFetch(idToken);
    const response = await callback(flow);
    expect(new URL(response!.headers.get('location')!).searchParams.get('authError')).toBe('failed');
    expect(await sessionCount()).toBe(0);
  });

  it('rejects an ID token whose RSA signature bytes were altered', async () => {
    const flow = await beginFlow('/inbox');
    const validToken = await signedIdToken({ nonce: flow.nonce });
    const [header, payload, signature] = validToken.split('.');
    const changedFirstByte = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    installGoogleFetch(`${header}.${payload}.${changedFirstByte}`);
    const response = await callback(flow);
    expect(new URL(response!.headers.get('location')!).searchParams.get('authError')).toBe('failed');
    expect(await sessionCount()).toBe(0);
  });

  it('only accepts allowlisted Gmail or a verified Workspace domain', async () => {
    const disallowed = await beginFlow('/inbox');
    installGoogleFetch(await signedIdToken({ nonce: disallowed.nonce, email: 'other@gmail.com' }));
    const deniedMailbox = await callback(disallowed);
    expect(new URL(deniedMailbox!.headers.get('location')!).searchParams.get('authError')).toBe('denied');

    const workspaceWithoutHd = await beginFlow('/inbox');
    installGoogleFetch(await signedIdToken({ nonce: workspaceWithoutHd.nonce, email: 'admin@company.example' }));
    const deniedDomain = await callback(workspaceWithoutHd);
    expect(new URL(deniedDomain!.headers.get('location')!).searchParams.get('authError')).toBe('denied');

    const workspace = await beginFlow('/inbox');
    installGoogleFetch(await signedIdToken({ nonce: workspace.nonce, email: 'admin@company.example', hd: 'company.example' }));
    const accepted = await callback(workspace);
    expect(accepted?.status).toBe(303);
    expect(cookieValue(accepted!, GOOGLE_SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sessionCount()).toBe(1);
  });

  it('does not accept a Cloudflare Access email header as Google authentication', async () => {
    const { env, config } = fixture();
    await expect(authenticate(request('/', { headers: { 'cf-access-authenticated-user-email': 'owner@gmail.com' } }), env, config))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('enforces expiry and the current allowlist, and origin-protected logout revokes the D1 session', async () => {
    const { env, config } = fixture();
    const token = 'A'.repeat(43);
    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);
    const authContext = JSON.stringify([config.appOrigin, config.googleClientId, config.mailbox.id]);
    await db.prepare('INSERT INTO mail_auth_sessions (token_hash, auth_context, email, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(tokenHash, authContext, 'owner@gmail.com', 'synthetic-subject', now, now + 21600).run();
    const sessionRequest = request('/', { headers: { cookie: cookieHeader(GOOGLE_SESSION_COOKIE, token) } });
    await expect(authenticateGoogle(sessionRequest, env, config)).resolves.toMatchObject({ email: 'owner@gmail.com' });

    const changedAllowlist = fixture({ allowedUsers: ['admin@company.example'] });
    await expect(authenticateGoogle(sessionRequest, changedAllowlist.env, changedAllowlist.config))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });

    const expiredToken = 'B'.repeat(43);
    await db.prepare('INSERT INTO mail_auth_sessions (token_hash, auth_context, email, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(expiredToken), authContext, 'owner@gmail.com', 'synthetic-expired-subject', now - 100, now - 1).run();
    await expect(authenticateGoogle(request('/', { headers: { cookie: cookieHeader(GOOGLE_SESSION_COOKIE, expiredToken) } }), env, config))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });

    await expect(handleGoogleAuth(request('/api/auth/logout', {
      method: 'POST', headers: { origin: 'https://attacker.example', cookie: cookieHeader(GOOGLE_SESSION_COOKIE, token) },
    }), env, config)).rejects.toMatchObject({ status: 403, code: 'ORIGIN_REJECTED' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mail_auth_sessions WHERE token_hash = ?').bind(tokenHash).first<{ count: number }>().then(row => row?.count)).toBe(1);

    const logout = await handleGoogleAuth(request('/api/auth/logout', {
      method: 'POST', headers: { origin: APP_ORIGIN, cookie: cookieHeader(GOOGLE_SESSION_COOKIE, token) },
    }), env, config);
    expect(logout?.status).toBe(204);
    expect(logout?.headers.get('set-cookie')).toContain(`${GOOGLE_SESSION_COOKIE}=`);
    expect(logout?.headers.get('set-cookie')).toContain(`${GOOGLE_FLOW_COOKIE}=`);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mail_auth_sessions WHERE token_hash = ?').bind(tokenHash).first<{ count: number }>().then(row => row?.count)).toBe(0);
    await expect(authenticateGoogle(sessionRequest, env, config)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('cleans expired OAuth transactions and sessions while preserving unexpired rows', async () => {
    const { env } = fixture();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`INSERT INTO mail_auth_transactions
      (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind('a'.repeat(64), 'b'.repeat(64), 'v'.repeat(43), 'n'.repeat(43), '/', now - 700, now - 1).run();
    await db.prepare(`INSERT INTO mail_auth_transactions
      (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind('c'.repeat(64), 'd'.repeat(64), 'v'.repeat(43), 'n'.repeat(43), '/', now, now + 600).run();
    const { config } = fixture();
    const authContext = JSON.stringify([config.appOrigin, config.googleClientId, config.mailbox.id]);
    await db.prepare(`INSERT INTO mail_auth_sessions
      (token_hash, auth_context, email, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('e'.repeat(64), authContext, 'owner@gmail.com', 'expired-subject', now - 22000, now - 1).run();
    await db.prepare(`INSERT INTO mail_auth_sessions
      (token_hash, auth_context, email, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('f'.repeat(64), authContext, 'owner@gmail.com', 'live-subject', now, now + 21600).run();

    await cleanupGoogleAuth(env);

    const transactions = await db.prepare('SELECT state_hash FROM mail_auth_transactions ORDER BY state_hash').all<{ state_hash: string }>();
    const sessions = await db.prepare('SELECT token_hash FROM mail_auth_sessions ORDER BY token_hash').all<{ token_hash: string }>();
    expect(transactions.results.map(row => row.state_hash)).toEqual(['c'.repeat(64)]);
    expect(sessions.results.map(row => row.token_hash)).toEqual(['f'.repeat(64)]);
  });

  it('routes public options and rejects Access-header login, wrong methods, and invalid callbacks without Google network calls', async () => {
    const { env, config } = fixture();
    const fetchMock = vi.fn(() => { throw new Error('Unexpected Google auth network request'); });
    vi.stubGlobal('fetch', fetchMock);

    const options = await worker.fetch(request('/api/auth/options'), env);
    expect(options.status).toBe(200);
    expect(await options.json()).toEqual({ provider: 'google', brand: config.brand });

    const inbox = await worker.fetch(request('/api/inbox', { headers: {
      'cf-access-jwt-assertion': 'synthetic-access-token',
      'cf-access-authenticated-user-email': 'owner@gmail.com',
    } }), env);
    expect(inbox.status).toBe(401);

    const wrongMethod = await worker.fetch(request('/api/auth/google/start'), env);
    expect(wrongMethod.status).toBe(405);

    const invalidCallback = await worker.fetch(request(`/api/auth/google/callback?code=synthetic-code&state=${'X'.repeat(43)}`), env);
    expect(invalidCallback.status).toBe(303);
    expect(new URL(invalidCallback.headers.get('location')!).searchParams.get('authError')).toBe('failed');
    expect(invalidCallback.headers.get('set-cookie')).toContain(`${GOOGLE_FLOW_COOKIE}=`);
    expect(invalidCallback.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await sessionCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
