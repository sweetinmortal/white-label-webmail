import type { ArchiveStatus, SendStatus } from '../../shared/contracts';
import { avatarTone, displayAddress, formatBytes, formatDate, initials } from './format';

export { avatarTone, displayAddress, formatBytes, formatDate, initials };

export function archiveLabel(status: ArchiveStatus): string {
  const labels: Record<ArchiveStatus, string> = {
    pending: 'Pendiente',
    forward_accepted: 'Copia de archivo aceptada',
    smtp_accepted: 'Entrega aceptada',
    failed: 'Revisar incidencia',
    unknown: 'Estado incierto',
  };
  return labels[status];
}

export function sendLabel(status: SendStatus): string {
  const labels: Record<SendStatus, string> = {
    pending: 'Pendiente', sending: 'En proceso', accepted: 'Aceptado por el proveedor',
    failed: 'No se completó para todos los destinatarios', unknown: 'Pendiente de confirmación',
  };
  return labels[status];
}
