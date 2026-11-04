import { describe, expect, it } from 'vitest';
import { cleanQuotedText, splitQuotedPlainText } from '../ui/lib/quoted-text';

describe('quoted plain text', () => {
  it('splits a Gmail-style Spanish reply header from the visible message', () => {
    const result = splitQuotedPlainText('Mi respuesta\n\nEl jue, 22 oct 2026 a la(s) 10:00 a.m., Cliente (cliente@example.net) escribió:\nhola\nmundo');
    expect(result.visible).toBe('Mi respuesta');
    expect(result.quoted).toContain('El jue, 22 oct 2026');
    expect(cleanQuotedText(result.quoted ?? '')).toBe('El jue, 22 oct 2026 a la(s) 10:00 a.m., Cliente (cliente@example.net) escribió:\nhola\nmundo');
  });

  it('can split a draft that contains only the reply attribution and quote', () => {
    const result = splitQuotedPlainText('El jue, 22 oct 2026 a la(s) 10:00 a.m., Cliente (cliente@example.net) escribió:\nhola', { allowEmptyVisible: true });
    expect(result.visible).toBe('');
    expect(result.quoted).toContain('Cliente (cliente@example.net)');
  });

  it('recognizes English Gmail quote headers', () => {
    const result = splitQuotedPlainText('Reply\n\nOn Thu, Oct 22, 2026 at 10:00 AM Client <client@example.net> wrote:\n> hello');
    expect(result.visible).toBe('Reply');
    expect(result.quoted).toContain('On Thu, Oct 22, 2026');
  });

  it('recognizes Outlook-style headers without quote markers', () => {
    const result = splitQuotedPlainText('Reply\n\nDe: Cliente <cliente@example.net>\nEnviado: jueves, 22 de octubre de 2026\nPara: yo@example.com\nAsunto: Hola\n\nTexto anterior');
    expect(result.visible).toBe('Reply');
    expect(result.quoted).toContain('De: Cliente');
    expect(result.quoted).toContain('Texto anterior');
  });

  it('splits a trailing block of quoted lines even without a header', () => {
    const result = splitQuotedPlainText('Hola\n\n> cita\n> más\n');
    expect(result.visible).toBe('Hola');
    expect(cleanQuotedText(result.quoted ?? '')).toBe('cita\nmás');
  });

  it('does not hide the entire message when it is all quoted', () => {
    const result = splitQuotedPlainText('> cita\n> más');
    expect(result.quoted).toBeNull();
    expect(result.visible).toBe('> cita\n> más');
  });

  it('does not split an inline quote followed by new text', () => {
    const result = splitQuotedPlainText('Hola\n> cita\nDespués');
    expect(result.quoted).toBeNull();
  });

  it('removes nested quote markers for display', () => {
    expect(cleanQuotedText('> > hola\n>> mundo')).toBe('hola\nmundo');
  });
});
