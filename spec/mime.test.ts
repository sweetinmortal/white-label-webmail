import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type WorkerMessage = { bodyText?: string; attachments?: Array<{ filename: string; mimeType: string; content: ArrayBuffer }>; error?: string };
type WorkerHandler = (event: MessageEvent<{ buffer: ArrayBuffer }>) => Promise<void>;

const posted: WorkerMessage[] = [];
let onmessage: WorkerHandler;

beforeAll(async () => {
  const workerScope = {
    onmessage: undefined as WorkerHandler | undefined,
    postMessage(message: WorkerMessage) {
      posted.push(message);
    },
  };
  vi.stubGlobal('self', workerScope);
  await import('../ui/raw-parser.worker');
  onmessage = workerScope.onmessage as WorkerHandler;
});

beforeEach(() => {
  posted.length = 0;
});

async function parseRaw(raw: string): Promise<WorkerMessage> {
  const bytes = new TextEncoder().encode(raw);
  await onmessage({ data: { buffer: bytes.buffer } } as MessageEvent<{ buffer: ArrayBuffer }>);
  return posted.at(-1) as WorkerMessage;
}

function deeplyNestedMime(depth: number): string {
  const headers: string[] = [];
  for (let level = 0; level < depth; level += 1) {
    headers.push(`Content-Type: multipart/mixed; boundary="level-${level}"\r\n\r\n--level-${level}\r\n`);
  }
  let body = 'Content-Type: text/plain; charset=utf-8\r\n\r\nDeep body\r\n';
  for (let level = depth - 1; level >= 0; level -= 1) {
    body += `--level-${level}--\r\n`;
  }
  return `From: sender@example.test\r\nMIME-Version: 1.0\r\n${headers.join('')}${body}`;
}

describe('raw MIME worker privacy and attachment handling', () => {
  it('strips active HTML content and preserves attachment bytes with a safe filename', async () => {
    const raw = [
      'From: sender@example.test',
      'To: reader@example.test',
      'Subject: HTML body',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mixed-boundary"',
      '',
      '--mixed-boundary',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      '<html><head><style>body { background: url(https://tracker.test/style); }</style><script>TRACKING_SCRIPT</script></head><body><p>Visible &amp; text</p><img src="https://tracker.test/pixel.gif" alt="TRACKING_ALT"><form>TRACKING_FORM</form></body></html>',
      '--mixed-boundary',
      'Content-Type: application/octet-stream; name="..\\evil/secret.bin"',
      'Content-Disposition: attachment; filename="..\\evil/secret.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'AAEC/w==',
      '--mixed-boundary--',
      '',
    ].join('\r\n');

    const result = await parseRaw(raw);

    expect(result.error).toBeUndefined();
    expect(result.bodyText).toBe('Visible & text');
    expect(result.bodyText).not.toContain('TRACKING_');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0].filename).toBe('..evil-secret.bin');
    expect(result.attachments?.[0].filename).not.toMatch(/[\\/]/);
    expect(Array.from(new Uint8Array(result.attachments?.[0].content ?? new ArrayBuffer(0))))
      .toEqual([0, 1, 2, 255]);
  });

  it('returns a parser error for MIME nesting beyond the configured depth', async () => {
    const result = await parseRaw(deeplyNestedMime(40));

    expect(result.error).toEqual(expect.any(String));
    expect(result.bodyText).toBeUndefined();
  });
});
