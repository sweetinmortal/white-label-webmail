import type { Env, MailConfig } from '../types';
import { AppError } from '../errors';
import type { MailObjectStore } from './storage';
import { createTursoStore } from './turso';

const stores = new WeakMap<Env, MailObjectStore>();

export function getMailStore(env: Env, config: MailConfig): MailObjectStore {
  // Local mail fixtures always use Wrangler's private R2 emulator.
  if (config.mode === 'local' || (config.storageProvider ?? 'r2') === 'r2') {
    if (!env.MAIL) throw new AppError(503, 'storage_not_configured', 'El almacenamiento temporal no está configurado.');
    return env.MAIL;
  }
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new AppError(503, 'storage_not_configured', 'El almacenamiento temporal no está configurado.');
  }
  let url: URL;
  try { url = new URL(env.TURSO_DATABASE_URL); }
  catch { throw new AppError(503, 'storage_not_configured', 'El almacenamiento temporal no está configurado.'); }
  if (!['https:', 'libsql:'].includes(url.protocol) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+turso\.io$/.test(url.hostname) ||
      url.username || url.password || url.port || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new AppError(503, 'storage_not_configured', 'El almacenamiento temporal no está configurado.');
  }
  let store = stores.get(env);
  if (!store) {
    store = createTursoStore({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
    stores.set(env, store);
  }
  return store;
}
