import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env, Identity, MailConfig } from './types';
import { AppError } from './errors';
import { normalizeEmail } from './config';
import { checkMutationOrigin } from './origin';
import { json, readJson } from './http';

export const GOOGLE_FLOW_COOKIE = '__Host-webmail-google-flow';
export const GOOGLE_SESSION_COOKIE = '__Host-webmail-session';
const FLOW_SECONDS = 600;
const SESSION_SECONDS = 21600;
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALLBACK = '/api/auth/google/callback';
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
let googleKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

function now(): number { return Math.floor(Date.now() / 1000); }
function opaque(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function challenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cookieValue(request: Request, name: string): string | null {
  const cookies = (request.headers.get('cookie') || '').split(';').map(value => value.trim());
  const matches = cookies.filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return opaquePattern.test(value) ? value : null;
}
function cookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
function authContext(config: MailConfig): string {
  return JSON.stringify([config.appOrigin, config.googleClientId, config.mailbox.id]);
}
function assertSetup(request: Request, env: Env, config: MailConfig): void {
  if (new URL(request.url).origin !== config.appOrigin) throw new AppError(403, 'ORIGIN_REJECTED', 'El dominio de acceso no es válido.');
  if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.googleClientId || '')
    || !env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET.length < 16 || env.GOOGLE_CLIENT_SECRET.length > 256
    || /[\x00-\x20\x7f]/.test(env.GOOGLE_CLIENT_SECRET)) {
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'El acceso con Google todavía no está configurado.');
  }
}
function returnPath(value: unknown, config: MailConfig): string {
  if (value === undefined) return '/';
  if (typeof value !== 'string' || value.length > 12000 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) {
    throw new AppError(400, 'INVALID_RETURN_PATH', 'La dirección de regreso no es válida.');
  }
  const target = new URL(value, config.appOrigin);
  if (target.origin !== config.appOrigin || target.pathname.startsWith('/api/')) throw new AppError(400, 'INVALID_RETURN_PATH', 'La dirección de regreso no es válida.');
  return target.pathname + target.search + target.hash;
}
function redirect(config: MailConfig, destination: string, error?: 'denied' | 'failed'): Response {
  const target = new URL(destination, config.appOrigin);
  target.searchParams.delete('authError');
  if (error) target.searchParams.set('authError', error);
  const headers = new Headers({ Location: target.href });
  headers.append('Set-Cookie', cookie(GOOGLE_FLOW_COOKIE, '', 0));
  return new Response(null, { status: 303, headers });
}
type AuthFailureStage = 'browser_proof' | 'transaction' | 'authorization_code' | 'token_exchange' | 'id_token' | 'verify_token' | 'claims' | 'session';
function failed(config: MailConfig, destination: string, stage: AuthFailureStage, httpStatus?: number): Response {
  // Operational diagnostics contain only fixed stage names and an HTTP status.
  // Never log requests, codes, cookies, provider bodies, tokens or user details.
  console.warn(JSON.stringify({ event: 'google_auth_failed', stage, ...(httpStatus === undefined ? {} : { httpStatus }) }));
  return redirect(config, destination, 'failed');
}
function method(request: Request, expected: string): void {
  if (request.method !== expected) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
}

export async function authenticateGoogle(request: Request, env: Env, config: MailConfig): Promise<Identity> {
  assertSetup(request, env, config);
  const token = cookieValue(request, GOOGLE_SESSION_COOKIE);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Inicia sesión para abrir tu correo.');
  const session = await env.DB.prepare('SELECT email FROM mail_auth_sessions WHERE token_hash = ? AND auth_context = ? AND expires_at > ?')
    .bind(await hash(token), authContext(config), now()).first<{ email: string }>();
  if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida o ha caducado.');
  if (!config.allowedUsers.includes(session.email)) throw new AppError(403, 'FORBIDDEN', 'No tienes acceso a este buzón.');
  return { email: session.email, mailboxIds: [config.mailbox.id] };
}

export async function handleGoogleAuth(request: Request, env: Env, config: MailConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth/options') {
    method(request, 'GET');
    return json({ provider: config.mode === 'local' ? 'local' : config.authProvider ?? 'access', brand: config.brand });
  }
  if (!['/api/auth/google/start', CALLBACK, '/api/auth/logout'].includes(url.pathname)) return null;
  if (config.mode !== 'production' || config.authProvider !== 'google') throw new AppError(404, 'NOT_FOUND', 'No encontrado.');
  assertSetup(request, env, config);
  if (url.pathname === '/api/auth/logout') {
    method(request, 'POST');
    checkMutationOrigin(request, config);
    const token = cookieValue(request, GOOGLE_SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM mail_auth_sessions WHERE token_hash = ? AND auth_context = ?').bind(await hash(token), authContext(config)).run();
    const headers = new Headers();
    headers.append('Set-Cookie', cookie(GOOGLE_SESSION_COOKIE, '', 0));
    headers.append('Set-Cookie', cookie(GOOGLE_FLOW_COOKIE, '', 0));
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === '/api/auth/google/start') {
    method(request, 'POST');
    checkMutationOrigin(request, config);
    const body = await readJson(request, 16384) as { returnTo?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'INVALID_RETURN_PATH', 'La dirección de regreso no es válida.');
    const destination = returnPath(body.returnTo, config);
    const state = opaque(); const browser = opaque(); const verifier = opaque(); const nonce = opaque();
    const created = now();
    // Bound unauthenticated writes across isolates. No IP addresses are stored.
    const result = await env.DB.prepare(`INSERT INTO mail_auth_transactions
      (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE
      (SELECT COUNT(*) FROM mail_auth_transactions WHERE created_at >= ?) < 10`)
      .bind(await hash(state), await hash(browser), verifier, nonce, destination, created, created + FLOW_SECONDS, created - 60).run();
    if (!result.meta.changes) throw new AppError(429, 'AUTH_RATE_LIMITED', 'Hay varios intentos de acceso. Espera un minuto y vuelve a intentarlo.');
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({
      client_id: config.googleClientId!, redirect_uri: config.appOrigin + CALLBACK,
      response_type: 'code', scope: 'openid email', state, nonce,
      code_challenge: await challenge(verifier), code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    const response = json({ url: authorization.href });
    response.headers.append('Set-Cookie', cookie(GOOGLE_FLOW_COOKIE, browser, FLOW_SECONDS));
    return response;
  }
  method(request, 'GET');
  let destination = '/';
  let stage: AuthFailureStage = 'transaction';
  try {
    const state = url.searchParams.get('state') || '';
    const browser = cookieValue(request, GOOGLE_FLOW_COOKIE);
    if (!opaquePattern.test(state) || !browser || url.searchParams.getAll('state').length !== 1) return failed(config, '/', 'browser_proof');
    const consumedAt = now();
    const transaction = await env.DB.prepare(`UPDATE mail_auth_transactions SET consumed_at = ?
      WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? AND consumed_at IS NULL
      RETURNING verifier, nonce, return_to`)
      .bind(consumedAt, await hash(state), await hash(browser), consumedAt)
      .first<{ verifier: string; nonce: string; return_to: string }>();
    if (!transaction) return failed(config, '/', 'transaction');
    destination = returnPath(transaction.return_to, config);
    if (url.searchParams.has('error')) return redirect(config, destination, 'denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 8192 || url.searchParams.getAll('code').length !== 1) return failed(config, destination, 'authorization_code');
    stage = 'token_exchange';
    const response = await fetch(TOKEN_ENDPOINT, {
      // workerd accepts manual/follow only. The !response.ok guard below rejects
      // 3xx responses without forwarding credentials to another destination.
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: config.googleClientId!, client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: config.appOrigin + CALLBACK, grant_type: 'authorization_code', code_verifier: transaction.verifier }),
    });
    if (!response.ok) return failed(config, destination, 'token_exchange', response.status);
    stage = 'id_token';
    const body: unknown = await response.json();
    const idToken = body && typeof body === 'object' && 'id_token' in body ? body.id_token : undefined;
    if (typeof idToken !== 'string' || idToken.length > 16384) return failed(config, destination, 'id_token');
    stage = 'verify_token';
    googleKeys ??= createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 3600000 });
    const { payload } = await jwtVerify(idToken, googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.googleClientId,
      algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified', 'nonce'], maxTokenAge: 600, clockTolerance: 5,
    });
    stage = 'claims';
    if (payload.nonce !== transaction.nonce || payload.email_verified !== true || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) return failed(config, destination, 'claims');
    const email = normalizeEmail(payload.email);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    // Google is authoritative for Gmail and verified Workspace domains. An old
    // email_verified claim alone cannot prove ownership of an external mailbox.
    if (domain !== 'gmail.com' && (typeof payload.hd !== 'string' || payload.hd.toLowerCase() !== domain)) return redirect(config, destination, 'denied');
    if (!config.allowedUsers.includes(email)) return redirect(config, destination, 'denied');
    stage = 'session';
    const token = opaque(); const created = now();
    const statements: D1PreparedStatement[] = [];
    const previous = cookieValue(request, GOOGLE_SESSION_COOKIE);
    if (previous) statements.push(env.DB.prepare('DELETE FROM mail_auth_sessions WHERE token_hash = ? AND auth_context = ?').bind(await hash(previous), authContext(config)));
    statements.push(env.DB.prepare('INSERT INTO mail_auth_sessions (token_hash, auth_context, email, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await hash(token), authContext(config), email, payload.sub, created, created + SESSION_SECONDS));
    await env.DB.batch(statements);
    const success = redirect(config, destination);
    success.headers.append('Set-Cookie', cookie(GOOGLE_SESSION_COOKIE, token, SESSION_SECONDS));
    return success;
  } catch {
    // Never reflect provider errors, authorization codes or tokens to the UI/logs.
    return failed(config, destination, stage);
  }
}

export async function cleanupGoogleAuth(env: Env): Promise<void> {
  const expiry = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mail_auth_transactions WHERE rowid IN (SELECT rowid FROM mail_auth_transactions WHERE expires_at <= ? LIMIT 1000)').bind(expiry),
    env.DB.prepare('DELETE FROM mail_auth_sessions WHERE rowid IN (SELECT rowid FROM mail_auth_sessions WHERE expires_at <= ? LIMIT 1000)').bind(expiry),
  ]);
}
