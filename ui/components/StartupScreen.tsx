import { Mail } from 'lucide-react';
import type { ApiRequestError } from '../lib/api';

export default function StartupScreen({ error, onRetry }: { error: ApiRequestError; onRetry: () => void }) {
  const auth = error.status === 401;
  const setup = error.status === 503;
  return <main className="startup-screen"><div className="startup-card"><img src="/brand/logo.svg" alt="Marca de correo" className="startup-logo" /><Mail className="startup-icon" aria-hidden="true" /><h1>{auth ? 'Inicia sesión para continuar' : setup ? 'Configuración segura pendiente' : 'No se pudo abrir el correo'}</h1><p>{auth ? 'Usa tu identidad autorizada de Cloudflare Access para entrar a tu correo.' : setup ? 'Este webmail no puede abrirse hasta que el buzón y su identidad segura estén configurados.' : 'Comprueba la conexión e inténtalo de nuevo.'}</p><p className="startup-detail">{error.message}</p><button className="button button-primary" type="button" onClick={onRetry}>Intentar de nuevo</button></div></main>;
}
