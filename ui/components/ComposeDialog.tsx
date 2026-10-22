import { AlertCircle, ArrowLeft, ChevronDown, LoaderCircle, Paperclip, Send, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import type { Address, ArchiveReplyContext, MessageDetail, OutgoingAttachment, SendInput, SendResult, SessionInfo } from '../../shared/contracts';
import { ApiRequestError, apiFetch } from '../lib/api';
import { attachmentSelectionError, containsDirectory, isFileDrag } from '../lib/attachment-selection';
import { hasValidEmails, replySubject, splitEmails } from '../lib/format';

const MAX_ATTACHMENTS_FALLBACK = 5;
const MAX_ATTACHMENT_BYTES_FALLBACK = 5 * 1024 * 1024;

type PendingAttachment = { id: string; file: File; mimeType: string; sizeBytes: number };

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

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ComposeDialog({ session, replyTo, archiveReply, onClose, onSent }: { session: SessionInfo; replyTo?: MessageDetail; archiveReply?: ArchiveReplyContext; onClose: () => void; onSent: (from?: string) => void }) {
  const identities = configuredIdentities(session);
  const defaultFrom = defaultFromAddress(session, replyTo, archiveReply);
  const initialRecipients = replyRecipients(replyTo, identities);
  const maxAttachments = session.maxAttachments ?? MAX_ATTACHMENTS_FALLBACK;
  const maxAttachmentBytes = session.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES_FALLBACK;
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(archiveReply ? archiveReply.to.join(', ') : initialRecipients.to);
  const [cc, setCc] = useState(archiveReply ? archiveReply.cc.join(', ') : initialRecipients.cc);
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(archiveReply ? replySubject(archiveReply.subject) : replyTo ? replySubject(replyTo.subject) : '');
  const [text, setText] = useState(() => !archiveReply && replyTo?.bodyText ? `\n\n\n${replyTo.bodyText.split('\n').map((line) => `> ${line}`).join('\n')}` : '');
  const [showCopies, setShowCopies] = useState(Boolean(archiveReply?.cc.length || initialRecipients.cc));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<SendInput | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const dragDepth = useRef(0);
  const idempotencyKey = useRef<string | null>(null);
  const submitting = useRef(false);
  if (!idempotencyKey.current) idempotencyKey.current = createAttemptKey();
  const dirty = Boolean(to || cc || bcc || subject || text || attachments.length || from !== defaultFrom);
  const fieldsLocked = busy || submittedInput !== null;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

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

  const addFiles = (selected: File[]) => {
    if (!selected.length || fieldsLocked) return;
    setError(null);
    const current = attachmentsRef.current;
    const currentBytes = current.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    const validationError = attachmentSelectionError(
      selected,
      current.length,
      currentBytes,
      maxAttachments,
      maxAttachmentBytes,
      formatSize,
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    const next = [...current, ...selected.map((file) => ({ id: createAttemptKey(), file, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size }))];
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const addFilesFromPicker = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    addFiles(selected);
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  useEffect(() => {
    const resetDrag = () => {
      dragDepth.current = 0;
      setDragActive(false);
    };
    const onWindowDragOver = (event: globalThis.DragEvent) => {
      if (isFileDrag(event.dataTransfer?.types)) event.preventDefault();
    };
    const onWindowDrop = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event.dataTransfer?.types)) return;
      // Never let a file drop navigate the browser away from the webmail.
      event.preventDefault();
      resetDrag();
      if (dialogRef.current?.contains(event.target as Node) || fieldsLocked) return;
      setError('Suelta los archivos sobre la redacción para adjuntarlos.');
    };
    const onWindowDragLeave = (event: globalThis.DragEvent) => {
      // Some browsers expose an empty types list on dragleave. If the pointer
      // leaves the window entirely, reset regardless of the advertised type.
      if (!event.relatedTarget) resetDrag();
    };
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('drop', onWindowDrop);
    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('dragend', resetDrag);
    return () => {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('dragend', resetDrag);
    };
  }, [fieldsLocked]);

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    if (fieldsLocked) return;
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = fieldsLocked ? 'none' : 'copy';
  };

  const onDragLeave = () => {
    // Leave events are unreliable about types, so pair every enter event with
    // a decrement while the overlay is active. Text drags never increment.
    if (dragDepth.current === 0) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    if (fieldsLocked) {
      setError('Espera a que termine el envío antes de añadir adjuntos.');
      return;
    }
    if (containsDirectory(event.dataTransfer.items)) {
      setError('No se pueden adjuntar carpetas. Selecciona uno o varios archivos.');
      return;
    }
    addFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setError(null);
    let input = submittedInput;
    if (!input) {
      if (!splitEmails(to).length || !hasValidEmails(to) || !hasValidEmails(cc) || !hasValidEmails(bcc)) { setError('Revisa las direcciones de destinatarios.'); return; }
      if (!subject.trim()) { setError('Escribe un asunto.'); return; }
      const compose = { to: splitEmails(to).map(normalizeEmail), cc: splitEmails(cc).map(normalizeEmail), bcc: splitEmails(bcc).map(normalizeEmail), subject: subject.trim(), text };
      if (compose.subject.length > 255 || /[\r\n]/.test(compose.subject)) { setError('El asunto debe tener como máximo 255 caracteres y una sola línea.'); return; }
      const archiveAddress = normalizeEmail(session.archiveAddress || session.user.email);
      const counted = { ...compose, bcc: [...compose.bcc] };
      if (![...counted.to, ...counted.cc, ...counted.bcc].includes(archiveAddress)) counted.bcc.push(archiveAddress);
      if (new Blob([JSON.stringify(counted)]).size > session.maxComposeBytes) { setError(`El mensaje supera el límite de ${Math.round(session.maxComposeBytes / 1024)} KB.`); return; }
      submitting.current = true;
      setBusy(true);
      const outgoing: OutgoingAttachment[] = [];
      try {
        for (const attachment of attachments) {
          outgoing.push({ filename: attachment.file.name, mimeType: attachment.mimeType, contentBase64: toBase64(await attachment.file.arrayBuffer()) });
        }
      } catch {
        submitting.current = false;
        setBusy(false);
        setError('No se pudieron leer los adjuntos seleccionados.');
        return;
      }
      input = {
        from,
        ...compose,
        ...(outgoing.length ? { attachments: outgoing } : {}),
        ...(archiveReply ? { archiveReplyToken: archiveReply.token } : replyTo ? { replyToMessageId: replyTo.id } : {}),
      } satisfies SendInput;
      setSubmittedInput(input);
    }
    submitting.current = true;
    setBusy(true);
    try {
      const sendResult = await apiFetch<SendResult>('/send', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey.current! }, body: JSON.stringify(input) });
      setResult(sendResult);
      if (sendResult.status === 'accepted') onSent(input.from);
      else setBusy(false);
    } catch (requestError) {
      setBusy(false);
      // These errors are returned before the server records or sends an attempt.
      // An ambiguous network failure keeps the original input and attempt key.
      if (!submittedInput && requestError instanceof ApiRequestError && [400, 413, 415].includes(requestError.status)) {
        setSubmittedInput(null);
        idempotencyKey.current = createAttemptKey();
      }
      setError(requestError instanceof Error ? requestError.message : 'No se pudo enviar.');
    } finally {
      submitting.current = false;
    }
  };

  const close = () => { if (!busy && (!dirty || window.confirm('¿Descartar este borrador?'))) onClose(); };
  const canCheckStatus = !result || ['unknown', 'pending', 'sending'].includes(result.status);
  const actionLabel = submittedInput ? 'Consultar estado' : 'Enviar mensaje';
  const attachmentTotal = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
  return <div className="compose-backdrop" role="presentation"><div className="compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" ref={dialogRef} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {dragActive && !fieldsLocked && <div className="compose-dropzone" role="status" aria-live="polite"><Paperclip size={30} /><strong>Suelta los archivos para adjuntarlos</strong><span>Se añadirán a este mensaje y no se enviará automáticamente.</span></div>}
    <header className="compose-header"><button type="button" className="icon-button" aria-label="Cerrar redacción" onClick={close} ref={closeButtonRef}><ArrowLeft size={27} /></button><h1 id="compose-title">Nuevo mensaje</h1><button type="button" className="icon-button" aria-label="Descartar redacción" onClick={close}><X size={28} /></button></header>
    <form className="compose-form" onSubmit={submit}>
      <div className="compose-field compose-from"><label htmlFor="compose-from">De</label><select id="compose-from" value={from} onChange={(event) => setFrom(event.target.value)} disabled={fieldsLocked || busy}>{identities.some((identity) => normalizeEmail(identity.email) === normalizeEmail(session.mailbox.address)) ? null : <option value={session.mailbox.address}>{session.mailbox.name} &lt;{session.mailbox.address}&gt;</option>}{identities.map((identity) => <option key={identity.email} value={identity.email}>{identity.name ? `${identity.name} <${identity.email}>` : identity.email}</option>)}</select></div>
      <div className="compose-field"><label htmlFor="compose-to">Para</label><input id="compose-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="destinatario@ejemplo.com" autoComplete="email" disabled={fieldsLocked} /><button className="copies-toggle" type="button" onClick={() => setShowCopies((value) => !value)} aria-expanded={showCopies} disabled={fieldsLocked}>Cc / Cco <ChevronDown size={17} /></button></div>
      {showCopies && <><div className="compose-field"><label htmlFor="compose-cc">Cc</label><input id="compose-cc" value={cc} onChange={(event) => setCc(event.target.value)} placeholder="Opcional" disabled={fieldsLocked} /></div><div className="compose-field"><label htmlFor="compose-bcc">Cco</label><input id="compose-bcc" value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder="Opcional" disabled={fieldsLocked} /></div></>}
      <div className="compose-field"><label htmlFor="compose-subject">Asunto</label><input id="compose-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Asunto" disabled={fieldsLocked} /></div>
      <label className="sr-only" htmlFor="compose-body">Mensaje</label><textarea id="compose-body" className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder="Escribe tu mensaje" disabled={fieldsLocked} />
      <div className="compose-attachments">
        <input ref={fileInputRef} id="compose-files" type="file" multiple hidden onChange={addFilesFromPicker} disabled={fieldsLocked} />
        <div className="compose-attachments-head"><button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()} disabled={fieldsLocked || attachments.length >= maxAttachments}><Paperclip size={17} />Adjuntar archivos</button><span>{attachments.length}/{maxAttachments} · {formatSize(attachmentTotal)} de {formatSize(maxAttachmentBytes)}</span></div>
        <p className="compose-drop-hint">También puedes arrastrar archivos desde el explorador hasta esta redacción.</p>
        {attachments.length > 0 && <ul className="compose-file-list">{attachments.map((attachment) => <li key={attachment.id}><Paperclip size={15} /><span>{attachment.file.name}</span><small>{formatSize(attachment.sizeBytes)}</small><button type="button" className="icon-button" aria-label={`Quitar ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)} disabled={fieldsLocked}><Trash2 size={16} /></button></li>)}</ul>}
      </div>
      <div className="compose-footer"><p>Se guardará una copia en tu correo principal.</p>{session.mode === 'local' && <span className="local-copy">Vista local · Los envíos son de prueba</span>}<div className="compose-actions"><button type="button" className="button button-secondary" onClick={close} disabled={busy}>Descartar</button><button type="submit" className="button button-primary" disabled={busy || !canCheckStatus}>{busy ? <><LoaderCircle className="spin" size={19} /> Enviando…</> : submittedInput ? actionLabel : <><Send size={19} />{actionLabel}</>}</button></div></div>
      {error && <div className="form-error" role="alert"><AlertCircle size={18} />{error}</div>}
      {result && result.status === 'unknown' && <div className="send-unknown" role="status"><AlertCircle size={18} /><span>No podemos confirmar si el proveedor aceptó este intento. No se repetirá automáticamente. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      {result && result.status === 'failed' && <div className="form-error" role="alert"><AlertCircle size={18} /><span>El envío falló y no se reintentará automáticamente. Cierra esta ventana y crea un mensaje nuevo después de revisar los destinatarios.</span></div>}
      {result && result.status === 'pending' && <div className="send-unknown" role="status"><LoaderCircle className="spin" size={18} /><span>El envío está pendiente de procesamiento. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      {result && result.status === 'sending' && <div className="send-unknown" role="status"><LoaderCircle className="spin" size={18} /><span>El envío se está procesando. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
    </form>
  </div></div>;
}
