import { parseEmailContent } from '../shared/email-content';

type WorkerRequest = { buffer: ArrayBuffer };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const parsed = await parseEmailContent(event.data.buffer);
    const workerScope = self as unknown as {
      postMessage(message: unknown, transfer?: Transferable[]): void;
    };
    workerScope.postMessage(parsed, parsed.attachments.map((attachment) => attachment.content));
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo leer el mensaje.' });
  }
};

export {};
