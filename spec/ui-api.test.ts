import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawPreviewError, requestRaw } from '../ui/lib/api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let cancelled = false;
  let index = 0;
  const body = {
    getReader() {
      return {
        async read() {
          const value = chunks[index++];
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        async cancel() {
          cancelled = true;
        },
        releaseLock() {},
      };
    },
    async cancel() {
      cancelled = true;
    },
  } as unknown as ReadableStream<Uint8Array>;
  return { response: { ok: true, headers: new Headers(headers), body } as Response, wasCancelled: () => cancelled };
}

describe('bounded raw message reads', () => {
  it('stops and cancels when a body without content-length exceeds the limit', async () => {
    const raw = streamedResponse([new Uint8Array(4), new Uint8Array(3)]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raw.response));

    const error = await requestRaw('message-1', undefined, 5).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RawPreviewError);
    expect(error).toMatchObject({ tooLarge: true });
    expect(raw.wasCancelled()).toBe(true);
  });

  it('enforces the streamed limit when content-length understates the body', async () => {
    const raw = streamedResponse([new Uint8Array(4), new Uint8Array(3)], { 'content-length': '1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raw.response));

    await expect(requestRaw('message-2', undefined, 5)).rejects.toMatchObject({ tooLarge: true });
    expect(raw.wasCancelled()).toBe(true);
  });
});
