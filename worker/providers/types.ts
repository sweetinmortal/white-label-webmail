import type { MailConfig, Env } from '../types';
import type { Address } from '../../shared/contracts';

export interface OutboundRecipient {
  email: string;
  kind: 'to' | 'cc' | 'bcc';
}

export interface OutboundMessage {
  id: string;
  from: Address;
  to: OutboundRecipient[];
  subject: string;
  text: string;
  headers: Record<string, string>;
  customId: string;
  archiveAddress: string;
  archiveReplyToken?: string;
}

export interface ProviderRecipientResult {
  email: string;
  kind: OutboundRecipient['kind'];
  providerId?: string;
  providerUuid?: string;
  status: 'accepted' | 'failed' | 'unknown';
}

export interface ProviderResult {
  outcome: 'accepted' | 'definite_failure' | 'unknown';
  recipients: ProviderRecipientResult[];
  code?: string;
  safeMessage?: string;
}

export interface OutboundProvider {
  send(env: Env, config: MailConfig, message: OutboundMessage): Promise<ProviderResult>;
}
