import type { Env, MailConfig } from './types';
import type { Address } from '../shared/contracts';
import { AppError } from './errors';

const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/;
export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !EMAIL.test(value)) {
    throw new AppError(503, 'CONFIG_INVALID', 'La configuración del correo no es válida.');
  }
  return value.toLowerCase();
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new AppError(503, 'CONFIG_INVALID', 'La configuración del correo no es válida.');
  }
  return result;
}
function string(value: unknown, fallback: string, max = 200): string {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !result || result.length > max || /[\x00-\x1f\x7f]/.test(result)) {
    throw new AppError(503, 'CONFIG_INVALID', 'La configuración del correo no es válida.');
  }
  return result;
}
export function isLoopback(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}
export function mailIdentities(config: MailConfig): Address[] {
  return config.identities ?? [{ email: config.mailbox.address, name: config.mailbox.name }];
}
export function loadConfig(env: Env): MailConfig {
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(env.COMPANY_CONFIG || '{}');
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('object');
  } catch { throw new AppError(503, 'CONFIG_INVALID', 'Falta configurar este webmail.'); }
  const local = env.APP_ENV === 'local';
  if (!local && env.APP_ENV !== 'production') throw new AppError(503, 'CONFIG_INVALID', 'Falta configurar este webmail.');
  const mailboxAddress = normalizeEmail(raw.mailbox?.address);
  const archiveAddress = normalizeEmail(env.ARCHIVE_EMAIL || raw.archiveAddress);
  if (mailboxAddress === archiveAddress) throw new AppError(503, 'CONFIG_INVALID', 'El archivo principal debe ser un buzón distinto.');
  const mailboxName = string(raw.mailbox?.name, 'Correo');
  if (raw.identities !== undefined && (!Array.isArray(raw.identities) || raw.identities.length > 20)) throw new AppError(503, 'CONFIG_INVALID', 'Las direcciones de correo no son válidas.');
  const configured: Address[] = (raw.identities ?? []).map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(503, 'CONFIG_INVALID', 'Las direcciones de correo no son válidas.');
    const entry = value as Record<string, unknown>;
    return { email: normalizeEmail(entry.email), name: string(entry.name, mailboxName) };
  });
  if (new Set(configured.map(entry => entry.email)).size !== configured.length || configured.some(entry => entry.email === archiveAddress)) throw new AppError(503, 'CONFIG_INVALID', 'Hay direcciones repetidas o una dirección de archivo no válida.');
  const identities = [{ email: mailboxAddress, name: mailboxName }, ...configured.filter(entry => entry.email !== mailboxAddress)];
  if (identities.length > 20) throw new AppError(503, 'CONFIG_INVALID', 'Configura como máximo veinte direcciones.');
  const allowed = env.ALLOWED_USERS ? env.ALLOWED_USERS.split(',').map(value => value.trim()) : raw.allowedUsers;
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > 50) throw new AppError(503, 'CONFIG_INVALID', 'Falta configurar quién puede acceder.');
  const appOrigin = string(env.APP_ORIGIN || raw.appOrigin, local ? 'http://127.0.0.1:8788' : '');
  let url: URL;
  try { url = new URL(appOrigin); } catch { throw new AppError(503, 'CONFIG_INVALID', 'El dominio del webmail no es válido.'); }
  if (url.origin !== appOrigin || (!local && url.protocol !== 'https:')) throw new AppError(503, 'CONFIG_INVALID', 'El dominio del webmail no es válido.');
  const logo = string(raw.brand?.logo, '/brand/logo.svg');
  const color = string(raw.brand?.primaryColor, '#0875d1');
  const mailboxId = string(raw.mailbox?.id, 'main', 64);
  if (!/^\/brand\/[a-zA-Z0-9/_-]+\.(svg|png|webp)$/.test(logo) || !/^#[0-9a-fA-F]{6}$/.test(color) || !/^[a-z0-9_-]+$/.test(mailboxId)) {
    throw new AppError(503, 'CONFIG_INVALID', 'La configuración de la marca no es válida.');
  }
  if (!local && raw.provider !== undefined && raw.provider !== 'mailjet') throw new AppError(503, 'CONFIG_INVALID', 'El proveedor seleccionado no está disponible.');
  if (raw.storageProvider !== undefined && !['r2', 'turso'].includes(raw.storageProvider)) throw new AppError(503, 'CONFIG_INVALID', 'El almacenamiento seleccionado no está disponible.');
  if (raw.usageAlerts !== undefined && (!raw.usageAlerts || Array.isArray(raw.usageAlerts) || typeof raw.usageAlerts.enabled !== 'boolean')) {
    throw new AppError(503, 'CONFIG_INVALID', 'Las alertas de uso no están configuradas correctamente.');
  }
  if (raw.usageAlerts?.delivery !== undefined && !['mailjet', 'cloudflare'].includes(raw.usageAlerts.delivery)) {
    throw new AppError(503, 'CONFIG_INVALID', 'El canal de alertas de uso no está disponible.');
  }
  if (raw.archiveCopies !== undefined && (!raw.archiveCopies || Array.isArray(raw.archiveCopies) || typeof raw.archiveCopies.enabled !== 'boolean')) {
    throw new AppError(503, 'CONFIG_INVALID', 'Las copias del archivo no están configuradas correctamente.');
  }
  if (raw.archiveCopies?.incomingMode !== undefined && !['attachment', 'forward-with-notice'].includes(raw.archiveCopies.incomingMode)) {
    throw new AppError(503, 'CONFIG_INVALID', 'La presentación del archivo no es válida.');
  }
  return {
    brand: { name: string(raw.brand?.name, 'Correo'), logo, primaryColor: color, locale: string(raw.brand?.locale, 'es', 30) },
    appOrigin,
    mailbox: { id: mailboxId, address: mailboxAddress, name: mailboxName },
    identities,
    archiveAddress, allowedUsers: [...new Set(allowed.map(normalizeEmail))],
    retentionDays: integer(raw.retentionDays, 180, 1, 3650),
    cleanupEnabled: raw.cleanupEnabled !== false,
    storageBudgetBytes: integer(raw.storageBudgetBytes, 2000000000, 1048576, 8000000000),
    maxMessageBytes: integer(raw.maxMessageBytes, 26214400, 1024, 26214400),
    maxComposeBytes: integer(raw.maxComposeBytes, 102400, 1024, 524288),
    dailyRecipientLimit: integer(raw.dailyRecipientLimit, 200, 1, 200),
    monthlyRecipientLimit: integer(raw.monthlyRecipientLimit, 6000, 1, 6000),
    mode: local ? 'local' : 'production', provider: local ? 'local' : 'mailjet',
    storageProvider: local ? 'r2' : raw.storageProvider ?? 'r2',
    archiveCopies: {
      enabled: raw.archiveCopies?.enabled !== false,
      maxDecoratedBytes: integer(raw.archiveCopies?.maxDecoratedBytes, 3145728, 1024, 3145728),
      incomingMode: raw.archiveCopies?.incomingMode ?? 'attachment',
    },
    ...(raw.usageAlerts ? { usageAlerts: {
      enabled: !local && raw.usageAlerts.enabled,
      thresholdPercent: integer(raw.usageAlerts.thresholdPercent, 95, 1, 99),
      zeroTrustSeatLimit: integer(raw.usageAlerts.zeroTrustSeatLimit, 50, 1, 100000),
      ...(raw.usageAlerts.delivery === undefined ? {} : { delivery: raw.usageAlerts.delivery }),
    } } : {}),
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN || '', accessAudience: env.ACCESS_AUD || '',
  };
}
