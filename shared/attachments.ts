export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_FILENAME = 180;

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const INLINE_IMAGE = /^image\/(?:png|jpe?g|gif|webp|avif|bmp)$/i;

export function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && MIME.test(value);
}

export function isInlineImageMime(value: unknown): value is string {
  return typeof value === 'string' && INLINE_IMAGE.test(value);
}

function replaceUnpairedSurrogates(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output.push(value[index], value[index + 1]);
        index++;
      } else {
        output.push('\uFFFD');
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output.push('\uFFFD');
    } else {
      output.push(value[index]);
    }
  }
  return output.join('');
}

export function sanitizeAttachmentFilename(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = replaceUnpairedSurrogates(value)
    .normalize('NFC')
    .replace(/[\\/]/g, '-')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  let length = 0;
  for (const codePoint of cleaned) {
    if (length + codePoint.length > MAX_ATTACHMENT_FILENAME) break;
    length += codePoint.length;
  }
  return cleaned.slice(0, length) || 'adjunto';
}

export function normalizeBase64(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const body = padding ? compact.slice(0, -padding) : compact;
  if (body.includes('=')) return null;
  return compact;
}

export function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor(value.length / 4) * 3 - padding;
}

export function asciiFilename(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, MAX_ATTACHMENT_FILENAME) || 'adjunto';
}
