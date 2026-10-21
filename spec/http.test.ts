import { describe, expect, it } from 'vitest';
import { readJson, secured } from '../worker/http';
import { readFileSync } from 'node:fs';

function jsonRequest(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request('https://webmail.company.example/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('HTTP response security headers', () => {
  it('marks responses private and applies browser isolation headers', () => {
    const response = secured(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy')).toContain("frame-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("img-src 'self' blob: data: https:");
  });
  it('keeps static asset CSP aligned with API responses for the sandboxed reader', () => {
    const policy = secured(new Response()).headers.get('content-security-policy')!;
    const assetPolicy = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split('Content-Security-Policy: ')[1].trim();
    const directives = (value: string) => value.split(';').map((part) => part.trim()).filter(Boolean).sort();
    expect(directives(assetPolicy)).toEqual(directives(policy));
  });
});

describe('bounded JSON parsing', () => {
  it('accepts valid JSON when content-length is absent', async () => {
    const body = JSON.stringify({ message: 'ok' });
    const request = jsonRequest(body);
    request.headers.delete('content-length');
    await expect(readJson(request, 1024)).resolves.toEqual({ message: 'ok' });
  });

  it('enforces the declared length before reading the body', async () => {
    const request = jsonRequest(JSON.stringify({ message: 'too large' }), { 'content-length': '1000' });
    await expect(readJson(request, 10)).rejects.toMatchObject({ status: 413, code: 'TOO_LARGE' });
  });

  it('enforces the actual streamed length when content-length is absent or lies', async () => {
    const absent = jsonRequest(JSON.stringify({ message: 'too large' }));
    absent.headers.delete('content-length');
    await expect(readJson(absent, 10)).rejects.toMatchObject({ status: 413, code: 'TOO_LARGE' });

    const lying = jsonRequest(JSON.stringify({ message: 'too large' }), { 'content-length': '1' });
    await expect(readJson(lying, 10)).rejects.toMatchObject({ status: 413, code: 'TOO_LARGE' });
  });

  it('rejects missing or non-JSON content types', async () => {
    await expect(readJson(new Request('https://webmail.company.example/api/test', {
      method: 'POST', body: '{}',
    }), 1024)).rejects.toMatchObject({ status: 415, code: 'JSON_REQUIRED' });
    await expect(readJson(jsonRequest('{}', { 'content-type': 'text/plain' }), 1024))
      .rejects.toMatchObject({ status: 415, code: 'JSON_REQUIRED' });
  });

  it('rejects an empty body and invalid UTF-8 instead of replacing bytes', async () => {
    await expect(readJson(jsonRequest(null), 1024)).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
    await expect(readJson(jsonRequest(invalidUtf8), 1024)).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
  });
});
