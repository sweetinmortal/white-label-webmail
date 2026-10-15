import { describe, expect, it, vi } from 'vitest';
import type { Env, MailConfig } from '../worker/types';

vi.mock('../worker/store/turso', () => ({ createTursoStore: vi.fn(() => ({ put: vi.fn(), get: vi.fn(), delete: vi.fn() })) }));
import { getMailStore } from '../worker/store/objects';
import { createTursoStore } from '../worker/store/turso';

const production = { mode: 'production', storageProvider: 'turso' } as MailConfig;

describe('private mail storage selection', () => {
  it('keeps local fixtures independent of Turso credentials', () => {
    const mail = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
    expect(getMailStore({ MAIL: mail } as unknown as Env, { ...production, mode: 'local' })).toBe(mail);
  });

  it('rejects missing storage credentials with a safe error', () => {
    expect(() => getMailStore({} as Env, production)).toThrow('El almacenamiento temporal no está configurado.');
  });

  it.each([
    'http://mail.turso.io', 'https://mail.turso.io.evil.example',
    'https://secret@mail.turso.io', 'https://mail.turso.io?token=secret',
    'https://mail.turso.io/path', 'https://127.0.0.1',
  ])('does not send credentials to an invalid database URL: %s', (url) => {
    const authToken = 'private-token';
    expect(() => getMailStore({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } as Env, production)).toThrow('El almacenamiento temporal no está configurado.');
  });

  it('reuses the configured private store for an environment', () => {
    const env = { TURSO_DATABASE_URL: 'libsql://company-mail-mail-copies-example.aws-us-east-2.turso.io', TURSO_AUTH_TOKEN: 'private-token' } as Env;
    const first = getMailStore(env, production);
    expect(getMailStore(env, production)).toBe(first);
    expect(createTursoStore).toHaveBeenCalledWith({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  });
});
