import type { MessageDetail, SessionInfo } from '../../shared/contracts';

export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export class ApiRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'request_failed') {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class RawPreviewError extends Error {
  constructor(message: string, public readonly tooLarge = false) {
    super(message);
    this.name = 'RawPreviewError';
  }
}

function announceUnauthenticated(status: number, code?: string) {
  if ((status === 401 || (status === 403 && code === 'FORBIDDEN')) && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('webmail:unauthenticated'));
  }
}

export type Attachment = { filename: string; mimeType: string; content: ArrayBuffer; contentId?: string; inline?: boolean; sizeBytes?: number; index?: number };
export type ParsedRaw = { bodyText: string; html: string; styles: string; remoteImages: number; attachments: Attachment[] };

export async function apiFetch<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'include', signal });
  if (!response.ok) {
    let message = 'No se pudo completar la solicitud.';
    let code = 'request_failed';
    try {
      const payload: unknown = await response.json();
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const apiError = payload.error;
        if (apiError && typeof apiError === 'object') {
          const details = apiError as { code?: unknown; message?: unknown };
          if (typeof details.message === 'string') message = details.message;
          if (typeof details.code === 'string') code = details.code;
        }
      }
    } catch {
      if (response.status === 401) message = 'Tu sesión segura ha expirado.';
      if (response.status === 503) message = 'El webmail todavía no tiene una configuración segura.';
    }
    announceUnauthenticated(response.status, code);
    throw new ApiRequestError(response.status, message, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function getSession(): Promise<SessionInfo> {
  return apiFetch<SessionInfo>('/session');
}

export async function requestRaw(id: string, signal?: AbortSignal, maxBytes?: number): Promise<ArrayBuffer> {
  const response = await fetch(`/api/messages/${encodeURIComponent(id)}/raw`, { credentials: 'include', signal });
  if (!response.ok) {
    if (response.status === 401) announceUnauthenticated(response.status);
    throw new ApiRequestError(response.status, 'No se pudo descargar el original.');
  }
  const tooLarge = () => new RawPreviewError('Este mensaje supera el límite de vista previa. Descarga el original para abrirlo.', true);
  const declaredLengthHeader = response.headers.get('content-length');
  const declaredLength = declaredLengthHeader && /^\d+$/.test(declaredLengthHeader.trim())
    ? Number(declaredLengthHeader)
    : undefined;
  if (maxBytes !== undefined && declaredLength !== undefined && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }

  if (!response.body) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const raw = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw.buffer;
}

export async function requestOutgoingAttachment(messageId: string, index: number, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/attachments/${index}`, { credentials: 'include', signal });
  if (!response.ok) {
    if (response.status === 401) announceUnauthenticated(response.status);
    throw new ApiRequestError(response.status, 'No se pudo descargar el adjunto.');
  }
  return response;
}

export async function parseRawInWorker(buffer: ArrayBuffer, signal: AbortSignal): Promise<ParsedRaw> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../raw-parser.worker.ts', import.meta.url), { type: 'module' });
    let timer: number | undefined;
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Lectura cancelada.', 'AbortError'));
    };
    const cleanup = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    timer = window.setTimeout(() => {
      cleanup();
      reject(new RawPreviewError('La vista previa tardó demasiado. Descarga el original para abrirlo.'));
    }, 5000);
    worker.onmessage = (event: MessageEvent<Partial<ParsedRaw> & { error?: string }>) => {
      cleanup();
      if (event.data.error) reject(new RawPreviewError(event.data.error));
      else resolve({
        bodyText: event.data.bodyText || '',
        html: event.data.html || '',
        styles: event.data.styles || '',
        remoteImages: event.data.remoteImages || 0,
        attachments: event.data.attachments || [],
      });
    };
    worker.onerror = () => {
      cleanup();
      reject(new RawPreviewError('No se pudo interpretar el original. Descárgalo para abrirlo.'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ buffer }, [buffer]);
  });
}
