import { AppError } from './errors';

export async function readJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AppError(415, 'JSON_REQUIRED', 'La solicitud debe usar JSON.');
  }
  const length = Number(request.headers.get('content-length') || 0);
  if (length > limit) throw new AppError(413, 'TOO_LARGE', 'El mensaje supera el tamaño permitido.');
  if (!request.body) throw new AppError(400, 'INVALID_JSON', 'La solicitud está vacía.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AppError(413, 'TOO_LARGE', 'El mensaje supera el tamaño permitido.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new AppError(400, 'INVALID_JSON', 'La solicitud no contiene JSON válido.'); }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
export function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Sanitized email bodies load in a sandboxed srcdoc iframe whose meta CSP blocks
  // remote images by default. The parent policy must permit https images so
  // that the user's "Mostrar imágenes" action can work in browsers that
  // inherit the parent policy into local-scheme frames.
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function failure(error: unknown): Response {
  if (error instanceof AppError) return json({ error: { code: error.code, message: error.message } }, error.status);
  console.error('webmail_request_failed', { code: 'INTERNAL_ERROR' });
  return json({ error: { code: 'INTERNAL_ERROR', message: 'No se pudo completar la operación. Inténtalo de nuevo.' } }, 500);
}
