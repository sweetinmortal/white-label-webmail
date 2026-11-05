import { AlertCircle, Archive, Mail, RefreshCw } from 'lucide-react';
import type { Folder, MessageSummary, SessionInfo } from '../../shared/contracts';
import type { OrganizationLabel } from '../../shared/organization';
import { avatarTone, formatListDate, initials } from '../lib/format';
import MessageLabels, { MessageLabelBadges } from './MessageLabels';

export default function MessageListPanel({ session, folder, labelFilter, unreadOnly, identityFilter, items, selectedId, loading, error, nextCursor, onUnreadOnly, onIdentityFilter, onRefresh, onSelect, onLoadMore, onSeed, seedLoading, locale, customLabels, onSaveLabels, onSetArchived, archiveSavingId }: {
  session: SessionInfo; folder: Folder; labelFilter: string | null; unreadOnly: boolean; identityFilter: string; items: MessageSummary[]; selectedId: string | null; loading: boolean; error: string | null; nextCursor: string | null;
  onUnreadOnly: (value: boolean) => void; onIdentityFilter: (value: string) => void; onRefresh: () => void; onSelect: (message: MessageSummary) => void; onLoadMore: () => void; onSeed?: () => void; seedLoading: boolean; locale: string;
  customLabels: OrganizationLabel[]; onSaveLabels: (messageId: string, labelIds: string[]) => Promise<void>; onSetArchived: (messageId: string, archived: boolean) => void; archiveSavingId: string | null;
}) {
  const title = labelFilter || (folder === 'inbox' ? 'Recibidos' : folder === 'all' ? 'Todos' : folder === 'filtered' ? 'Archivados' : folder === 'spam' ? 'Spam' : folder === 'drafts' ? 'Borradores' : 'Enviados');
  const identities = session.identities?.length ? session.identities : [{ email: session.mailbox.address, name: session.mailbox.name }];
  return <section className="message-list-panel" aria-label={`Lista de ${title}`}>
    <header className="list-header"><div className="list-title-row"><h1>{title}</h1><button className="icon-button" type="button" aria-label={folder === 'spam' ? 'Actualizar Spam' : 'Actualizar bandeja'} onClick={onRefresh}><RefreshCw size={22} /></button></div>
      <div className="list-controls"><button type="button" className={unreadOnly ? 'filter-button' : 'filter-button selected'} onClick={() => onUnreadOnly(false)}>Todos</button>{folder !== 'sent' && <button type="button" className={unreadOnly ? 'filter-button selected' : 'filter-button'} onClick={() => onUnreadOnly(true)}>No leídos</button>}{identities.length > 1 && <div className="identity-filter"><label htmlFor="identity-filter">Dirección</label><select id="identity-filter" value={identityFilter} onChange={(event) => onIdentityFilter(event.target.value)}><option value="">Todas las direcciones</option>{identities.map((identity) => <option key={identity.email} value={identity.email}>{identity.name ? `${identity.name} <${identity.email}>` : identity.email}</option>)}</select></div>}</div>
    </header>
    {session.cache.paused && <div className="cache-paused-banner" role="status">Las copias temporales están en pausa. Consulta tu correo principal para ver los mensajes nuevos.</div>}
    <div className="list-scroll" aria-live="polite">
      {loading && items.length === 0 && <LoadingRows />}
      {error && <InlineError message={error} onRetry={onRefresh} />}
      {!loading && !error && items.length === 0 && <EmptyList folder={folder} local={session.mode === 'local'} onSeed={onSeed} seedLoading={seedLoading} />}
      {items.map((item) => <MessageRow key={item.id} message={item} selected={item.id === selectedId} onClick={() => onSelect(item)} locale={locale} showIdentity={identities.length > 1} showDirection={folder === 'all' && !labelFilter} folder={folder} customLabels={customLabels} onSaveLabels={onSaveLabels} onSetArchived={onSetArchived} archiveSaving={archiveSavingId === item.id} />)}
      {nextCursor && <button type="button" className="load-more" onClick={onLoadMore} disabled={loading}>{loading ? 'Cargando…' : 'Cargar más'}</button>}
    </div>
  </section>;
}

function LoadingRows() { return <div className="loading-rows" aria-label="Cargando mensajes">{[1, 2, 3, 4].map((id) => <div className="skeleton-row" key={id}><span /><div><i /><i /></div></div>)}</div>; }

function EmptyList({ folder, local, onSeed, seedLoading }: { folder: Folder; local: boolean; onSeed?: () => void; seedLoading: boolean }) {
  const copy = folder === 'inbox'
    ? { title: 'Tu bandeja está vacía', body: 'Los mensajes nuevos aparecerán aquí.' }
    : folder === 'all'
      ? { title: 'No hay mensajes', body: 'Los correos recibidos y enviados aparecerán aquí.' }
      : folder === 'filtered'
        ? { title: 'No hay correos archivados', body: 'Los mensajes que archives o que una regla saque de Recibidos aparecerán aquí.' }
        : folder === 'spam'
          ? { title: 'No hay mensajes en Spam', body: 'Los mensajes marcados como spam aparecerán aquí. Puedes restaurar los que reconozcas.' }
          : folder === 'drafts'
            ? { title: 'No hay borradores', body: 'Lo que escribas se guarda aquí mientras redactas.' }
            : { title: 'Todavía no hay enviados', body: 'Los mensajes que envíes aparecerán aquí.' };
  return <div className="empty-state"><Mail size={34} strokeWidth={1.5} aria-hidden="true" /><h2>{copy.title}</h2><p>{copy.body}</p>{folder === 'inbox' && local && onSeed && <button className="button button-secondary" type="button" onClick={onSeed} disabled={seedLoading}>{seedLoading ? 'Cargando ejemplos…' : 'Cargar ejemplos locales'}</button>}</div>;
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="inline-error" role="alert"><AlertCircle size={20} /><span>{message}</span><button type="button" className="text-button" onClick={onRetry}>Reintentar</button></div>; }

function MessageRow({ message, selected, onClick, locale, showIdentity, showDirection, folder, customLabels, onSaveLabels, onSetArchived, archiveSaving }: {
  message: MessageSummary; selected: boolean; onClick: () => void; locale: string; showIdentity: boolean; showDirection: boolean; folder: Folder; customLabels: OrganizationLabel[];
  onSaveLabels: (messageId: string, labelIds: string[]) => Promise<void>; onSetArchived: (messageId: string, archived: boolean) => void; archiveSaving: boolean;
}) {
  const sender = message.direction === 'outgoing' ? message.to[0] || { email: 'Destinatario' } : message.from;
  const canEditLabels = folder !== 'spam' && (message.direction === 'incoming' || message.direction === 'outgoing');
  return <div className="message-row-shell"><div className={selected ? 'message-row selected' : 'message-row'}>
    <button type="button" className="message-row-open" onClick={onClick} aria-current={selected ? 'true' : undefined}>
      <span className={`unread-dot${message.isRead ? ' is-read' : ''}`} aria-label={message.isRead ? undefined : 'No leído'} aria-hidden={message.isRead || undefined} /><span className={`avatar avatar-${avatarTone(message.id)}`}>{initials(sender)}</span><span className="message-row-content"><span className="message-row-top"><strong>{sender.name || sender.email}</strong><time dateTime={message.createdAt}>{formatListDate(message.createdAt, locale)}</time></span><span className="message-row-subject">{message.subject || '(Sin asunto)'}</span>{(message.filterLabel || (showDirection && message.direction === 'outgoing') || (message.labels?.length ?? 0) > 0 || message.isArchived) && <span className="message-row-tags">{showDirection && message.direction === 'outgoing' && <span className="message-row-kind">Enviado</span>}{message.isArchived && <span className="message-row-kind">Archivado</span>}{message.filterLabel && <span className="message-row-label">{message.filterLabel}</span>}<MessageLabelBadges labels={message.labels} /></span>}{showIdentity && message.identityAddress && <span className="message-row-identity">{message.direction === 'outgoing' ? 'De' : 'Recibido en'} {message.identityAddress}</span>}</span>
    </button>
    {canEditLabels && <div className="message-row-actions">
      <MessageLabels messageId={message.id} labels={message.labels} availableLabels={customLabels} onSave={(labelIds) => onSaveLabels(message.id, labelIds)} showBadges={false} />
      {message.direction === 'incoming' && <button type="button" className="message-row-action" aria-label={message.isArchived ? 'Devolver a Recibidos' : 'Archivar mensaje'} title={message.isArchived ? 'Devolver a Recibidos' : 'Archivar mensaje'} disabled={archiveSaving} onClick={() => onSetArchived(message.id, !message.isArchived)}><Archive size={17} aria-hidden="true" /></button>}
    </div>}
  </div></div>;
}
