import { Bell, LoaderCircle, Mail, Plus, Send } from 'lucide-react';
import type { Folder, SessionInfo } from '../../shared/contracts';
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
      <div className="account-card"><div className="avatar avatar-account">{initials({ email: session.user.email })}</div><div><strong>{session.mailbox.name || session.brand.name}</strong><span>{session.user.email}</span></div></div>
    </aside>
  );
}
