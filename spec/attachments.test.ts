import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_FILENAME, base64ByteLength, normalizeBase64, sanitizeAttachmentFilename } from '../shared/attachments';

describe('attachment helpers', () => {
  it('sanitizes path separators and filename control characters', () => {
    expect(sanitizeAttachmentFilename('folder\\report\u0000?.pdf')).toBe('folder-report.pdf');
  });

  it('replaces unpaired surrogates and truncates only at Unicode character boundaries', () => {
    const boundaryName = `${'x'.repeat(MAX_ATTACHMENT_FILENAME - 1)}\uD83D\uDE00tail.txt`;
    const truncated = sanitizeAttachmentFilename(boundaryName);
    expect(truncated).toBe('x'.repeat(MAX_ATTACHMENT_FILENAME - 1));
    expect(() => encodeURIComponent(truncated)).not.toThrow();

    const malformed = sanitizeAttachmentFilename('bad\uD800name\uDC00.txt');
    expect(malformed).toBe('bad\uFFFDname\uFFFD.txt');
    expect(() => encodeURIComponent(malformed)).not.toThrow();
  });

  it('normalizes whitespace in valid standard Base64 and reports decoded byte length', () => {
    const normalized = normalizeBase64(' \r\nAAEC\t');
    expect(normalized).toBe('AAEC');
    expect(base64ByteLength(normalized!)).toBe(3);
    expect(normalizeBase64('AQ==')).toBe('AQ==');
  });

  it.each(['A===', 'AA=A', '%%%'])('rejects malformed Base64: %s', (value) => {
    expect(normalizeBase64(value)).toBeNull();
  });
});
