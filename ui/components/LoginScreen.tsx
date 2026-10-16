import { LoaderCircle, LogIn } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { Brand } from '../../shared/contracts';
import { apiFetch } from '../lib/api';

type AuthError = 'denied' | 'failed';

function callbackMessage(error?: AuthError) {
  if (error === 'denied') return 'No se pudo completar el acceso con Google. Puedes intentarlo de nuevo.';
  if (error === 'failed') return 'No se pudo validar el acceso con Google. Inténtalo de nuevo.';
  return null;
}

function isGoogleAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export default function LoginScreen({ brand, authError }: { brand: Brand; authError?: AuthError }) {
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const visibleError = requestError || callbackMessage(authError);

  const startLogin = async () => {
    if (busy) return;
    setBusy(true);
    setRequestError(null);
    try {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const result = await apiFetch<{ url: string }>('/auth/google/start', {
        method: 'POST',
        body: JSON.stringify({ returnTo }),
      });
      if (!isGoogleAuthorizationUrl(result?.url)) throw new Error('invalid_google_url');
      window.location.assign(result.url);
    } catch {
      setRequestError('No se pudo iniciar el acceso con Google. Inténtalo de nuevo.');
      setBusy(false);
    }
  };

  return <main className="startup-screen google-login-screen" style={{ '--blue': brand.primaryColor } as CSSProperties}>
    <section className="startup-card google-login-card" aria-labelledby="google-login-title">
      <img src={brand.logo || '/brand/logo.svg'} alt={brand.name} className="startup-logo" />
      <div className="google-login-icon" aria-hidden="true"><LogIn size={22} /></div>
      <h1 id="google-login-title">Inicia sesión en {brand.name}</h1>
      <p>Continúa con una cuenta de Google autorizada para esta bandeja.</p>
      {visibleError && <p className="google-login-error" role="alert">{visibleError}</p>}
      <div className="google-login-actions">
        <button className="button google-login-button" type="button" onClick={() => void startLogin()} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <img src="/auth/google-g.svg" alt="" className="google-g-mark" />}
          <span>{busy ? 'Conectando con Google…' : 'Continuar con Google'}</span>
        </button>
        {visibleError && <button className="button button-outline" type="button" onClick={() => void startLogin()} disabled={busy}>Intentar de nuevo</button>}
      </div>
    </section>
  </main>;
}
