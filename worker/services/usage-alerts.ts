import type { SendInput } from '../../shared/contracts';
import { sendMessage } from './mail';
import type { Env, Identity, MailConfig } from '../types';
import { claimUsageNotice, finishUsageNotice } from '../store/usage-alerts';

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts/';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 8_000;
const SEAT_MANAGEMENT_URL = 'https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/';
const SAFE_EMAIL_ERROR_CODES = new Set([
  'E_SENDER_NOT_VERIFIED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_DELIVERY_FAILED',
  'E_RATE_LIMIT_EXCEEDED',
]);

export type UsageAlertStatus = 'disabled' | 'unconfigured' | 'below-threshold' | 'notified' | 'pending' | 'error';

export interface UsageAlertResult {
  status: UsageAlertStatus;
  used?: number;
  limit?: number;
}

interface UsageAlertConfig {
  enabled: boolean;
  thresholdPercent: number;
  zeroTrustSeatLimit: number;
  delivery?: 'mailjet' | 'cloudflare';
}

interface UsageAlertEnv extends Env {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_USAGE_API_TOKEN?: string;
}

interface PageResult {
  result: unknown[];
  totalPages: number;
}

type AccessFailureCause = 'request_failed' | 'http_error' | 'response_size_invalid' | 'response_body_missing' |
  'response_invalid' | 'pagination_invalid' | 'result_invalid' | 'pagination_changed';

class AccessCheckError extends Error {
  constructor(readonly reason: AccessFailureCause, readonly httpStatus?: number) {
    super('access_check_failed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeEmailErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string' || !SAFE_EMAIL_ERROR_CODES.has(error.code)) return undefined;
  return error.code;
}

function warnAccessCheckFailure(error: unknown): void {
  const reason = error instanceof AccessCheckError ? error.reason : 'request_failed';
  const httpStatus = error instanceof AccessCheckError && reason === 'http_error' ? error.httpStatus : undefined;
  console.warn('usage_access_check_failed', { cause: reason, ...(httpStatus === undefined ? {} : { httpStatus }) });
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_RESPONSE_BYTES) {
      throw new AccessCheckError('response_size_invalid');
    }
  }

  if (!response.body) throw new AccessCheckError('response_body_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AccessCheckError('response_size_invalid');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new AccessCheckError('response_invalid');
  }
}

async function fetchPage(accountId: string, token: string, page: number): Promise<PageResult> {
  const url = `${API_BASE}${accountId}/access/users?per_page=1000&page=${page}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AccessCheckError('request_failed');
  }
  if (!response.ok) throw new AccessCheckError('http_error', response.status);

  let payload: unknown;
  try { payload = await readJsonBounded(response); }
  catch (error) {
    if (error instanceof AccessCheckError) throw error;
    throw new AccessCheckError('response_invalid');
  }
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result) || !isRecord(payload.result_info)) {
    throw new AccessCheckError('response_invalid');
  }
  const totalPages = payload.result_info.total_pages;
  if (!Number.isInteger(totalPages) || (totalPages as number) < 0 || (totalPages as number) > MAX_PAGES) {
    throw new AccessCheckError('pagination_invalid');
  }
  if (payload.result.length > 1000 || ((totalPages as number) === 0 && payload.result.length !== 0)) {
    throw new AccessCheckError('result_invalid');
  }
  for (const row of payload.result) {
    if (!isRecord(row) || typeof row.access_seat !== 'boolean') throw new AccessCheckError('result_invalid');
  }
  return { result: payload.result, totalPages: totalPages as number };
}

async function countAccessSeats(accountId: string, token: string): Promise<number> {
  const first = await fetchPage(accountId, token, 1);
  if (first.totalPages === 0) return 0;

  let used = 0;
  for (const user of first.result) {
    if ((user as Record<string, unknown>).access_seat === true) used += 1;
  }
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await fetchPage(accountId, token, page);
    if (next.totalPages !== first.totalPages) throw new AccessCheckError('pagination_changed');
    for (const user of next.result) {
      if ((user as Record<string, unknown>).access_seat === true) used += 1;
    }
  }
  return used;
}

function isAlertConfig(value: unknown): value is UsageAlertConfig {
  if (!isRecord(value) || value.enabled !== true) return false;
  return Number.isFinite(value.thresholdPercent) &&
    (value.thresholdPercent as number) >= 1 && (value.thresholdPercent as number) <= 99 &&
    Number.isSafeInteger(value.zeroTrustSeatLimit) && (value.zeroTrustSeatLimit as number) >= 1 &&
    (value.delivery === undefined || value.delivery === 'mailjet' || value.delivery === 'cloudflare');
}

function getUsageContext(env: Env, config: MailConfig, usageConfig: UsageAlertConfig) {
  const usageEnv = env as UsageAlertEnv;
  const accountId = usageEnv.CLOUDFLARE_ACCOUNT_ID;
  const token = usageEnv.CF_USAGE_API_TOKEN;
  const identityEmail = config.allowedUsers[0];
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(accountId) ||
      typeof token !== 'string' || token.trim().length === 0 ||
      typeof config.archiveAddress !== 'string' || config.archiveAddress.trim().length === 0 ||
      typeof identityEmail !== 'string' || identityEmail.trim().length === 0 ||
      typeof config.mailbox?.id !== 'string' || config.mailbox.id.length === 0 ||
      typeof config.mailbox?.address !== 'string' || config.mailbox.address.trim().length === 0) return undefined;
  if ((usageConfig.delivery ?? 'mailjet') === 'cloudflare' && !env.USAGE_ALERT_EMAIL) return undefined;
  return { accountId, token, identityEmail };
}

function monthKey(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `usage-alert:access-seats:${year}-${month}`;
}

function testKey(now = new Date()): string {
  const hour = now.toISOString().slice(0, 13);
  return `usage-alert:test:access-seats:${hour}`;
}

async function deliverUsageNotice(env: Env, config: MailConfig, usageConfig: UsageAlertConfig, text: string, subject: string, key: string, identityEmail: string): Promise<UsageAlertStatus> {
  if ((usageConfig.delivery ?? 'mailjet') === 'cloudflare') {
    const binding = env.USAGE_ALERT_EMAIL;
    if (!binding) return 'unconfigured';

    let claim;
    try {
      claim = await claimUsageNotice(env.DB, config.mailbox.id, key);
    } catch {
      console.warn('usage_notice_claim_failed', { code: 'db_claim_failed' });
      return 'error';
    }
    if (claim.kind === 'accepted') return 'notified';
    if (claim.kind === 'pending') return 'pending';

    let providerId: string | null = null;
    try {
      const sent = await binding.send({
        from: config.mailbox.address,
        to: config.archiveAddress,
        subject,
        text,
      });
      if (!sent || typeof sent.messageId !== 'string' || !sent.messageId || sent.messageId.length > 200) {
        throw new Error('usage_email_result_invalid');
      }
      providerId = sent.messageId;
      await finishUsageNotice(env.DB, config.mailbox.id, key, 'accepted', providerId);
      return 'notified';
    } catch (error) {
      const code = safeEmailErrorCode(error);
      if (code) console.warn('usage_email_send_failed', { code });
      try { await finishUsageNotice(env.DB, config.mailbox.id, key, 'unknown', providerId); }
      catch { /* The original sending claim still prevents an unsafe retry. */ }
      return 'pending';
    }
  }

  const identity: Identity = { email: identityEmail, mailboxIds: [config.mailbox.id] };
  const input: SendInput = { to: [config.archiveAddress], subject, text };
  try {
    const sent = await sendMessage(env, config, identity, input, key);
    if (sent.status === 'accepted') return 'notified';
    if (sent.status === 'pending' || sent.status === 'sending' || sent.status === 'unknown') return 'pending';
    return 'error';
  } catch {
    return 'error';
  }
}

function alertText(used: number, limit: number, thresholdPercent: number): string {
  return [
    `USO: ${used}/${limit} seats de Cloudflare Zero Trust Access (${((used / limit) * 100).toFixed(1)}%).`,
    `El umbral configurado es ${thresholdPercent}%.`,
    'Revisa Zero Trust > Team & Resources > Users en el dashboard:',
    'https://dash.cloudflare.com/',
    'Guía de administración de seats:',
    SEAT_MANAGEMENT_URL,
  ].join('\n');
}

async function getUsageSetup(env: Env, config: MailConfig): Promise<{ config: UsageAlertConfig; context: ReturnType<typeof getUsageContext> } | UsageAlertResult> {
  const usageConfig = (config as MailConfig & { usageAlerts?: unknown }).usageAlerts;
  if (usageConfig === undefined || (isRecord(usageConfig) && usageConfig.enabled === false)) return { status: 'disabled' };
  if (!isAlertConfig(usageConfig)) return { status: 'unconfigured' };
  const context = getUsageContext(env, config, usageConfig);
  if (!context) return { status: 'unconfigured' };
  return { config: usageConfig, context };
}

async function countConfiguredSeats(context: NonNullable<ReturnType<typeof getUsageContext>>): Promise<number> {
  return countAccessSeats(context.accountId, context.token);
}

export async function checkUsageAlerts(env: Env, config: MailConfig): Promise<UsageAlertResult> {
  const setup = await getUsageSetup(env, config);
  if ('status' in setup) return setup;

  let used: number;
  try {
    used = await countConfiguredSeats(setup.context!);
  } catch (error) {
    warnAccessCheckFailure(error);
    return { status: 'error' };
  }

  const usageConfig = setup.config;
  const limit = usageConfig.zeroTrustSeatLimit;
  const thresholdCount = Math.ceil((limit * usageConfig.thresholdPercent) / 100);
  if (used < thresholdCount) return { status: 'below-threshold', used, limit };
  const subject = `Alerta Zero Trust: uso de seats de Access ≥${usageConfig.thresholdPercent}%`;
  const status = await deliverUsageNotice(env, config, usageConfig, alertText(used, limit, usageConfig.thresholdPercent), subject, monthKey(), setup.context!.identityEmail);
  return { status, used, limit };
}

/** Authenticated operator test: send the real count without representing it as an alert. */
export async function sendUsageAlertTest(env: Env, config: MailConfig): Promise<UsageAlertResult> {
  const setup = await getUsageSetup(env, config);
  if ('status' in setup) return setup;

  let used: number;
  try { used = await countConfiguredSeats(setup.context!); }
  catch (error) { warnAccessCheckFailure(error); return { status: 'error' }; }

  const limit = setup.config.zeroTrustSeatLimit;
  const subject = 'PRUEBA: verificación de aviso de uso de seats Access';
  const text = [
    'PRUEBA de configuración de alertas. Este mensaje no indica que se haya alcanzado el umbral.',
    `USO real consultado: ${used}/${limit} seats de Cloudflare Zero Trust Access.`,
    'Revisa Zero Trust > Team & Resources > Users en el dashboard:',
    'https://dash.cloudflare.com/',
    'Guía de administración de seats:',
    SEAT_MANAGEMENT_URL,
  ].join('\n');
  const status = await deliverUsageNotice(env, config, setup.config, text, subject, testKey(), setup.context!.identityEmail);
  return { status, used, limit };
}
