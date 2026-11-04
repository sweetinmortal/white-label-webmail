import { describe, expect, it } from 'vitest';
import { buildReplyQuote, formatReplyDate, joinComposeText } from '../ui/lib/reply-quote';

const replyTo = {
  bodyText: 'Hola\nmundo',
  createdAt: '2026-10-22T13:57:00',
  from: { name: 'Cliente Ejemplo', email: 'cliente@example.test' },
};

describe('reply quote', () => {
  it('uses Gmail Spanish attribution with parentheses and no quote markers', () => {
    const quote = buildReplyQuote(replyTo, 'es-EC');
    expect(quote).toMatch(/^El jue, 22 oct 2026 a la\(s\) 1:57 p\.m\., Cliente Ejemplo \(cliente@example\.test\) escribió:/);
    expect(quote).toMatch(/\nHola\nmundo$/);
    expect(quote).not.toContain('>');
  });

  it('formats the Gmail reply date in Spanish', () => {
    expect(formatReplyDate(replyTo.createdAt, 'es-EC')).toBe('jue, 22 oct 2026 a la(s) 1:57 p.m.');
  });

  it('joins the editable reply with the collapsed quote', () => {
    const quote = buildReplyQuote(replyTo, 'es-EC');
    expect(joinComposeText('Mi respuesta', quote)).toBe(`Mi respuesta\n\n${quote}`);
    expect(joinComposeText('', quote)).toBe(quote);
    expect(joinComposeText('Mi respuesta', '')).toBe('Mi respuesta');
  });

  it('does not create an attribution without original text', () => {
    expect(buildReplyQuote({ ...replyTo, bodyText: null }, 'es-EC')).toBe('');
  });

  it('uses the bare address when the sender has no name', () => {
    const quote = buildReplyQuote({ ...replyTo, from: { name: '', email: 'persona@example.test' } }, 'es-EC');
    expect(quote).toContain(', persona@example.test escribió:');
  });
});
