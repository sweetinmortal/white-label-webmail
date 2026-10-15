import type { D1Database } from '@cloudflare/workers-types';
import { AppError } from '../errors';
import { ensureSchema, nowIso } from './schema';

// Keep the storage helpers structural.  The Workers runtime and the local
// test runtime can expose slightly different R2/stream declarations, while
// the operations used here are the same small subset of the R2 API.
export type MailObjectStore = {
  put: (...args: any[]) => Promise<unknown>;
  get: (...args: any[]) => Promise<{ body: any; text(): Promise<string> } | null>;
  delete: (...args: any[]) => Promise<void>;
  purgeStaging?: () => Promise<number>;
};

export async function reserveStorage(
  db: D1Database,
  mailboxId: string,
  bytes: number,
  budgetBytes: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
  await ensureSchema(db);
  const at = nowIso();
  const result = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO mail_storage_counters (mailbox_id, used_bytes, budget_bytes, paused, updated_at) VALUES (?, 0, ?, 0, ?)`)
      .bind(mailboxId, budgetBytes, at),
    db.prepare(`UPDATE mail_storage_counters SET used_bytes = used_bytes + ?, budget_bytes = ?, paused = 0, updated_at = ? WHERE mailbox_id = ? AND used_bytes + ? <= ?`)
      .bind(bytes, budgetBytes, at, mailboxId, bytes, budgetBytes),
  ]);
  return (result[1]?.meta?.changes ?? 0) > 0;
}

export async function releaseStorage(db: D1Database, mailboxId: string, bytes: number, unpause = false): Promise<void> {
  await ensureSchema(db);
  await db.prepare(`UPDATE mail_storage_counters SET used_bytes = CASE WHEN used_bytes >= ? THEN used_bytes - ? ELSE 0 END, paused = CASE WHEN ? THEN 0 ELSE paused END, updated_at = ? WHERE mailbox_id = ?`)
    .bind(bytes, bytes, unpause ? 1 : 0, nowIso(), mailboxId).run();
}

export async function pauseStorage(db: D1Database, mailboxId: string, budgetBytes: number): Promise<void> {
  await ensureSchema(db);
  await db.prepare(`INSERT INTO mail_storage_counters (mailbox_id, used_bytes, budget_bytes, paused, updated_at) VALUES (?, 0, ?, 1, ?) ON CONFLICT(mailbox_id) DO UPDATE SET paused = 1, budget_bytes = excluded.budget_bytes, updated_at = excluded.updated_at`)
    .bind(mailboxId, budgetBytes, nowIso()).run();
}

export async function getStorageUsage(db: D1Database, mailboxId: string, budgetBytes: number): Promise<{ usedBytes: number; budgetBytes: number; paused: boolean }> {
  await ensureSchema(db);
  await db.prepare(`INSERT OR IGNORE INTO mail_storage_counters (mailbox_id, used_bytes, budget_bytes, paused, updated_at) VALUES (?, 0, ?, 0, ?)`)
    .bind(mailboxId, budgetBytes, nowIso()).run();
  const row = await db.prepare(`SELECT used_bytes, budget_bytes, paused FROM mail_storage_counters WHERE mailbox_id = ?`).bind(mailboxId).first<{ used_bytes: number; budget_bytes: number; paused: number }>();
  return { usedBytes: Number(row?.used_bytes ?? 0), budgetBytes: Number(row?.budget_bytes ?? budgetBytes), paused: Number(row?.paused ?? 0) === 1 };
}

export async function putStream(bucket: MailObjectStore, key: string, stream: unknown, size: number): Promise<void> {
  await bucket.put(key, stream, { httpMetadata: { contentType: 'message/rfc822' }, customMetadata: { sizeBytes: String(size) } });
}

export async function putJson(bucket: MailObjectStore, key: string, payload: unknown): Promise<number> {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  await bucket.put(key, encoded, { httpMetadata: { contentType: 'application/json' } });
  return encoded.byteLength;
}

export async function getObject(bucket: MailObjectStore, key: string): Promise<{ body: unknown; text(): Promise<string> }> {
  const object = await bucket.get(key);
  if (!object) throw new AppError(404, 'raw_not_found', 'El contenido temporal ya no está disponible.');
  return object;
}

export async function deleteObject(bucket: MailObjectStore, key: string): Promise<void> {
  await bucket.delete(key);
}
