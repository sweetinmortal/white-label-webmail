import { Archive, Bell, FileText, Filter, LoaderCircle, LogOut, Mail, Plus, Send, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { Folder, SessionInfo } from '../../shared/contracts';
import { apiFetch } from '../lib/api';
import { initials, labelColor } from '../lib/format';

export default function Sidebar({ session, folder, labelFilter, onFolder, onLabel, onCompose, onTestUsageAlert, usageAlertTestBusy, usageAlertTestPending }: {
  session: SessionInfo;
  folder: Folder;
  labelFilter: string | null;
  onFolder: (folder: Folder) => void;
  onLabel: (label: string) => void;
  onCompose: () => void;
  onTestUsageAlert: () => void;
  usageAlertTestBusy: boolean;
  usageAlertTestPending: boolean;
}) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const logout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError(false);
    try {
      await apiFetch<void>('/auth/logout', { method: 'POST' });
      window.location.assign('/');
    } catch {
      setLogoutError(true);
      setLogoutBusy(false);
    }
  };

  return (
    <aside className="sidebar" aria-label="Navegación principal">
      <div className="brand-lockup">
        <img src={session.brand.logo || '/brand/logo.svg'} alt={`${session.brand.name} logo`} className="brand-logo" />
        <div><strong>{session.brand.name}</strong><span>Correo</span></div>
      </div>
      <button className="button button-primary compose-button" type="button" onClick={onCompose}><Plus size={20} />Redactar</button>
      <nav className="folder-nav" aria-label="Carpetas">
        <button aria-label="Recibidos" className={folder === 'inbox' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('inbox')}><Mail size={18} /><span>Recibidos</span></button>
        <button aria-label="Todos" className={folder === 'all' && !labelFilter ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('all')}><Archive size={18} /><span>Todos</span></button>
        <button aria-label="Filtrados" className={folder === 'filtered' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('filtered')}><Filter size={18} /><span>Filtrados</span></button>
        <button aria-label="Spam" className={folder === 'spam' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('spam')}><ShieldAlert size={18} /><span>Spam</span></button>
        <button aria-label="Enviados" className={folder === 'sent' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('sent')}><Send size={18} /><span>Enviados</span></button>
        <button aria-label="Borradores" className={folder === 'drafts' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('drafts')}><FileText size={18} /><span>Borradores</span></button>
      </nav>
      {(session.labels?.length ?? 0) > 0 && <div className="sidebar-labels">
        <div className="sidebar-section-title"><span>Etiquetas</span></div>
        <nav aria-label="Etiquetas">
          {session.labels?.map((label) => <button key={label.name} aria-label={`Etiqueta ${label.name}`} className={folder === 'all' && labelFilter === label.name ? 'folder-link label-link active' : 'folder-link label-link'} type="button" onClick={() => onLabel(label.name)}><span className="label-dot" style={{ background: labelColor(label.name) }} aria-hidden="true" /><span>{label.name}</span></button>)}
        </nav>
      </div>}
      <div className="sidebar-spacer" />
      <div className="retention-note"><span>Historial: {session.retentionDays} días</span><span>El archivo completo está en tu correo principal.</span></div>
      {session.usageAlerts?.enabled && <div className="usage-alert-test">
        <button className="button button-secondary" type="button" onClick={onTestUsageAlert} disabled={usageAlertTestBusy || usageAlertTestPending} aria-label={usageAlertTestPending ? 'Aviso de cuota pendiente' : 'Probar aviso de cuota'}>
          {usageAlertTestBusy ? <LoaderCircle className="spin" size={16} /> : <Bell size={16} />}
          <span>{usageAlertTestPending ? 'Aviso pendiente' : usageAlertTestBusy ? 'Probando aviso…' : 'Probar aviso de cuota'}</span>
        </button>
        <span>Umbral: {session.usageAlerts.thresholdPercent}% de {session.usageAlerts.limit} usuarios</span>
      </div>}
      {session.authProvider === 'google' && <div className="logout-control">
        <button className="button button-secondary logout-button" type="button" onClick={() => void logout()} disabled={logoutBusy} aria-label={logoutBusy ? 'Cerrando sesión' : 'Cerrar sesión'}>
          {logoutBusy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <LogOut size={17} aria-hidden="true" />}
          <span>{logoutBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</span>
        </button>
        {logoutError && <span className="logout-error" role="alert">No se pudo cerrar sesión. Inténtalo de nuevo.</span>}
      </div>}
      <div className="account-card"><div className="avatar avatar-account">{initials({ email: session.user.email })}</div><div><strong>{session.mailbox.name || session.brand.name}</strong><span>{session.user.email}</span></div></div>
    </aside>
  );
}
