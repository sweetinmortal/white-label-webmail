import { AlertCircle, ArrowLeft, ChevronDown, LoaderCircle, Send, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Address, ArchiveReplyContext, MessageDetail, SendInput, SendResult, SessionInfo } from '../../shared/contracts';
import { apiFetch } from '../lib/api';
import { hasValidEmails, replySubject, splitEmails } from '../lib/format';

function createAttemptKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `compose-${Date.now().toString(36)}-${hex}`;
}

function configuredIdentities(session: SessionInfo): Address[] {
  return session.identities?.length ? session.identities : [{ email: session.mailbox.address, name: session.mailbox.name }];
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function defaultFromAddress(session: SessionInfo, replyTo?: MessageDetail, archiveReply?: ArchiveReplyContext) {
  const identities = configuredIdentities(session);
  const candidates = [
    archiveReply?.from,
    replyTo?.identityAddress,
    replyTo?.direction === 'outgoing' ? replyTo.from.email : undefined,
  ];
  for (const candidate of candidates) {
    const match = candidate && identities.find((identity) => normalizeEmail(identity.email) === normalizeEmail(candidate));
    if (match) return match.email;
  }
  return session.mailbox.address;
}

function replyRecipients(replyTo: MessageDetail | undefined, identities: Address[]) {
  if (!replyTo) return { to: '', cc: '' };
  if (replyTo.direction === 'incoming') return { to: replyTo.replyTo?.email || replyTo.from.email, cc: '' };

  const ownAddresses = new Set(identities.map((identity) => normalizeEmail(identity.email)));
  const originalTo = replyTo.to.map((recipient) => recipient.email).filter((email) => !ownAddresses.has(normalizeEmail(email)));
  const originalCc = replyTo.cc.map((recipient) => recipient.email).filter((email) => !ownAddresses.has(normalizeEmail(email)) && !originalTo.some((toAddress) => normalizeEmail(toAddress) === normalizeEmail(email)));
  return originalTo.length
    ? { to: originalTo.join(', '), cc: originalCc.join(', ') }
    : { to: originalCc.join(', '), cc: '' };
}

export default function ComposeDialog({ session, replyTo, archiveReply, onClose, onSent }: { session: SessionInfo; replyTo?: MessageDetail; archiveReply?: ArchiveReplyContext; onClose: () => void; onSent: (from?: string) => void }) {
  const identities = configuredIdentities(session);
  const defaultFrom = defaultFromAddress(session, replyTo, archiveReply);
  const initialRecipients = replyRecipients(replyTo, identities);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(archiveReply ? archiveReply.to.join(', ') : initialRecipients.to);
  const [cc, setCc] = useState(archiveReply ? archiveReply.cc.join(', ') : initialRecipients.cc);
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(archiveReply ? replySubject(archiveReply.subject) : replyTo ? replySubject(replyTo.subject) : '');
  const [text, setText] = useState(() => !archiveReply && replyTo?.bodyText ? `\n\n\n${replyTo.bodyText.split('\n').map((line) => `> ${line}`).join('\n')}` : '');
  const [showCopies, setShowCopies] = useState(Boolean(archiveReply?.cc.length || initialRecipients.cc));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<SendInput | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  if (!idempotencyKey.current) idempotencyKey.current = createAttemptKey();
  const dirty = Boolean(to || cc || bcc || subject || text || from !== defaultFrom);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy && (!dirty || window.confirm('¿Descartar este borrador?'))) onClose();
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea')).filter((element) => !element.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, dirty, onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const input = submittedInput ?? (() => {
      if (!splitEmails(to).length || !hasValidEmails(to) || !hasValidEmails(cc) || !hasValidEmails(bcc)) { setError('Revisa las direcciones de destinatarios.'); return null; }
      if (!subject.trim()) { setError('Escribe un asunto.'); return null; }
      if (new Blob([text]).size > session.maxComposeBytes) { setError(`El mensaje supera el límite de ${Math.round(session.maxComposeBytes / 1024)} KB.`); return null; }
      return {
        from,
        to: splitEmails(to),
        cc: splitEmails(cc),
        bcc: splitEmails(bcc),
        subject: subject.trim(),
        text,
        ...(archiveReply ? { archiveReplyToken: archiveReply.token } : replyTo ? { replyToMessageId: replyTo.id } : {}),
      } satisfies SendInput;
    })();
    if (!input) return;
    if (!submittedInput) setSubmittedInput(input);
    setBusy(true);
    try {
      const sendResult = await apiFetch<SendResult>('/send', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey.current! }, body: JSON.stringify(input) });
      setResult(sendResult);
      if (sendResult.status === 'accepted') onSent(input.from);
      else setBusy(false);
    } catch (requestError) {
      setBusy(false);
      setError(requestError instanceof Error ? requestError.message : 'No se pudo enviar.');
    }
  };

  const close = () => { if (!busy && (!dirty || window.confirm('¿Descartar este borrador?'))) onClose(); };
  const fieldsLocked = submittedInput !== null;
  const canCheckStatus = !result || ['unknown', 'pending', 'sending'].includes(result.status);
  const actionLabel = submittedInput ? 'Consultar estado' : 'Enviar mensaje';
  return <div className="compose-backdrop" role="presentation"><div className="compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" ref={dialogRef}>
    <header className="compose-header"><button type="button" className="icon-button" aria-label="Cerrar redacción" onClick={close} ref={closeButtonRef}><ArrowLeft size={27} /></button><h1 id="compose-title">Nuevo mensaje</h1><button type="button" className="icon-button" aria-label="Descartar redacción" onClick={close}><X size={28} /></button></header>
    <form className="compose-form" onSubmit={submit}>
      <div className="compose-field compose-from"><label htmlFor="compose-from">De</label><select id="compose-from" value={from} onChange={(event) => setFrom(event.target.value)} disabled={fieldsLocked || busy}>{identities.some((identity) => normalizeEmail(identity.email) === normalizeEmail(session.mailbox.address)) ? null : <option value={session.mailbox.address}>{session.mailbox.name} &lt;{session.mailbox.address}&gt;</option>}{identities.map((identity) => <option key={identity.email} value={identity.email}>{identity.name ? `${identity.name} <${identity.email}>` : identity.email}</option>)}</select></div>
      <div className="compose-field"><label htmlFor="compose-to">Para</label><input id="compose-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="destinatario@ejemplo.com" autoComplete="email" disabled={fieldsLocked} /><button className="copies-toggle" type="button" onClick={() => setShowCopies((value) => !value)} aria-expanded={showCopies} disabled={fieldsLocked}>Cc / Cco <ChevronDown size={17} /></button></div>
      {showCopies && <><div className="compose-field"><label htmlFor="compose-cc">Cc</label><input id="compose-cc" value={cc} onChange={(event) => setCc(event.target.value)} placeholder="Opcional" disabled={fieldsLocked} /></div><div className="compose-field"><label htmlFor="compose-bcc">Cco</label><input id="compose-bcc" value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder="Opcional" disabled={fieldsLocked} /></div></>}
      <div className="compose-field"><label htmlFor="compose-subject">Asunto</label><input id="compose-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Asunto" disabled={fieldsLocked} /></div>
      <label className="sr-only" htmlFor="compose-body">Mensaje</label><textarea id="compose-body" className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder="Escribe tu mensaje" disabled={fieldsLocked} />
      <div className="compose-footer"><p>Se guardará una copia en tu correo principal.</p>{session.mode === 'local' && <span className="local-copy">Vista local · Los envíos son de prueba</span>}<div className="compose-actions"><button type="button" className="button button-secondary" onClick={close} disabled={busy}>Descartar</button><button type="submit" className="button button-primary" disabled={busy || !canCheckStatus}>{busy ? <><LoaderCircle className="spin" size={19} /> Enviando…</> : submittedInput ? actionLabel : <><Send size={19} />{actionLabel}</>}</button></div></div>
      {error && <div className="form-error" role="alert"><AlertCircle size={18} />{error}</div>}
      {result && result.status === 'unknown' && <div className="send-unknown" role="status"><AlertCircle size={18} /><span>No podemos confirmar si el proveedor aceptó este intento. No se repetirá automáticamente. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      {result && result.status === 'failed' && <div className="form-error" role="alert"><AlertCircle size={18} /><span>El envío falló y no se reintentará automáticamente. Cierra esta ventana y crea un mensaje nuevo después de revisar los destinatarios.</span></div>}
      {result && result.status === 'pending' && <div className="send-unknown" role="status"><LoaderCircle className="spin" size={18} /><span>El envío está pendiente de procesamiento. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      {result && result.status === 'sending' && <div className="send-unknown" role="status"><LoaderCircle className="spin" size={18} /><span>El envío se está procesando. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
    </form>
  </div></div>;
}
