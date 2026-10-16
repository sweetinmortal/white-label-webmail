import type { MailConfig } from './types';
import { AppError } from './errors';
import { isLoopback } from './config';

export function checkMutationOrigin(request: Request, config: MailConfig): void {
  const origin = request.headers.get('origin');
  const valid = new Set([config.appOrigin]);
  if (config.mode === 'local' && isLoopback(request)) {
    for (const host of ['127.0.0.1', 'localhost']) {
      for (const port of [8788, 5174]) valid.add(`http://${host}:${port}`);
    }
  }
  if (!origin || !valid.has(origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AppError(403, 'ORIGIN_REJECTED', 'La solicitud no procede de este webmail.');
  }
}
