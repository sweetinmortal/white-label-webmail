import type { Env, MailConfig } from '../types';
import type { OutboundMessage, OutboundProvider, ProviderResult } from './types';

export const localProvider: OutboundProvider = {
  async send(_env: Env, config: MailConfig, message: OutboundMessage): Promise<ProviderResult> {
    if (config.mode !== 'local' || config.provider !== 'local') {
      return { outcome: 'definite_failure', recipients: [], code: 'local_provider_disabled', safeMessage: 'El proveedor local solo está disponible en modo local.' };
    }
    return {
      outcome: 'accepted',
      recipients: message.to.map((recipient, index) => ({
        email: recipient.email,
        kind: recipient.kind,
        providerId: `local-${message.id}-${index + 1}`,
        providerUuid: `local-${message.id}-${index + 1}`,
        status: 'accepted',
      })),
    };
  },
};
