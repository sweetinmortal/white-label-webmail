import { createClient } from '@libsql/client/web';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const CHUNKS_PER_BATCH = Math.floor(MAX_BATCH_BYTES / CHUNK_BYTES);

type SqlArgument = string | number | Uint8Array | null;
type SqlStatement = { sql: string; args?: SqlArgument[] };
type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowsAffected?: number;
};

/** The small libSQL surface used by this adapter, also convenient for tests. */
export type TursoSqlClient = {
  execute(statement: SqlStatement | string, args?: SqlArgument[]): Promise<QueryResult>;
  batch(statements: SqlStatement[], mode?: 'write' | 'read' | 'deferred'): Promise<QueryResult[]>;
};

type PutOptions = {
  customMetadata?: { sizeBytes?: unknown };
};

export type TursoStoreOptions = {
  url: string;
  authToken: string;
  maxBytes?: number;
};

class SafeStoreError extends Error {}

function fail(message: string): never {
  throw new SafeStoreError(message);
}

function checkedMaxBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('Invalid Turso object size limit.');
  return maxBytes;
}

function parseSizeHint(options: unknown): number | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const metadata = (options as PutOptions).customMetadata;
  if (metadata === undefined || metadata === null || metadata.sizeBytes === undefined) return undefined;
  const raw = metadata.sizeBytes;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) fail('Invalid object size hint.');
  return value;
}

function validateObjectKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || key.includes('\0')) {
    fail('Invalid object key.');
  }
}

function validateTursoUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('Invalid Turso database URL.');
  }
  const protocolOk = url.protocol === 'https:' || url.protocol === 'libsql:';
  const hostOk = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+turso\.io$/i.test(url.hostname);
  if (!protocolOk || !hostOk || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    fail('Invalid Turso database URL.');
  }
  return value;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  const candidate = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : typeof input === 'object' && input !== null && 'url' in input
        ? String(input.url)
        : '';
  if (!candidate) return null;
  try { return new URL(candidate); } catch { return null; }
}

/** Validate every SDK request before credentials are handed to fetch. */
export function createTursoFetch(databaseUrl: string, fetchImplementation: typeof fetch = fetch): typeof fetch {
  const configured = new URL(validateTursoUrl(databaseUrl));
  const expectedOrigin = configured.protocol === 'libsql:' ? `https://${configured.host}` : configured.origin;
  const expectedHostname = configured.hostname.toLowerCase();

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = requestUrl(input);
    if (!target || target.protocol !== 'https:' || target.origin !== expectedOrigin || target.hostname.toLowerCase() !== expectedHostname ||
      target.username || target.password || target.search || target.hash || !/^\/(?:v2|v3(?:-protobuf)?)(?:\/|$)/.test(target.pathname)) {
      throw new Error('Turso request rejected.');
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(15_000)];
    if (init?.signal) signals.push(init.signal);
    if (typeof input === 'object' && input !== null && 'signal' in input && input.signal instanceof AbortSignal) {
      signals.push(input.signal);
    }
    const response = await fetchImplementation(input, {
      ...init,
      // workerd supports only "follow" and "manual"; manually inspect the
      // response so a redirect can never move the SDK request or its token.
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* Best-effort cleanup; keep the safe rejection. */ }
      throw new Error('Turso request rejected.');
    }
    return response;
  }) as typeof fetch;
}

function sanitizedOperationError(): Error {
  return new Error('Turso object store operation failed.');
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function rowNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export class TursoObjectStore {
  private readonly maxBytes: number;

  constructor(private readonly client: TursoSqlClient, maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = checkedMaxBytes(maxBytes);
  }

  async put(key: string, value: Uint8Array | ReadableStream<Uint8Array>, options?: unknown): Promise<void> {
    validateObjectKey(key);
    const sizeHint = parseSizeHint(options);
    if (sizeHint !== undefined && sizeHint > this.maxBytes) fail('Object exceeds the configured size limit.');
    const knownSize = value instanceof Uint8Array ? value.byteLength : undefined;
    if (knownSize !== undefined && knownSize > this.maxBytes) fail('Object exceeds the configured size limit.');
    if (knownSize !== undefined && sizeHint !== undefined && knownSize !== sizeHint) fail('Object size does not match its size hint.');

    let claimed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await this.client.execute({
        sql: 'INSERT INTO turso_objects (object_key, size_bytes, chunk_count, ready) VALUES (?, 0, 0, 0)',
        args: [key],
      });
      claimed = true;

      let total = 0;
      let nextPart = 0;
      let pending = new Uint8Array(CHUNK_BYTES);
      let pendingBytes = 0;
      let batch: SqlStatement[] = [];

      const flush = async () => {
        if (batch.length === 0) return;
        const statements = batch;
        batch = [];
        await this.client.batch(statements, 'write');
      };

      const queueChunk = async (bytes: Uint8Array) => {
        if (bytes.byteLength === 0 || bytes.byteLength > CHUNK_BYTES) fail('Invalid object chunk size.');
        batch.push({
          sql: 'INSERT INTO turso_object_chunks (object_key, part, data) VALUES (?, ?, ?)',
          args: [key, nextPart++, bytes],
        });
        if (batch.length === CHUNKS_PER_BATCH) await flush();
      };

      const append = async (input: Uint8Array) => {
        if (!(input instanceof Uint8Array)) fail('Object stream must contain byte chunks.');
        if (total + input.byteLength > this.maxBytes) fail('Object exceeds the configured size limit.');
        if (sizeHint !== undefined && total + input.byteLength > sizeHint) fail('Object size does not match its size hint.');
        total += input.byteLength;
        let offset = 0;
        while (offset < input.byteLength) {
          const count = Math.min(CHUNK_BYTES - pendingBytes, input.byteLength - offset);
          pending.set(input.subarray(offset, offset + count), pendingBytes);
          pendingBytes += count;
          offset += count;
          if (pendingBytes === CHUNK_BYTES) {
            await queueChunk(pending);
            pending = new Uint8Array(CHUNK_BYTES);
            pendingBytes = 0;
          }
        }
      };

      if (knownSize !== undefined) {
        await append(value as Uint8Array);
      } else {
        reader = (value as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          await append(item.value);
        }
      }

      if (sizeHint !== undefined && total !== sizeHint) fail('Object size does not match its size hint.');
      if (knownSize !== undefined && total !== knownSize) fail('Object size does not match its input.');
      if (pendingBytes > 0) await queueChunk(pending.slice(0, pendingBytes));
      await flush();

      const result = await this.client.execute({
        sql: 'UPDATE turso_objects SET size_bytes = ?, chunk_count = ?, ready = 1 WHERE object_key = ? AND ready = 0',
        args: [total, nextPart, key],
      });
      if (result.rowsAffected !== 1) fail('Unable to finalize Turso object.');
    } catch (error) {
      if (reader) {
        try { await reader.cancel(); } catch { /* Keep the original sanitized failure. */ }
      }
      if (claimed) {
        try {
          await this.client.batch([
            { sql: 'DELETE FROM turso_object_chunks WHERE object_key = ?', args: [key] },
            { sql: 'DELETE FROM turso_objects WHERE object_key = ?', args: [key] },
          ], 'write');
        } catch { /* An unready staging row is still invisible to get(). */ }
      }
      // If the first INSERT committed but its response was lost, purgeStaging() removes the unready head later.
      if (error instanceof SafeStoreError) throw error;
      throw sanitizedOperationError();
    } finally {
      try { reader?.releaseLock(); } catch { /* Ignore already released readers. */ }
    }
  }

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; text(): Promise<string> } | null> {
    validateObjectKey(key);
    let size: number;
    let chunkCount: number;
    try {
      const result = await this.client.execute({
        sql: 'SELECT size_bytes, chunk_count, ready FROM turso_objects WHERE object_key = ?',
        args: [key],
      });
      const row = result.rows[0];
      if (!row || Number(row.ready) !== 1) return null;
      const parsedSize = rowNumber(row.size_bytes);
      const parsedCount = rowNumber(row.chunk_count);
      if (parsedSize === null || parsedCount === null || parsedSize > this.maxBytes || parsedCount !== Math.ceil(parsedSize / CHUNK_BYTES)) {
        throw sanitizedOperationError();
      }
      size = parsedSize;
      chunkCount = parsedCount;
    } catch (error) {
      if (error instanceof Error && error.message === 'Turso object store operation failed.') throw error;
      throw sanitizedOperationError();
    }

    let nextPart = 0;
    let bytesRead = 0;
    let cancelled = false;
    let failed = false;
    let bufferedParts: Uint8Array[] = [];
    let bufferedOffset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (cancelled || failed) return;
        if (bufferedOffset >= bufferedParts.length && nextPart === chunkCount) {
          if (bytesRead !== size) {
            failed = true;
            controller.error(sanitizedOperationError());
          } else {
            controller.close();
          }
          return;
        }
        try {
          if (bufferedOffset >= bufferedParts.length) {
            const groupStart = nextPart;
            const groupEnd = Math.min(groupStart + CHUNKS_PER_BATCH, chunkCount);
            const result = await this.client.execute({
              sql: 'SELECT part, data FROM turso_object_chunks WHERE object_key = ? AND part >= ? AND part < ? AND length(data) <= ? ORDER BY part LIMIT ?',
              args: [key, groupStart, groupEnd, CHUNK_BYTES, CHUNKS_PER_BATCH],
            });
            if (cancelled) return;
            if (result.rows.length !== groupEnd - groupStart) throw sanitizedOperationError();
            const parts: Uint8Array[] = [];
            let groupBytes = 0;
            for (let index = 0; index < result.rows.length; index += 1) {
              const row = result.rows[index];
              const part = rowNumber(row.part);
              const bytes = asBytes(row.data);
              const expectedPart = groupStart + index;
              const expectedBytes = expectedPart === chunkCount - 1 ? size - expectedPart * CHUNK_BYTES : CHUNK_BYTES;
              if (part !== expectedPart || !bytes || bytes.byteLength !== expectedBytes || bytes.byteLength > CHUNK_BYTES) {
                throw sanitizedOperationError();
              }
              groupBytes += bytes.byteLength;
              if (groupBytes > MAX_BATCH_BYTES || bytesRead + groupBytes > size) throw sanitizedOperationError();
              parts.push(bytes);
            }
            bufferedParts = parts;
            bufferedOffset = 0;
            nextPart = groupEnd;
          }

          const bytes = bufferedParts[bufferedOffset];
          bufferedParts[bufferedOffset] = new Uint8Array(0);
          bufferedOffset += 1;
          bytesRead += bytes.byteLength;
          controller.enqueue(bytes);
          if (bufferedOffset >= bufferedParts.length) {
            bufferedParts = [];
            bufferedOffset = 0;
          }
        } catch {
          if (cancelled) return;
          failed = true;
          controller.error(sanitizedOperationError());
        }
      },
      cancel: () => {
        cancelled = true;
        bufferedParts = [];
        bufferedOffset = 0;
      },
    }, { highWaterMark: 0 });

    return {
      body,
      text: async () => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        let output = '';
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            total += item.value.byteLength;
            if (total > this.maxBytes) throw sanitizedOperationError();
            output += decoder.decode(item.value, { stream: true });
          }
          return output + decoder.decode();
        } catch {
          try { await reader.cancel(); } catch { /* Preserve the safe error. */ }
          throw sanitizedOperationError();
        } finally {
          try { reader.releaseLock(); } catch { /* Ignore already released readers. */ }
        }
      },
    };
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    try {
      await this.client.batch([
        { sql: 'DELETE FROM turso_object_chunks WHERE object_key = ?', args: [key] },
        { sql: 'DELETE FROM turso_objects WHERE object_key = ?', args: [key] },
      ], 'write');
    } catch {
      throw sanitizedOperationError();
    }
  }

  /** Remove at most 20 stale upload stages; ready objects are retained. */
  async purgeStaging(): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const expiredStages = `SELECT object_key FROM turso_objects WHERE ready = 0 AND created_at <= ? ORDER BY created_at, object_key LIMIT 20`;
    try {
      const results = await this.client.batch([
        { sql: `DELETE FROM turso_object_chunks WHERE object_key IN (${expiredStages})`, args: [cutoff] },
        { sql: `DELETE FROM turso_objects WHERE object_key IN (${expiredStages})`, args: [cutoff] },
      ], 'write');
      const deleted = results[1]?.rowsAffected;
      if (!Number.isSafeInteger(deleted) || (deleted as number) < 0) throw sanitizedOperationError();
      return deleted as number;
    } catch {
      throw sanitizedOperationError();
    }
  }
}

export function createTursoStore({ url, authToken, maxBytes = DEFAULT_MAX_BYTES }: TursoStoreOptions): TursoObjectStore {
  const safeUrl = validateTursoUrl(url);
  if (typeof authToken !== 'string' || authToken.trim().length === 0) fail('Invalid Turso authentication token.');
  const client = createClient({
    url: safeUrl,
    authToken,
    concurrency: 1,
    fetch: createTursoFetch(safeUrl),
  });
  return new TursoObjectStore(client as unknown as TursoSqlClient, maxBytes);
}
