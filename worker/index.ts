import type { Env, Identity } from './types';
import type { SendInput } from '../shared/contracts';
import { loadConfig, isLoopback, mailIdentities } from './config';
import { authenticate, authenticateWebhook, checkMutationOrigin } from './auth';
import { AppError } from './errors';
import { failure, json, readJson, secured } from './http';
import { cleanup, getCacheUsage, getMessage, getOutgoingAttachment, getRaw, listMessages, processWebhook, receiveEmail, sendMessage, setRead } from './services/mail';
import { seedLocal } from './dev';
import { checkUsageAlerts, sendUsageAlertTest } from './services/usage-alerts';
import { archiveReplyContext } from './services/archive-links';
import { flushIncomingSummaries } from './services/incoming-summary';
import { handleGoogleAuth, cleanupGoogleAuth } from './google-auth';

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
    return env.ASSETS.fetch(request);
  }
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ service: 'webmail', version: '0.1.0' });
  const config = loadConfig(env);
  const authResponse = await handleGoogleAuth(request, env, config);
  if (authResponse) return authResponse;
  if (url.pathname === '/api/webhooks/mailjet') {
    if (request.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
    await authenticateWebhook(request, env);
    await processWebhook(env, config, await readJson(request, 131072));
    return json({ received: true });
  }
  const identity: Identity = await authenticate(request, env, config);
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method)) checkMutationOrigin(request, config);
  if (url.pathname === '/api/archive-reply' && request.method === 'GET') {
    return json(await archiveReplyContext(env, config, url.searchParams.get('token') || ''));
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return json({ user: { email: identity.email }, authProvider: config.mode === 'local' ? 'local' : config.authProvider ?? 'access', brand: config.brand, mailbox: config.mailbox, archiveAddress: config.archiveAddress, identities: mailIdentities(config), retentionDays: config.retentionDays, maxComposeBytes: config.maxComposeBytes, maxAttachments: config.maxAttachments, maxAttachmentBytes: config.maxAttachmentBytes, mode: config.mode, cache: await getCacheUsage(env, config), ...(config.usageAlerts ? { usageAlerts: { enabled: config.usageAlerts.enabled, thresholdPercent: config.usageAlerts.thresholdPercent, limit: config.usageAlerts.zeroTrustSeatLimit } } : {}) });
  }
  if (url.pathname === '/api/usage-alerts/test' && request.method === 'POST') {
    return json(await sendUsageAlertTest(env, config));
  }
  if (url.pathname === '/api/dev/seed' && request.method === 'POST') {
    if (config.mode !== 'local' || !isLoopback(request)) throw new AppError(404, 'NOT_FOUND', 'No encontrado.');
    await seedLocal(env, config);
    return new Response(null, { status: 204 });
  }
  if (['/api/inbox', '/api/sent'].includes(url.pathname) && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') || undefined;
    if (cursor && cursor.length > 1024) throw new AppError(400, 'INVALID_CURSOR', 'La página solicitada no es válida.');
    return json(await listMessages(env, config, identity, url.pathname === '/api/inbox' ? 'inbox' : 'sent', cursor, url.searchParams.get('unread') === '1', url.searchParams.get('address') ?? undefined));
  }
  if (url.pathname === '/api/send' && request.method === 'POST') {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new AppError(400, 'IDEMPOTENCY_REQUIRED', 'Falta identificar este intento de envío.');
    const input = await readJson(request, config.maxComposeBytes + Math.ceil(config.maxAttachmentBytes * 4 / 3) + 32768) as SendInput;
    return json(await sendMessage(env, config, identity, input, key));
  }
  const attachmentMatch = /^\/api\/messages\/([a-zA-Z0-9_-]{1,128})\/attachments\/(\d{1,2})$/.exec(url.pathname);
  if (attachmentMatch) {
    if (request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
    return getOutgoingAttachment(env, config, identity, attachmentMatch[1], Number(attachmentMatch[2]));
  }
  const match = /^\/api\/messages\/([a-zA-Z0-9_-]{1,128})(?:\/(raw|read))?$/.exec(url.pathname);
  if (match) {
    const [, id, action] = match;
    if (!action && request.method === 'GET') return json(await getMessage(env, config, identity, id));
    if (action === 'raw' && request.method === 'GET') return getRaw(env, config, identity, id);
    if (action === 'read' && request.method === 'PATCH') {
      const input = await readJson(request, 128) as { read?: unknown } | null;
      if (!input || typeof input.read !== 'boolean') throw new AppError(400, 'INVALID_READ_STATE', 'Indica el estado de lectura.');
      await setRead(env, config, identity, id, input.read);
      return new Response(null, { status: 204 });
    }
    throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
  }
  throw new AppError(404, 'NOT_FOUND', 'No se encontró el recurso solicitado.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return secured(await handle(request, env)); }
    catch (error) { return secured(failure(error)); }
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    let config;
    try { config = loadConfig(env); }
    catch { message.setReject('Mailbox configuration unavailable.'); return; }
    if (config.mode !== 'production') { message.setReject('Local-only configuration cannot receive real email.'); return; }
    await receiveEmail(env, config, message);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const config = loadConfig(env);
    if (config.authProvider === 'google') {
      try { await cleanupGoogleAuth(env); }
      catch { console.warn('webmail_auth_cleanup_failed'); }
    }
    if (config.incomingSummary?.enabled) {
      try { console.info('webmail_incoming_summary', await flushIncomingSummaries(env, config)); }
      catch { console.warn('webmail_incoming_summary_failed'); }
    }
    if (config.cleanupEnabled) {
      try { console.info('webmail_cleanup', await cleanup(env, config)); }
      catch { console.warn('webmail_cleanup_failed'); }
    }
    console.info('webmail_usage_alerts', await checkUsageAlerts(env, config));
  },
} satisfies ExportedHandler<Env>;
