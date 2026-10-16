import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env, Identity, MailConfig } from './types';
import { AppError } from './errors';
import { isLoopback, normalizeEmail } from './config';
import { authenticateGoogle } from './google-auth';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(request: Request, env: Env, config: MailConfig): Promise<Identity> {
  if (config.mode === 'local') {
    if (!isLoopback(request)) throw new AppError(403, 'LOCAL_ONLY', 'La vista local solo está disponible en este equipo.');
    const email = normalizeEmail(env.DEV_AUTH_EMAIL || config.allowedUsers[0]);
    if (!config.allowedUsers.includes(email)) throw new AppError(403, 'FORBIDDEN', 'No tienes acceso a este buzón.');
    return { email, mailboxIds: [config.mailbox.id] };
  }
  if (config.authProvider === 'google') return authenticateGoogle(request, env, config);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.accessTeamDomain) || !config.accessAudience) {
    throw new AppError(503, 'ACCESS_NOT_CONFIGURED', 'El acceso seguro todavía no está configurado.');
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16384) throw new AppError(401, 'UNAUTHENTICATED', 'Inicia sesión para abrir tu correo.');
  const issuer = `https://${config.accessTeamDomain}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    if (keySets.size >= 2) keySets.clear();
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 3600000 });
    keySets.set(issuer, keys);
  }
  let email: string;
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: config.accessAudience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'], clockTolerance: 5 });
    email = normalizeEmail(payload.email);
  } catch { throw new AppError(401, 'UNAUTHENTICATED', 'La sesión no es válida o ha caducado.'); }
  if (!config.allowedUsers.includes(email)) throw new AppError(403, 'FORBIDDEN', 'No tienes acceso a este buzón.');
  return { email, mailboxIds: [config.mailbox.id] };
}

export { checkMutationOrigin } from './origin';

export async function authenticateWebhook(request: Request, env: Env): Promise<void> {
  if (!env.MAILJET_WEBHOOK_USER || !env.MAILJET_WEBHOOK_PASSWORD || env.MAILJET_WEBHOOK_PASSWORD.length < 24) {
    throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'El receptor de eventos no está configurado.');
  }
  const auth = request.headers.get('authorization') || '';
  const expected = `Basic ${btoa(`${env.MAILJET_WEBHOOK_USER}:${env.MAILJET_WEBHOOK_PASSWORD}`)}`;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(auth)), crypto.subtle.digest('SHA-256', encoder.encode(expected))]);
  const a = new Uint8Array(actualHash); const b = new Uint8Array(expectedHash);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) throw new AppError(401, 'UNAUTHENTICATED', 'Credenciales no válidas.');
}
