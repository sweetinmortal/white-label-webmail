import { AlertCircle, FileText, LoaderCircle, Paperclip, RefreshCw, Trash2 } from 'lucide-react';
import type { DraftSummary } from '../../shared/contracts';
import { avatarTone, formatBytes, formatListDate, initials } from '../lib/format';

export default function DraftListPanel({ drafts, loading, error, openingId, deletingId, onRefresh, onOpen, onDiscard, locale }: {
  drafts: DraftSummary[];
  loading: boolean;
  error: string | null;
  openingId: string | null;
  deletingId: string | null;
  onRefresh: () => void;
  onOpen: (draft: DraftSummary) => void;
  onDiscard: (draft: DraftSummary) => void;
  locale: string;
}) {
  return <section className="message-list-panel" aria-label="Lista de borradores">
    <header className="list-header">
      <div className="list-title-row"><h1>Borradores</h1><button className="icon-button" type="button" aria-label="Actualizar borradores" onClick={onRefresh}><RefreshCw size={22} /></button></div>
      <div className="list-controls"><span className="drafts-count">{drafts.length === 1 ? '1 borrador' : `${drafts.length} borradores`}</span><span className="drafts-hint">Se guardan automáticamente</span></div>
    </header>
    <div className="list-scroll" aria-live="polite">
      {loading && drafts.length === 0 && <div className="loading-rows" aria-label="Cargando borradores">{[1, 2, 3].map((id) => <div className="skeleton-row" key={id}><span /><div><i /><i /></div></div>)}</div>}
      {error && <div className="inline-error" role="alert"><AlertCircle size={20} /><span>{error}</span><button type="button" className="text-button" onClick={onRefresh}>Reintentar</button></div>}
      {!loading && !error && drafts.length === 0 && <div className="empty-state"><FileText size={34} strokeWidth={1.5} aria-hidden="true" /><h2>No hay borradores</h2><p>Lo que escribas se guarda aquí mientras redactas. También puedes cerrar una redacción y seguirla después.</p></div>}
      {drafts.map((draft) => {
        const recipient = draft.to.split(/[,;\s]+/).find(Boolean) || draft.from;
        const busy = openingId === draft.id || deletingId === draft.id;
        return <div className={busy ? 'draft-row busy' : 'draft-row'} key={draft.id}>
          <button type="button" className="draft-open" onClick={() => onOpen(draft)} disabled={busy} aria-label={`Abrir borrador: ${draft.subject || 'Sin asunto'}`}>
            <span className={`avatar avatar-${avatarTone(draft.id)}`}>{initials({ email: recipient })}</span>
            <span className="draft-row-content">
              <span className="draft-row-top"><strong>{draft.to || 'Sin destinatario'}</strong><time dateTime={draft.updatedAt}>{formatListDate(draft.updatedAt, locale)}</time></span>
              <span className="draft-row-subject">{draft.subject || '(Sin asunto)'}</span>
              <span className="draft-row-preview">{draft.preview || 'Sin contenido'}</span>
              {draft.attachmentCount > 0 && <span className="draft-row-attachments"><Paperclip size={13} />{draft.attachmentCount} adjunto{draft.attachmentCount === 1 ? '' : 's'} · {formatBytes(draft.attachmentBytes)}</span>}
            </span>
            {openingId === draft.id && <LoaderCircle className="spin draft-row-spinner" size={18} aria-label="Abriendo borrador" />}
          </button>
          <button type="button" className="icon-button draft-delete" aria-label={`Descartar borrador: ${draft.subject || 'Sin asunto'}`} title="Descartar borrador" onClick={() => onDiscard(draft)} disabled={busy}>{deletingId === draft.id ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}</button>
        </div>;
      })}
    </div>
  </section>;
}
