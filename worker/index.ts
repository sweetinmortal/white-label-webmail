import type { Env, Identity } from './types';
import { version as appVersion } from '../package.json';
import type { DraftInput, SendInput } from '../shared/contracts';
import { loadConfig, isLoopback, mailIdentities } from './config';
import { authenticate, authenticateWebhook, checkMutationOrigin } from './auth';
import { AppError } from './errors';
import { failure, json, readJson, secured } from './http';
import { cleanup, deleteDraft, flushScheduledMessages, getCacheUsage, getDraft, getMessage, getOutgoingAttachment, getRaw, listDrafts, listMessages, processWebhook, receiveEmail, saveDraft, sendMessage, setRead, setSpam } from './services/mail';
import { seedLocal } from './dev';
import { checkUsageAlerts, sendUsageAlertTest } from './services/usage-alerts';
import { archiveReplyContext } from './services/archive-links';
import { flushIncomingSummaries, incomingSummaryDue } from './services/incoming-summary';
import { handleGoogleAuth, cleanupGoogleAuth } from './google-auth';
import { quarantineBlockedSenders } from './services/spam';
import { handleOrganization, getOrganizationState } from './services/organization';
import { handleGmail, syncGmail } from './services/gmail-sync';
import { privacyPage } from './privacy';

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/privacy') {
    if (!['GET', 'HEAD'].includes(request.method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
    return privacyPage(loadConfig(env), request.method === 'HEAD');
  }
  if (!url.pathname.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
    return env.ASSETS.fetch(request);
  }
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ service: 'webmail', version: appVersion });
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
  const gmailResponse = await handleGmail(request, env, config, identity);
  if (gmailResponse) return gmailResponse;
  const organizationResponse = await handleOrganization(request, env, config, identity);
  if (organizationResponse) return organizationResponse;
  if (url.pathname === '/api/archive-reply' && request.method === 'GET') {
    return json(await archiveReplyContext(env, config, url.searchParams.get('token') || ''));
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    const organization = await getOrganizationState(env.DB, config);
    return json({ user: { email: identity.email }, authProvider: config.mode === 'local' ? 'local' : config.authProvider ?? 'access', brand: config.brand, mailbox: config.mailbox, archiveAddress: config.archiveAddress, identities: mailIdentities(config), customLabels: organization.labels, labels: [...new Map((config.incomingFilters ?? []).map((rule) => [rule.label, { id: rule.id, name: rule.label }])).values()], retentionDays: config.retentionDays, maxComposeBytes: config.maxComposeBytes, maxAttachments: config.maxAttachments, maxAttachmentBytes: config.maxAttachmentBytes, mode: config.mode, cache: await getCacheUsage(env, config), ...(config.usageAlerts ? { usageAlerts: { enabled: config.usageAlerts.enabled, thresholdPercent: config.usageAlerts.thresholdPercent, limit: config.usageAlerts.zeroTrustSeatLimit } } : {}) });
  }
  if (url.pathname === '/api/usage-alerts/test' && request.method === 'POST') {
    return json(await sendUsageAlertTest(env, config));
  }
  if (url.pathname === '/api/dev/seed' && request.method === 'POST') {
    if (config.mode !== 'local' || !isLoopback(request)) throw new AppError(404, 'NOT_FOUND', 'No encontrado.');
    await seedLocal(env, config);
    return new Response(null, { status: 204 });
  }
  if (['/api/inbox', '/api/sent', '/api/filtered', '/api/all', '/api/spam'].includes(url.pathname) && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') || undefined;
    if (cursor && cursor.length > 1024) throw new AppError(400, 'INVALID_CURSOR', 'La página solicitada no es válida.');
    const folder = url.pathname === '/api/inbox' ? 'inbox' : url.pathname === '/api/filtered' ? 'filtered' : url.pathname === '/api/all' ? 'all' : url.pathname === '/api/spam' ? 'spam' : 'sent';
    return json(await listMessages(env, config, identity, folder, cursor, url.searchParams.get('unread') === '1', url.searchParams.get('address') ?? undefined, url.searchParams.get('label') ?? undefined));
  }
  if (url.pathname === '/api/drafts' && request.method === 'GET') {
    return json(await listDrafts(env, config, identity));
  }
  const draftMatch = /^\/api\/drafts\/([a-zA-Z0-9_-]{8,128})$/.exec(url.pathname);
  if (draftMatch) {
    const [, draftId] = draftMatch;
    if (request.method === 'GET') return json(await getDraft(env, config, identity, draftId));
    if (request.method === 'PUT') {
      const input = await readJson(request, config.maxComposeBytes + Math.ceil(config.maxAttachmentBytes * 4 / 3) + 32768);
      return json(await saveDraft(env, config, identity, draftId, input as DraftInput));
    }
    if (request.method === 'DELETE') {
      await deleteDraft(env, config, identity, draftId);
      return new Response(null, { status: 204 });
    }
    throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
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
  const match = /^\/api\/messages\/([a-zA-Z0-9_-]{1,128})(?:\/(raw|read|spam))?$/.exec(url.pathname);
  if (match) {
    const [, id, action] = match;
    if (!action && request.method === 'GET') return json(await getMessage(env, config, identity, id));
    if (action === 'raw' && request.method === 'GET') return getRaw(env, config, identity, id);
    if (action === 'spam' && request.method === 'PATCH') {
      const input = await readJson(request, 128) as { spam?: unknown } | null;
      if (!input || typeof input.spam !== 'boolean') throw new AppError(400, 'INVALID_SPAM_STATE', 'Indica si el mensaje es spam.');
      await setSpam(env, config, identity, id, input.spam);
      return new Response(null, { status: 204 });
    }
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
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const config = loadConfig(env);
    const at = Number.isFinite(controller.scheduledTime) ? new Date(controller.scheduledTime) : new Date();
    if (controller.cron === '*/5 * * * *') {
      try { await syncGmail(env, config); }
      catch { console.warn('webmail_gmail_sync_failed'); }
      return;
    }
    // The every-minute trigger handles scheduled sends and checks whether a
    // configured incoming summary is due. Keep maintenance, auth cleanup and
    // quota checks off that hot path.
    const minuteTick = controller.cron === '* * * * *';
    if (!minuteTick) {
      try { await quarantineBlockedSenders(env.DB, config); }
      catch { console.warn('webmail_spam_reclassification_failed'); }
    }
    if (!minuteTick && config.authProvider === 'google') {
      try { await cleanupGoogleAuth(env); }
      catch { console.warn('webmail_auth_cleanup_failed'); }
    }
    if (config.incomingSummary?.enabled && incomingSummaryDue(at, config)) {
      try { console.info('webmail_incoming_summary', await flushIncomingSummaries(env, config)); }
      catch { console.warn('webmail_incoming_summary_failed'); }
    }
    try { console.info('webmail_scheduled_send', await flushScheduledMessages(env, config, at)); }
    catch { console.warn('webmail_scheduled_send_failed'); }
    if (!minuteTick && config.cleanupEnabled) {
      try { console.info('webmail_cleanup', await cleanup(env, config)); }
      catch { console.warn('webmail_cleanup_failed'); }
    }
    if (!minuteTick) console.info('webmail_usage_alerts', await checkUsageAlerts(env, config));
  },
} satisfies ExportedHandler<Env>;
