import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { createClient as createWebClient } from '@libsql/client/web';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TursoObjectStore, type TursoSqlClient, createTursoFetch, createTursoStore } from '../worker/store/turso';

const CHUNK_BYTES = 64 * 1024;
const MAX_BYTES = 2 * CHUNK_BYTES + 900;

describe('TursoObjectStore', () => {
  let client: ReturnType<typeof createClient>;
  let store: TursoObjectStore;

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    const migration = await readFile(new URL('../turso-migrations/0001_objects.sql', import.meta.url), 'utf8');
    await client.executeMultiple(migration);
    store = new TursoObjectStore(client as unknown as TursoSqlClient, MAX_BYTES);
  });

  afterEach(() => client.close());

  it('round trips binary objects spanning multiple BLOB chunks', async () => {
    const original = Uint8Array.from({ length: 2 * CHUNK_BYTES + 311 }, (_, index) => (index * 37) % 256);

    await store.put('message/raw-1', original);
    const object = await store.get('message/raw-1');

    expect(object).not.toBeNull();
    const chunks: Uint8Array[] = [];
    const reader = object!.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
    }
    const restored = new Uint8Array(chunks.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      restored.set(chunk, offset);
      offset += chunk.byteLength;
    }

    expect(restored).toEqual(original);
  });

  it('accepts streams only when their byte count exactly matches the size hint', async () => {
    const first = new TextEncoder().encode('stream-');
    const second = new TextEncoder().encode('content');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });

    await store.put('message/stream', stream, { customMetadata: { sizeBytes: String(first.byteLength + second.byteLength) } });

    await expect((await store.get('message/stream'))?.text()).resolves.toBe('stream-content');
  });

  it('rejects oversize inputs, size mismatches, and corrupt oversized BLOB chunks', async () => {
    await expect(store.put('message/oversize', new Uint8Array(MAX_BYTES + 1))).rejects.toThrow(/size limit/i);
    await expect(store.put('message/short', new Uint8Array(4), { customMetadata: { sizeBytes: '5' } })).rejects.toThrow(/size/i);
    await expect(store.put('message/long', new Uint8Array(5), { customMetadata: { sizeBytes: 4 } })).rejects.toThrow(/size/i);

    await client.batch([
      { sql: 'INSERT INTO turso_objects (object_key, size_bytes, chunk_count, ready) VALUES (?, 1, 1, 1)', args: ['message/corrupt'] },
      { sql: 'INSERT INTO turso_object_chunks (object_key, part, data) VALUES (?, 0, ?)', args: ['message/corrupt', new Uint8Array(CHUNK_BYTES + 1)] },
    ], 'write');
    const corruptObject = await store.get('message/corrupt');
    await expect(corruptObject!.body.getReader().read()).rejects.toThrow('Turso object store operation failed.');

    await expect(store.get('message/oversize')).resolves.toBeNull();
    await expect(store.get('message/short')).resolves.toBeNull();
    await expect(store.get('message/long')).resolves.toBeNull();
  });

  it('removes staged rows after a mid-upload batch failure', async () => {
    let batchCalls = 0;
    const failingClient = {
      execute: client.execute.bind(client),
      batch: async (...args: Parameters<TursoSqlClient['batch']>) => {
        batchCalls += 1;
        if (batchCalls === 2) throw new Error('failure for https://db.turso.io?auth=SECRET');
        return client.batch(...args);
      },
    } satisfies TursoSqlClient;
    const failingStore = new TursoObjectStore(failingClient, 20 * CHUNK_BYTES);

    await expect(failingStore.put('message/partial', new Uint8Array(17 * CHUNK_BYTES))).rejects.toThrow('Turso object store operation failed.');
    await expect(failingStore.get('message/partial')).resolves.toBeNull();
    const rows = await client.execute('SELECT (SELECT COUNT(*) FROM turso_objects) AS heads, (SELECT COUNT(*) FROM turso_object_chunks) AS chunks');
    expect(rows.rows[0].heads).toBe(0);
    expect(rows.rows[0].chunks).toBe(0);
  });

  it('deletes repeatedly and leaves no object chunks', async () => {
    await store.put('message/delete', new Uint8Array(CHUNK_BYTES + 1));

    await store.delete('message/delete');
    await store.delete('message/delete');

    await expect(store.get('message/delete')).resolves.toBeNull();
    const rows = await client.execute('SELECT COUNT(*) AS count FROM turso_object_chunks');
    expect(rows.rows[0].count).toBe(0);
  });

  it('stops issuing chunk queries after the consumer cancels the body', async () => {
    const cancelStore = new TursoObjectStore(client as unknown as TursoSqlClient, 18 * CHUNK_BYTES);
    await cancelStore.put('message/cancel', new Uint8Array(17 * CHUNK_BYTES));
    let chunkQueries = 0;
    const countingClient = {
      execute: async (...args: Parameters<TursoSqlClient['execute']>) => {
        const statement = args[0];
        if (typeof statement !== 'string' && statement.sql.includes('FROM turso_object_chunks WHERE object_key = ? AND part >=')) chunkQueries += 1;
        return client.execute(...args as Parameters<typeof client.execute>);
      },
      batch: client.batch.bind(client),
    } satisfies TursoSqlClient;
    const countingStore = new TursoObjectStore(countingClient, 18 * CHUNK_BYTES);
    const object = await countingStore.get('message/cancel');
    const reader = object!.body.getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false, value: expect.any(Uint8Array) });
    await reader.cancel();

    expect(chunkQueries).toBe(1);
  });

  it('keeps a maximum-size write and read under 30 client calls each', async () => {
    const maxObjectBytes = 25 * 1024 * 1024;
    const counts = { executes: 0, batches: 0, largestRawBatch: 0 };
    const countingClient = {
      execute: (...args: Parameters<TursoSqlClient['execute']>) => {
        counts.executes += 1;
        return client.execute(...args as Parameters<typeof client.execute>);
      },
      batch: async (...args: Parameters<TursoSqlClient['batch']>) => {
        counts.batches += 1;
        const rawBatchBytes = args[0].reduce((total, statement) => {
          const blob = statement.args?.find((argument) => argument instanceof Uint8Array);
          return total + (blob instanceof Uint8Array ? blob.byteLength : 0);
        }, 0);
        counts.largestRawBatch = Math.max(counts.largestRawBatch, rawBatchBytes);
        return client.batch(...args);
      },
    } satisfies TursoSqlClient;
    const largeStore = new TursoObjectStore(countingClient, maxObjectBytes);
    const payload = new Uint8Array(maxObjectBytes);
    payload[0] = 0x4a;
    payload[payload.length - 1] = 0x52;

    await largeStore.put('message/max-size', payload);

    const writeCalls = counts.executes + counts.batches;
    expect(counts.batches).toBe(25);
    expect(counts.largestRawBatch).toBe(1024 * 1024);
    expect(writeCalls).toBeLessThanOrEqual(30);

    counts.executes = 0;
    counts.batches = 0;
    counts.largestRawBatch = 0;
    const object = await largeStore.get('message/max-size');
    let streamedBytes = 0;
    const reader = object!.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      streamedBytes += item.value.byteLength;
    }

    const readCalls = counts.executes + counts.batches;
    expect(streamedBytes).toBe(maxObjectBytes);
    expect(counts.executes).toBe(26);
    expect(readCalls).toBeLessThanOrEqual(30);
  }, 60000);

  it('keeps the SDK JSON encoding of a 1 MiB BLOB batch below 1.5 MiB', async () => {
    let encodedBytes = 0;
    let contentType = '';
    const httpClient = createWebClient({
      url: 'https://db.turso.io',
      authToken: 'test-token',
      fetch: async (request: Request) => {
        if (request.method === 'GET') return new Response(null, { status: 404 });
        contentType = request.headers.get('content-type') ?? '';
        encodedBytes = (await request.clone().arrayBuffer()).byteLength;
        return new Response('Captured for size measurement.', { status: 413 });
      },
    });
    const statements = Array.from({ length: 16 }, (_, part) => ({
      sql: 'INSERT INTO turso_object_chunks (object_key, part, data) VALUES (?, ?, ?)',
      args: ['message/size', part, new Uint8Array(CHUNK_BYTES)],
    }));

    try {
      await expect(httpClient.batch(statements, 'write')).rejects.toThrow();
    } finally {
      httpClient.close();
    }

    expect(contentType).toContain('application/json');
    expect(encodedBytes).toBeGreaterThan(1024 * 1024);
    expect(encodedBytes).toBeLessThan(1.5 * 1024 * 1024);
  });

  it('rejects a malicious Hrana base_url before forwarding credentials and preserves caller abort signals', async () => {
    const sent: Array<{ hostname: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const guardedFetch = createTursoFetch('https://db.turso.io', async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sent.push({
        hostname: new URL(request.url).hostname,
        authorization: request.headers.get('authorization'),
        redirect: init?.redirect,
      });
      if (request.method === 'GET') return new Response(null, { status: 404 });
      const protocolRequest = await request.clone().json() as {
        requests: Array<{ type: string; batch?: { steps?: unknown[] } }>;
      };
      return new Response(JSON.stringify({
        baton: null,
        base_url: 'https://attacker.example/',
        results: protocolRequest.requests.map((protocolRequestItem) => ({
          type: 'ok',
          response: protocolRequestItem.type === 'batch'
            ? {
                type: 'batch',
                result: {
                  step_results: (protocolRequestItem.batch?.steps ?? []).map(() => ({ cols: [], rows: [], affected_row_count: 0 })),
                  step_errors: (protocolRequestItem.batch?.steps ?? []).map(() => null),
                },
              }
            : protocolRequestItem.type === 'execute'
              ? { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0 } }
              : protocolRequestItem.type === 'store_sql'
                ? { type: 'store_sql' }
                : { type: 'close' },
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const httpClient = createWebClient({ url: 'https://db.turso.io', authToken: 'auth-sentinel', fetch: guardedFetch });
    const transaction = await httpClient.transaction('read');

    try {
      await transaction.execute('SELECT 1');
      await expect(transaction.execute('SELECT 2')).rejects.toThrow('Turso request rejected.');
    } finally {
      transaction.close();
      httpClient.close();
    }

    expect(sent).toHaveLength(1);
    expect(sent.every((request) => request.hostname === 'db.turso.io')).toBe(true);
    expect(sent.every((request) => request.redirect === 'manual')).toBe(true);
    expect(sent.some((request) => request.hostname === 'attacker.example' && request.authorization === 'Bearer auth-sentinel')).toBe(false);

    const controller = new AbortController();
    let forwardedSignal: AbortSignal | undefined;
    let redirect: RequestRedirect | undefined;
    const fetchForSignal = createTursoFetch('https://db.turso.io', async (_input, init) => {
      forwardedSignal = init?.signal ?? undefined;
      redirect = init?.redirect;
      return new Response(null, { status: 204 });
    });

    await fetchForSignal('https://db.turso.io/v2/pipeline', { signal: controller.signal });
    expect(forwardedSignal?.aborted).toBe(false);
    expect(redirect).toBe('manual');
    controller.abort();
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it('rejects a redirect response without sending credentials to its Location and cancels the body', async () => {
    let calls = 0;
    let requestedHostname = '';
    let authorization: string | null = null;
    let bodyCancelled = false;
    const guardedFetch = createTursoFetch('https://db.turso.io', async (input, init) => {
      calls += 1;
      const request = input instanceof Request ? input : new Request(input, init);
      requestedHostname = new URL(request.url).hostname;
      authorization = request.headers.get('authorization');
      expect(init?.redirect).toBe('manual');
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { bodyCancelled = true; },
      }), {
        status: 302,
        headers: { location: 'https://attacker.example/steal' },
      });
    });
    const httpClient = createWebClient({ url: 'https://db.turso.io', authToken: 'redirect-token-sentinel', fetch: guardedFetch });

    try {
      await expect(httpClient.execute('SELECT 1')).rejects.toThrow('Turso request rejected.');
    } finally {
      httpClient.close();
    }

    expect(calls).toBe(1);
    expect(requestedHostname).toBe('db.turso.io');
    expect(authorization).toBe('Bearer redirect-token-sentinel');
    expect(bodyCancelled).toBe(true);
  });

  it('runs the manual-redirect rejection path in workerd without following a 302', async () => {
    let calls = 0;
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: `
        export default {
          async fetch(_request, env) {
            try {
              const response = await env.UPSTREAM.fetch('https://db.turso.io/v2/pipeline', { redirect: 'manual' });
              if (response.status >= 300 && response.status < 400) {
                try { await response.body?.cancel(); } catch {}
                throw new Error('Turso request rejected.');
              }
              return new Response('accepted');
            } catch (error) {
              return new Response(error instanceof Error ? error.message : 'failed', { status: 502 });
            }
          }
        }`,
      serviceBindings: {
        UPSTREAM: async (request: Request) => {
          calls += 1;
          expect(new URL(request.url).hostname).toBe('db.turso.io');
          return new Response(null, {
            status: 302,
            headers: { location: 'https://attacker.example/steal' },
          });
        },
      },
    }));

    try {
      const response = await mf.dispatchFetch('http://worker.test/');
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('Turso request rejected.');
    } finally {
      await mf.dispose();
    }

    expect(calls).toBe(1);
  }, 30000);

  it('purges at most 20 expired staging heads and preserves ready or recent rows', async () => {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const expiredAt = cutoff - 1;
    const recentAt = cutoff + 1;
    const inserts: Array<{ sql: string; args: Array<string | number | Uint8Array> }> = [];
    for (let index = 0; index < 21; index += 1) {
      const key = `staging/expired-${index}`;
      inserts.push({ sql: 'INSERT INTO turso_objects (object_key, size_bytes, chunk_count, ready, created_at) VALUES (?, 1, 1, 0, ?)', args: [key, expiredAt] });
      inserts.push({ sql: 'INSERT INTO turso_object_chunks (object_key, part, data) VALUES (?, 0, ?)', args: [key, new Uint8Array([index])] });
    }
    inserts.push({ sql: 'INSERT INTO turso_objects (object_key, size_bytes, chunk_count, ready, created_at) VALUES (?, 1, 1, 1, ?)', args: ['object/ready', expiredAt] });
    inserts.push({ sql: 'INSERT INTO turso_object_chunks (object_key, part, data) VALUES (?, 0, ?)', args: ['object/ready', new Uint8Array([42])] });
    inserts.push({ sql: 'INSERT INTO turso_objects (object_key, size_bytes, chunk_count, ready, created_at) VALUES (?, 0, 0, 0, ?)', args: ['staging/recent', recentAt] });
    await client.batch(inserts, 'write');

    expect(await store.purgeStaging()).toBe(20);
    const afterFirst = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM turso_objects WHERE ready = 0 AND created_at <= ?) AS expired_staging,
        (SELECT COUNT(*) FROM turso_objects WHERE object_key = 'staging/recent') AS recent_staging,
        (SELECT COUNT(*) FROM turso_objects WHERE object_key = 'object/ready' AND ready = 1) AS ready_head,
        (SELECT COUNT(*) FROM turso_object_chunks) AS chunks
    `, [cutoff]);
    expect(Number(afterFirst.rows[0].expired_staging)).toBe(1);
    expect(Number(afterFirst.rows[0].recent_staging)).toBe(1);
    expect(Number(afterFirst.rows[0].ready_head)).toBe(1);
    expect(Number(afterFirst.rows[0].chunks)).toBe(2);

    expect(await store.purgeStaging()).toBe(1);
    await expect(client.execute("SELECT object_key FROM turso_objects WHERE object_key IN ('staging/recent', 'object/ready') ORDER BY object_key")).resolves.toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ object_key: 'object/ready' }), expect.objectContaining({ object_key: 'staging/recent' })]) });
  });

  it('keeps credentials and database URL query strings out of errors', async () => {
    const token = 'auth-token-sentinel';
    const query = 'query-secret-sentinel';

    expect(() => createTursoStore({
      url: `https://db.turso.io/?token=${query}`,
      authToken: token,
    })).toThrow('Invalid Turso database URL.');

    const leakingClient = {
      execute: async () => { throw new Error(`https://db.turso.io/?token=${query} ${token}`); },
      batch: client.batch.bind(client),
    } satisfies TursoSqlClient;
    const leakingStore = new TursoObjectStore(leakingClient, MAX_BYTES);
    let message = '';
    try {
      await leakingStore.get('message/error');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('Turso object store operation failed.');
    expect(message).not.toContain(token);
    expect(message).not.toContain(query);
  });

  it('accepts the Turso regional hostname used for this database', () => {
    expect(() => createTursoStore({
      url: 'libsql://company-mail-copies-example.aws-us-east-2.turso.io',
      authToken: 'test-token',
    })).not.toThrow();
  });
});
