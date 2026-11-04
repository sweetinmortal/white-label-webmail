import { describe, expect, it } from 'vitest';
import { loadConfig } from '../worker/config';
import { matchIncomingFilter } from '../worker/services/incoming-filters';
import type { Env } from '../worker/types';

const base = {
  mailbox: { id: 'contacto', address: 'contacto@example.com', name: 'Contacto' },
  archiveAddress: 'archive@example.net',
  allowedUsers: ['owner@example.net'],
};

function configEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    APP_ENV: 'local',
    COMPANY_CONFIG: JSON.stringify({ ...base, ...overrides }),
  } as Env;
}

describe('incoming filters', () => {
  it('normalizes configured rules and matches exact senders and subjects', () => {
    const config = loadConfig(configEnv({
      incomingFilters: [
        { id: 'payments', label: ' Pagos ', from: ['PAYMENTS@example.test', 'payments@example.test'] },
        { id: 'billing', label: 'Facturas', subjectContains: ['Invoice pending'] },
      ],
    }));

    expect(config.incomingFilters).toEqual([
      { id: 'payments', label: 'Pagos', from: ['payments@example.test'] },
      { id: 'billing', label: 'Facturas', subjectContains: ['Invoice pending'] },
    ]);
    expect(matchIncomingFilter('payments@example.test', 'Receipt', config.incomingFilters)?.id).toBe('payments');
    expect(matchIncomingFilter('other@example.test', 'INVOICE PENDING', config.incomingFilters)?.id).toBe('billing');
    expect(matchIncomingFilter('other@example.test', 'Receipt', config.incomingFilters)).toBeUndefined();
  });

  it('requires both criteria when a rule combines sender and subject', () => {
    const filters = [{ id: 'combined', label: 'Combinado', from: ['billing@example.test'], subjectContains: ['invoice'] }];
    expect(matchIncomingFilter('billing@example.test', 'Invoice pending', filters)?.id).toBe('combined');
    expect(matchIncomingFilter('billing@example.test', 'Welcome', filters)).toBeUndefined();
    expect(matchIncomingFilter('other@example.test', 'Invoice pending', filters)).toBeUndefined();
  });

  it('rejects malformed filter configuration', () => {
    const invalid = [
      { incomingFilters: 'not-a-list' },
      { incomingFilters: [{ id: 'empty', label: 'Vacío' }] },
      { incomingFilters: [{ id: 'bad', label: 'Mal', from: ['not-an-email'] }] },
      { incomingFilters: [{ id: 'bad', label: 'Mal', from: ['a@example.test'] }, { id: 'bad', label: 'Duplicado', from: ['b@example.test'] }] },
      { incomingFilters: [{ id: 'subject', label: 'Asunto', subjectContains: ['\u0000'] }] },
    ];
    for (const overrides of invalid) {
      expect(() => loadConfig(configEnv(overrides))).toThrow();
    }
  });
});
