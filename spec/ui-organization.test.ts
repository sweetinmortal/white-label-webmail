import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../shared/contracts';
import type { OrganizationLabel } from '../shared/organization';
import MessageLabels from '../ui/components/MessageLabels';
import Sidebar from '../ui/components/Sidebar';

const label: OrganizationLabel = { id: 'custom-1', name: 'Equipo/Facturas', color: '#4477aa' };
const session: SessionInfo = {
  user: { email: 'person@example.test' },
  brand: { name: 'Example', logo: '', primaryColor: '#0875d1', locale: 'es-EC' },
  mailbox: { id: 'mailbox-1', address: 'person@example.test', name: 'Example' },
  labels: [{ id: 'legacy-1', name: 'Filtro existente' }],
  customLabels: [label],
  retentionDays: 30,
  maxComposeBytes: 100_000,
  maxAttachments: 5,
  maxAttachmentBytes: 100_000,
  mode: 'production',
  cache: { usedBytes: 0, budgetBytes: 1_000_000, paused: false },
};
const noOp = () => {};

describe('organization settings and message labels UI', () => {
  it('combines legacy and custom navigation labels while keeping settings visible', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      session,
      folder: 'inbox',
      labelFilter: null,
      onFolder: noOp,
      onLabel: noOp,
      onCompose: noOp,
      onSettings: noOp,
      onTestUsageAlert: noOp,
      usageAlertTestBusy: false,
      usageAlertTestPending: false,
    }));

    expect(markup).toContain('Filtro existente');
    expect(markup).toContain('Equipo/Facturas');
    expect(markup).toContain('aria-label="Ajustes"');
    expect(markup).not.toContain('Eliminar etiqueta');
  });

  it('shows multiple custom labels as separate manual checkbox choices', () => {
    const secondLabel = { id: 'custom-2', name: 'Soporte', color: '#118866' };
    const markup = renderToStaticMarkup(createElement(MessageLabels, {
      messageId: 'message-1',
      labels: [label],
      availableLabels: [label, secondLabel],
      onSave: async () => {},
      initiallyOpen: true,
      showBadges: false,
    }));

    expect(markup).toContain('Equipo/Facturas');
    expect(markup).toContain('Soporte');
    expect(markup).toContain('type="checkbox" checked=""');
    expect(markup).toContain('Guardar');
  });

  it('escapes label text in badges instead of treating it as markup', () => {
    const markup = renderToStaticMarkup(createElement(MessageLabels, {
      messageId: 'message-2',
      labels: [{ ...label, name: '<img src=x onerror=alert(1)>' }],
      availableLabels: [],
      onSave: async () => {},
      disabled: true,
    }));

    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('type="checkbox"');
  });
});
