import { Check, LoaderCircle, Tag } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { OrganizationLabel } from '../../shared/organization';

export function MessageLabelBadges({ labels }: { labels?: OrganizationLabel[] }) {
  if (!labels?.length) return null;
  return <span className="message-row-tags message-custom-labels" aria-label="Etiquetas">
    {labels.map((label) => <span key={label.id} className="message-row-label custom-label-badge" style={safeLabelStyle(label.color)} title={label.name}>{label.name}</span>)}
  </span>;
}

export default function MessageLabels({ messageId, labels, availableLabels, onSave, disabled = false, initiallyOpen = false, showBadges = true }: {
  messageId: string;
  labels?: OrganizationLabel[];
  availableLabels: OrganizationLabel[];
  onSave: (labelIds: string[]) => Promise<void>;
  disabled?: boolean;
  initiallyOpen?: boolean;
  showBadges?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignedIds = useMemo(() => (labels ?? []).map(({ id }) => id), [labels]);
  const [selectedIds, setSelectedIds] = useState<string[]>(assignedIds);

  useEffect(() => setSelectedIds(assignedIds), [messageId, assignedIds]);

  const changed = selectedIds.length !== assignedIds.length || assignedIds.some((id) => !selectedIds.includes(id));
  const toggleLabel = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const save = async () => {
    if (saving || !changed || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(selectedIds);
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'No se pudieron guardar las etiquetas.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="message-label-editor">
    {showBadges && <MessageLabelBadges labels={labels} />}
    {!disabled && <button type="button" className="message-label-toggle" aria-expanded={open} aria-controls={`message-labels-${messageId}`} onClick={() => { setOpen((value) => !value); setError(null); }}>
      <Tag size={14} aria-hidden="true" />{open ? 'Cerrar etiquetas' : labels?.length ? 'Editar etiquetas' : 'Etiquetar'}
    </button>}
    {open && !disabled && <div className="message-label-options" id={`message-labels-${messageId}`} role="group" aria-label="Etiquetas del mensaje">
      {availableLabels.length === 0
        ? <p>Primero crea una etiqueta en Ajustes.</p>
        : <>
          {availableLabels.map((label) => <label key={label.id} className="message-label-option">
            <input type="checkbox" checked={selectedIds.includes(label.id)} disabled={saving} onChange={() => toggleLabel(label.id)} />
            <span className="label-dot" style={safeLabelStyle(label.color)} aria-hidden="true" />
            <span>{label.name}</span>
          </label>)}
          <div className="message-label-actions">
            <button type="button" className="button button-secondary" onClick={() => { setSelectedIds(assignedIds); setOpen(false); setError(null); }} disabled={saving}>Cancelar</button>
            <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving || !changed}>
              {saving ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              Guardar
            </button>
          </div>
        </>}
      {error && <p className="message-label-error" role="alert">{error}</p>}
    </div>}
  </div>;
}

export function safeLabelStyle(color: string): { color?: string; backgroundColor?: string } {
  if (!/^#[\da-f]{6}$/i.test(color)) return {};
  return { color, backgroundColor: `${color}20` };
}
