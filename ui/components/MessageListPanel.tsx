import { AlertCircle, Mail, RefreshCw } from 'lucide-react';
import type { Folder, MessageSummary, SessionInfo } from '../../shared/contracts';
import { avatarTone, formatListDate, initials } from '../lib/format';

export default function MessageListPanel({ session, folder, unreadOnly, identityFilter, items, selectedId, loading, error, nextCursor, onUnreadOnly, onIdentityFilter, onRefresh, onSelect, onLoadMore, onSeed, seedLoading, locale }: {
  session: SessionInfo; folder: Folder; unreadOnly: boolean; identityFilter: string; items: MessageSummary[]; selectedId: string | null; loading: boolean; error: string | null; nextCursor: string | null;
  onUnreadOnly: (value: boolean) => void; onIdentityFilter: (value: string) => void; onRefresh: () => void; onSelect: (message: MessageSummary) => void; onLoadMore: () => void; onSeed?: () => void; seedLoading: boolean; locale: string;
}) {
  const title = folder === 'inbox' ? 'Recibidos' : 'Enviados';
  const identities = session.identities?.length ? session.identities : [{ email: session.mailbox.address, name: session.mailbox.name }];
  return <section className="message-list-panel" aria-label={`Lista de ${title}`}>
    <header className="list-header"><div className="list-title-row"><h1>{title}</h1><button className="icon-button" type="button" aria-label="Actualizar bandeja" onClick={onRefresh}><RefreshCw size={22} /></button></div>
      <div className="list-controls"><button type="button" className={unreadOnly ? 'filter-button' : 'filter-button selected'} onClick={() => onUnreadOnly(false)}>Todos</button>{folder === 'inbox' && <button type="button" className={unreadOnly ? 'filter-button selected' : 'filter-button'} onClick={() => onUnreadOnly(true)}>No leídos</button>}{identities.length > 1 && <div className="identity-filter"><label htmlFor="identity-filter">Dirección</label><select id="identity-filter" value={identityFilter} onChange={(event) => onIdentityFilter(event.target.value)}><option value="">Todas las direcciones</option>{identities.map((identity) => <option key={identity.email} value={identity.email}>{identity.name ? `${identity.name} <${identity.email}>` : identity.email}</option>)}</select></div>}</div>
    </header>
    {session.cache.paused && <div className="cache-paused-banner" role="status">Las copias temporales están en pausa. Consulta tu correo principal para ver los mensajes nuevos.</div>}
    <div className="list-scroll" aria-live="polite">
      {loading && items.length === 0 && <LoadingRows />}
      {error && <InlineError message={error} onRetry={onRefresh} />}
      {!loading && !error && items.length === 0 && <EmptyList folder={folder} local={session.mode === 'local'} onSeed={onSeed} seedLoading={seedLoading} />}
      {items.map((item) => <MessageRow key={item.id} message={item} selected={item.id === selectedId} onClick={() => onSelect(item)} locale={locale} showIdentity={identities.length > 1} />)}
      {nextCursor && <button type="button" className="load-more" onClick={onLoadMore} disabled={loading}>{loading ? 'Cargando…' : 'Cargar más'}</button>}
    </div>
  </section>;
}

function LoadingRows() { return <div className="loading-rows" aria-label="Cargando mensajes">{[1, 2, 3, 4].map((id) => <div className="skeleton-row" key={id}><span /><div><i /><i /></div></div>)}</div>; }

function EmptyList({ folder, local, onSeed, seedLoading }: { folder: Folder; local: boolean; onSeed?: () => void; seedLoading: boolean }) {
  return <div className="empty-state"><Mail size={34} strokeWidth={1.5} aria-hidden="true" /><h2>{folder === 'inbox' ? 'Tu bandeja está vacía' : 'Todavía no hay enviados'}</h2><p>{folder === 'inbox' ? 'Los mensajes nuevos aparecerán aquí.' : 'Los mensajes que envíes aparecerán aquí.'}</p>{local && onSeed && <button className="button button-secondary" type="button" onClick={onSeed} disabled={seedLoading}>{seedLoading ? 'Cargando ejemplos…' : 'Cargar ejemplos locales'}</button>}</div>;
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="inline-error" role="alert"><AlertCircle size={20} /><span>{message}</span><button type="button" className="text-button" onClick={onRetry}>Reintentar</button></div>; }

function MessageRow({ message, selected, onClick, locale, showIdentity }: { message: MessageSummary; selected: boolean; onClick: () => void; locale: string; showIdentity: boolean }) {
  const sender = message.direction === 'outgoing' ? message.to[0] || { email: 'Destinatario' } : message.from;
  return <button type="button" className={selected ? 'message-row selected' : 'message-row'} onClick={onClick} aria-current={selected ? 'true' : undefined}>
    <span className={`unread-dot${message.isRead ? ' is-read' : ''}`} aria-label={message.isRead ? undefined : 'No leído'} aria-hidden={message.isRead || undefined} /><span className={`avatar avatar-${avatarTone(message.id)}`}>{initials(sender)}</span><span className="message-row-content"><span className="message-row-top"><strong>{sender.name || sender.email}</strong><time dateTime={message.createdAt}>{formatListDate(message.createdAt, locale)}</time></span><span className="message-row-subject">{message.subject || '(Sin asunto)'}</span>{showIdentity && message.identityAddress && <span className="message-row-identity">{message.direction === 'outgoing' ? 'De' : 'Recibido en'} {message.identityAddress}</span>}</span>
  </button>;
}
