import { Bell, LoaderCircle, LogOut, Mail, Plus, Send } from 'lucide-react';
import { useState } from 'react';
import type { Folder, SessionInfo } from '../../shared/contracts';
import { apiFetch } from '../lib/api';
import { initials } from '../lib/format';

export default function Sidebar({ session, folder, onFolder, onCompose, onTestUsageAlert, usageAlertTestBusy, usageAlertTestPending }: {
  session: SessionInfo;
  folder: Folder;
  onFolder: (folder: Folder) => void;
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
      <button className="button button-primary compose-button" type="button" onClick={onCompose}><Plus size={24} />Redactar</button>
      <nav className="folder-nav" aria-label="Carpetas">
        <button aria-label="Recibidos" className={folder === 'inbox' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('inbox')}><Mail size={21} /><span>Recibidos</span></button>
        <button aria-label="Enviados" className={folder === 'sent' ? 'folder-link active' : 'folder-link'} type="button" onClick={() => onFolder('sent')}><Send size={21} /><span>Enviados</span></button>
      </nav>
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
