import { AlertCircle, CalendarClock, ChevronDown, LoaderCircle, Paperclip, Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import type { Address, ArchiveReplyContext, DraftDetail, DraftInput, MessageDetail, OutgoingAttachment, SendInput, SendResult, SessionInfo } from '../../shared/contracts';
import { base64ByteLength } from '../../shared/attachments';
import { ApiRequestError, apiFetch } from '../lib/api';
import { attachmentSelectionError, containsDirectory, isFileDrag } from '../lib/attachment-selection';
import { forwardSubject, hasValidEmails, replySubject, splitEmails } from '../lib/format';
import { cleanQuotedText, splitQuotedPlainText } from '../lib/quoted-text';
import { buildForwardQuote, buildReplyQuote, joinComposeText } from '../lib/reply-quote';
import { formatScheduleDay, formatScheduleTime, fromDateTimeLocalValue, minimumScheduleValue, schedulePresets, type SchedulePreset } from '../lib/schedule';

const MAX_ATTACHMENTS_FALLBACK = 5;
const MAX_ATTACHMENT_BYTES_FALLBACK = 5 * 1024 * 1024;
const AUTOSAVE_DELAY = 1200;

type PendingAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  file?: File;
  contentBase64?: string;
};

type DraftStatus = 'idle' | 'saving' | 'saved' | 'error';

type ComposeValues = {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  attachments: PendingAttachment[];
};

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

function draftFromAddress(session: SessionInfo, draft?: DraftDetail) {
  if (!draft?.from) return undefined;
  return configuredIdentities(session).find((identity) => normalizeEmail(identity.email) === normalizeEmail(draft.from))?.email;
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

function hasComposeContent(values: ComposeValues): boolean {
  return Boolean(values.to.trim() || values.cc.trim() || values.bcc.trim() || values.subject.trim() || values.text.trim() || values.attachments.length);
}

function snapshotOf(values: ComposeValues): string {
  return JSON.stringify({
    from: values.from,
    to: values.to,
    cc: values.cc,
    bcc: values.bcc,
    subject: values.subject,
    text: values.text,
    attachments: values.attachments.map((attachment) => attachment.id),
  });
}

async function encodeAttachments(attachments: PendingAttachment[], cache: Map<string, string>): Promise<OutgoingAttachment[]> {
  const output: OutgoingAttachment[] = [];
  for (const attachment of attachments) {
    let contentBase64 = attachment.contentBase64 ?? cache.get(attachment.id);
    if (!contentBase64 && attachment.file) {
      contentBase64 = toBase64(await attachment.file.arrayBuffer());
      cache.set(attachment.id, contentBase64);
    }
    if (!contentBase64) throw new Error('No se pudo leer uno de los adjuntos.');
    output.push({ filename: attachment.filename, mimeType: attachment.mimeType, contentBase64 });
  }
  return output;
}

export default function ComposeDialog({ session, replyTo, forwardOf, archiveReply, draft, onClose, onSent, onScheduled }: {
  session: SessionInfo;
  replyTo?: MessageDetail;
  forwardOf?: MessageDetail;
  archiveReply?: ArchiveReplyContext;
  draft?: DraftDetail;
  onClose: () => void;
  onSent: (from?: string) => void;
  onScheduled: (scheduledAt: string, from?: string) => void;
}) {
  const identities = configuredIdentities(session);
  const defaultFrom = draftFromAddress(session, draft) ?? defaultFromAddress(session, replyTo, archiveReply);
  const initialRecipients = forwardOf ? { to: '', cc: '' } : replyRecipients(replyTo, identities);
  const maxAttachments = session.maxAttachments ?? MAX_ATTACHMENTS_FALLBACK;
  const maxAttachmentBytes = session.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES_FALLBACK;
  const initialAttachments = (draft?.attachments ?? []).map((attachment, index): PendingAttachment => ({
    id: `saved-${index}-${createAttemptKey()}`,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: base64ByteLength(attachment.contentBase64),
    contentBase64: attachment.contentBase64,
  }));
  const restoredDraft = draft ? splitQuotedPlainText(draft.text, { allowEmptyVisible: true }) : null;
  const initialQuote = draft
    ? (restoredDraft?.quoted ? cleanQuotedText(restoredDraft.quoted) : '')
    : (!archiveReply && forwardOf?.bodyText
      ? buildForwardQuote(forwardOf, session.brand.locale)
      : (!archiveReply && replyTo?.bodyText ? buildReplyQuote(replyTo, session.brand.locale) : ''));
  const initialText = draft ? (restoredDraft?.quoted ? restoredDraft.visible : draft.text) : '';
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(draft ? draft.to : archiveReply ? archiveReply.to.join(', ') : initialRecipients.to);
  const [cc, setCc] = useState(draft ? draft.cc : archiveReply ? archiveReply.cc.join(', ') : initialRecipients.cc);
  const [bcc, setBcc] = useState(draft?.bcc ?? '');
  const [subject, setSubject] = useState(draft ? draft.subject : archiveReply ? replySubject(archiveReply.subject) : replyTo ? replySubject(replyTo.subject) : forwardOf ? forwardSubject(forwardOf.subject) : '');
  const [text, setText] = useState(initialText);
  const [quote] = useState(initialQuote);
  const [showCopies, setShowCopies] = useState(forwardOf ? false : Boolean(draft?.cc || draft?.bcc || archiveReply?.cc.length || initialRecipients.cc));
  const [attachments, setAttachments] = useState<PendingAttachment[]>(initialAttachments);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<SendInput | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>(draft ? 'saved' : 'idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedulePresetList, setSchedulePresetList] = useState<SchedulePreset[]>([]);
  const [customSchedule, setCustomSchedule] = useState(false);
  const [customScheduleValue, setCustomScheduleValue] = useState('');
  const [pendingScheduleAt, setPendingScheduleAt] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const scheduleButtonRef = useRef<HTMLButtonElement>(null);
  const scheduleMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>(attachments);
  const dragDepth = useRef(0);
  const idempotencyKey = useRef<string | null>(null);
  const submitting = useRef(false);
  const draftId = useRef(draft?.id ?? createAttemptKey());
  const draftExists = useRef(Boolean(draft?.id));
  const attachmentCache = useRef(new Map<string, string>());
  const savePromise = useRef<Promise<boolean> | null>(null);
  const discardingRef = useRef(false);
  const closingRef = useRef(false);
  const valuesRef = useRef<ComposeValues>({ from, to, cc, bcc, subject, text, attachments });
  const replyTargetId = draft?.replyToMessageId ?? (forwardOf ? undefined : replyTo?.id);
  const archiveReplyToken = draft?.archiveReplyToken ?? archiveReply?.token;
  const fieldsLocked = busy || discarding || submittedInput !== null;
  const snapshot = snapshotOf({ from, to, cc, bcc, subject, text, attachments });
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
  const dirty = snapshot !== savedSnapshot;
  const dirtyRef = useRef(dirty);
  valuesRef.current = { from, to, cc, bcc, subject, text, attachments };
  dirtyRef.current = dirty;
  if (!idempotencyKey.current) idempotencyKey.current = createAttemptKey();

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (discardingRef.current) return false;
    if (savePromise.current) return savePromise.current;
    if (!dirtyRef.current) {
      if (draftExists.current) setDraftStatus('saved');
      return true;
    }
    const current = valuesRef.current;
    if (!draftExists.current && !hasComposeContent(current)) return true;
    const snapshotAtSave = snapshotOf(current);
    const promise = (async () => {
      setDraftStatus('saving');
      setSaveError(null);
      try {
        const outgoing = await encodeAttachments(current.attachments, attachmentCache.current);
        const input: DraftInput = {
          from: current.from,
          to: current.to,
          cc: current.cc,
          bcc: current.bcc,
          subject: current.subject,
          text: joinComposeText(current.text, quote),
          ...(outgoing.length ? { attachments: outgoing } : {}),
          ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
          ...(archiveReplyToken ? { archiveReplyToken } : {}),
        };
        await apiFetch<DraftDetail>(`/drafts/${encodeURIComponent(draftId.current)}`, { method: 'PUT', body: JSON.stringify(input) });
        draftExists.current = true;
        if (snapshotOf(valuesRef.current) === snapshotAtSave) dirtyRef.current = false;
        setSavedSnapshot(snapshotAtSave);
        setDraftStatus('saved');
        return true;
      } catch (requestError) {
        setDraftStatus('error');
        setSaveError(requestError instanceof Error ? requestError.message : 'No se pudo guardar el borrador.');
        return false;
      }
    })();
    savePromise.current = promise;
    try {
      return await promise;
    } finally {
      savePromise.current = null;
    }
  }, [archiveReplyToken, quote, replyTargetId]);

  useEffect(() => {
    if (!dirty || fieldsLocked) return;
    const timer = window.setTimeout(() => { void saveDraft(); }, AUTOSAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [dirty, fieldsLocked, saveDraft, snapshot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (scheduleOpen) {
          event.preventDefault();
          setScheduleOpen(false);
          return;
        }
        event.preventDefault();
        void close();
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
  }, [close, scheduleOpen]);

  useEffect(() => {
    if (!scheduleOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (scheduleMenuRef.current?.contains(target) || scheduleButtonRef.current?.contains(target)) return;
      setScheduleOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [scheduleOpen]);

  const flushDraft = useCallback(async (): Promise<boolean> => {
    if (!draftExists.current && !hasComposeContent(valuesRef.current)) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const saved = await saveDraft();
      if (!saved) return false;
      if (!dirtyRef.current) return true;
    }
    return !dirtyRef.current;
  }, [saveDraft]);

  async function close() {
    if (busy || discardingRef.current || closingRef.current) return;
    closingRef.current = true;
    const saved = await flushDraft();
    closingRef.current = false;
    if (saved) onClose();
    else setError('No se pudo guardar el borrador. Revisa la conexión e inténtalo de nuevo.');
  }

  async function discard() {
    if (busy || discardingRef.current) return;
    if (!draftExists.current && !hasComposeContent(valuesRef.current)) {
      onClose();
      return;
    }
    if ((dirtyRef.current || draftExists.current) && !window.confirm('¿Descartar este borrador?')) return;
    discardingRef.current = true;
    setDiscarding(true);
    setError(null);
    try {
      if (savePromise.current) await savePromise.current.catch(() => false);
      await apiFetch<void>(`/drafts/${encodeURIComponent(draftId.current)}`, { method: 'DELETE' });
      draftExists.current = false;
      onClose();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo descartar el borrador.');
    } finally {
      discardingRef.current = false;
      setDiscarding(false);
    }
  }

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
    const next = [...current, ...selected.map((file) => ({ id: createAttemptKey(), filename: file.name, file, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size }))];
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

  async function dispatch(scheduledAt?: string) {
    if (submitting.current) return;
    setError(null);
    setResult(null);
    setScheduleOpen(false);
    let input = submittedInput;
    if (!input) {
      if (!splitEmails(to).length || !hasValidEmails(to) || !hasValidEmails(cc) || !hasValidEmails(bcc)) { setError('Revisa las direcciones de destinatarios.'); return; }
      if (!subject.trim()) { setError('Escribe un asunto.'); return; }
      const compose = { to: splitEmails(to).map(normalizeEmail), cc: splitEmails(cc).map(normalizeEmail), bcc: splitEmails(bcc).map(normalizeEmail), subject: subject.trim(), text: joinComposeText(text, quote) };
      if (compose.subject.length > 255 || /[\r\n]/.test(compose.subject)) { setError('El asunto debe tener como máximo 255 caracteres y una sola línea.'); return; }
      const archiveAddress = normalizeEmail(session.archiveAddress || session.user.email);
      const counted = { ...compose, bcc: [...compose.bcc] };
      if (![...counted.to, ...counted.cc, ...counted.bcc].includes(archiveAddress)) counted.bcc.push(archiveAddress);
      if (new Blob([JSON.stringify(counted)]).size > session.maxComposeBytes) { setError(`El mensaje supera el límite de ${Math.round(session.maxComposeBytes / 1024)} KB.`); return; }
      submitting.current = true;
      setBusy(true);
      let outgoing: OutgoingAttachment[] = [];
      try {
        outgoing = await encodeAttachments(attachments, attachmentCache.current);
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
        ...(archiveReplyToken ? { archiveReplyToken } : replyTargetId ? { replyToMessageId: replyTargetId } : {}),
        draftId: draftId.current,
        ...(scheduledAt ? { scheduledAt } : {}),
      } satisfies SendInput;
      setSubmittedInput(input);
      setPendingScheduleAt(scheduledAt ?? null);
    }
    submitting.current = true;
    setBusy(true);
    try {
      const sendResult = await apiFetch<SendResult>('/send', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey.current! }, body: JSON.stringify(input) });
      setResult(sendResult);
      if (sendResult.status === 'scheduled') {
        draftExists.current = false;
        void apiFetch<void>(`/drafts/${encodeURIComponent(draftId.current)}`, { method: 'DELETE' }).catch(() => undefined);
        onScheduled(sendResult.scheduledAt ?? scheduledAt ?? input.scheduledAt ?? new Date().toISOString(), input.from);
      } else if (sendResult.status === 'accepted') {
        draftExists.current = false;
        void apiFetch<void>(`/drafts/${encodeURIComponent(draftId.current)}`, { method: 'DELETE' }).catch(() => undefined);
        onSent(input.from);
      } else {
        setBusy(false);
        setPendingScheduleAt(null);
      }
    } catch (requestError) {
      setBusy(false);
      setPendingScheduleAt(null);
      // These errors are returned before the server records or sends an attempt.
      // An ambiguous network failure keeps the original input and attempt key.
      if (requestError instanceof ApiRequestError && [400, 413, 415].includes(requestError.status)) {
        setSubmittedInput(null);
        idempotencyKey.current = createAttemptKey();
      }
      setError(requestError instanceof Error ? requestError.message : 'No se pudo enviar.');
    } finally {
      submitting.current = false;
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void dispatch();
  };

  const toggleScheduleMenu = () => {
    if (fieldsLocked) return;
    setError(null);
    if (!scheduleOpen) {
      setSchedulePresetList(schedulePresets(new Date()));
      setCustomSchedule(false);
      setCustomScheduleValue(minimumScheduleValue());
    }
    setScheduleOpen((open) => !open);
  };

  const scheduleFor = (value: Date) => {
    if (value.getTime() < Date.now() + 60_000) {
      setError('Elige una fecha y hora con al menos un minuto de anticipación.');
      return;
    }
    void dispatch(value.toISOString());
  };

  const scheduleCustom = () => {
    const value = fromDateTimeLocalValue(customScheduleValue);
    if (!value || value.getTime() < Date.now() + 60_000) {
      setError('Elige una fecha y hora con al menos un minuto de anticipación.');
      return;
    }
    void dispatch(value.toISOString());
  };

  const canCheckStatus = !result || ['unknown', 'pending', 'sending'].includes(result.status);
  const actionLabel = submittedInput ? 'Consultar estado' : 'Enviar';
  const busyLabel = pendingScheduleAt ? 'Programando…' : 'Enviando…';
  const attachmentTotal = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
  const statusLabel = draftStatus === 'saving' ? 'Guardando…' : draftStatus === 'saved' ? 'Borrador guardado' : draftStatus === 'error' ? 'No se pudo guardar' : dirty ? 'Sin guardar' : draft ? 'Borrador guardado' : '';
  return <div className="compose-backdrop" role="presentation"><div className="compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" ref={dialogRef} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {dragActive && !fieldsLocked && <div className="compose-dropzone" role="status" aria-live="polite"><Paperclip size={30} /><strong>Suelta los archivos para adjuntarlos</strong><span>Se añadirán a este mensaje y no se enviará automáticamente.</span></div>}
    <header className="compose-header"><h1 id="compose-title">{draft ? 'Borrador' : forwardOf ? 'Reenviar' : replyTo || archiveReply ? 'Responder' : 'Mensaje nuevo'}</h1><button type="button" className="icon-button compose-close" aria-label="Cerrar y guardar borrador" title="Cerrar" onClick={() => void close()} ref={closeButtonRef} disabled={busy || discarding}><X size={22} /></button></header>
    <form className="compose-form" onSubmit={submit}>
      <div className="compose-field compose-from"><label htmlFor="compose-from">De</label><select id="compose-from" value={from} onChange={(event) => setFrom(event.target.value)} disabled={fieldsLocked || busy}>{identities.some((identity) => normalizeEmail(identity.email) === normalizeEmail(session.mailbox.address)) ? null : <option value={session.mailbox.address}>{session.mailbox.name} &lt;{session.mailbox.address}&gt;</option>}{identities.map((identity) => <option key={identity.email} value={identity.email}>{identity.name ? `${identity.name} <${identity.email}>` : identity.email}</option>)}</select></div>
      <div className="compose-field"><label htmlFor="compose-to">Para</label><input id="compose-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="destinatario@ejemplo.com" autoComplete="email" disabled={fieldsLocked} /><button className="copies-toggle" type="button" onClick={() => setShowCopies((value) => !value)} aria-expanded={showCopies} disabled={fieldsLocked}>Cc / Cco <ChevronDown size={17} /></button></div>
      {showCopies && <><div className="compose-field"><label htmlFor="compose-cc">Cc</label><input id="compose-cc" value={cc} onChange={(event) => setCc(event.target.value)} placeholder="Opcional" disabled={fieldsLocked} /></div><div className="compose-field"><label htmlFor="compose-bcc">Cco</label><input id="compose-bcc" value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder="Opcional" disabled={fieldsLocked} /></div></>}
      <div className="compose-field"><label htmlFor="compose-subject">Asunto</label><input id="compose-subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Asunto" disabled={fieldsLocked} /></div>
      <label className="sr-only" htmlFor="compose-body">Mensaje</label><textarea id="compose-body" className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder="Escribe tu mensaje" disabled={fieldsLocked} />
      {quote && <details className="trimmed-quote compose-quote"><summary aria-label="Mostrar texto citado" title="Mostrar texto citado">•••</summary><div className="quoted-text compose-quote-content">{quote}</div></details>}
      <input ref={fileInputRef} id="compose-files" type="file" multiple hidden onChange={addFilesFromPicker} disabled={fieldsLocked} />
      {attachments.length > 0 && <div className="compose-attachments"><div className="compose-attachment-meta"><span>{attachments.length}/{maxAttachments} archivos</span><span>{formatSize(attachmentTotal)} de {formatSize(maxAttachmentBytes)}</span></div><ul className="compose-file-list">{attachments.map((attachment) => <li key={attachment.id}><Paperclip size={15} /><span>{attachment.filename}</span><small>{formatSize(attachment.sizeBytes)}</small><button type="button" className="icon-button" aria-label={`Quitar ${attachment.filename}`} onClick={() => removeAttachment(attachment.id)} disabled={fieldsLocked}><Trash2 size={15} /></button></li>)}</ul></div>}
      {error && <div className="form-error" role="alert"><AlertCircle size={18} />{error}</div>}
      {result && result.status === 'unknown' && <div className="send-unknown" role="status"><AlertCircle size={18} /><span>No podemos confirmar si el proveedor aceptó este intento. No se repetirá automáticamente. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      {result && result.status === 'failed' && <div className="form-error" role="alert"><AlertCircle size={18} /><span>El envío falló y no se reintentará automáticamente. Cierra esta ventana y crea un mensaje nuevo después de revisar los destinatarios.</span></div>}
      {result && result.status === 'pending' && <div className="send-unknown" role="status"><LoaderCircle className="spin" size={18} /><span>El envío está pendiente de procesamiento. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      {result && result.status === 'sending' && <div className="send-unknown" role="status"><LoaderCircle className="spin" size={18} /><span>El envío se está procesando. Revisa Enviados antes de crear un mensaje nuevo; puedes consultar el estado aquí.</span></div>}
      <div className="compose-footer">
        <div className="compose-icon-actions">
          <button type="button" className="icon-button" aria-label="Adjuntar archivos" title="Adjuntar archivos" onClick={() => fileInputRef.current?.click()} disabled={fieldsLocked || attachments.length >= maxAttachments}><Paperclip size={19} /></button>
          <button type="button" className="icon-button" aria-label="Descartar borrador" title="Descartar" onClick={() => void discard()} disabled={busy || discarding}>{discarding ? <LoaderCircle className="spin" size={18} /> : <Trash2 size={18} />}</button>
        </div>
        <div className="compose-footer-note"><span className={`draft-status ${draftStatus}`} title={saveError ?? undefined}>{statusLabel}</span>{draftStatus === 'error' && <button type="button" className="text-button draft-retry" onClick={() => void saveDraft()}>Reintentar</button>}<span className="compose-archive-note" title={`Se guardará una copia en ${session.archiveAddress || session.user.email}`}>Copia al archivo</span></div>
        <div className="compose-actions">
          {submittedInput
            ? <button type="submit" className="button button-primary send-single" disabled={busy || discarding || !canCheckStatus}>{busy ? <><LoaderCircle className="spin" size={18} />{busyLabel}</> : actionLabel}</button>
            : <div className="send-split">
              <button type="submit" className="button button-primary send-main" disabled={busy || discarding}>{busy ? <><LoaderCircle className="spin" size={18} />{busyLabel}</> : <><Send size={18} />Enviar</>}</button>
              <button ref={scheduleButtonRef} type="button" className="button button-primary send-arrow" aria-label="Programar envío" title="Programar envío" aria-haspopup="menu" aria-expanded={scheduleOpen} onClick={toggleScheduleMenu} disabled={busy || discarding}><ChevronDown size={17} /></button>
            </div>}
        </div>
        {session.mode === 'local' && <span className="local-copy">Vista local · Los envíos son de prueba</span>}
      </div>
    </form>
    {scheduleOpen && <div className="schedule-popover" role="menu" aria-label="Programar envío" ref={scheduleMenuRef}>
      {!customSchedule ? <>
        <div className="schedule-title">Programar envío</div>
        {schedulePresetList.map((preset) => <button key={preset.id} type="button" role="menuitem" className="schedule-option" onClick={() => scheduleFor(preset.value)}><span className="schedule-option-copy"><strong>{preset.label}</strong><small>{formatScheduleDay(preset.value, session.brand.locale)}</small></span><span className="schedule-option-time">{formatScheduleTime(preset.value, session.brand.locale)}</span></button>)}
        <div className="schedule-divider" />
        <button type="button" role="menuitem" className="schedule-option schedule-custom-option" onClick={() => { setCustomSchedule(true); setCustomScheduleValue(minimumScheduleValue()); }}><CalendarClock size={17} /><span>Elegir fecha y hora</span></button>
      </> : <>
        <div className="schedule-title">Elegir fecha y hora</div>
        <div className="schedule-custom">
          <label htmlFor="compose-schedule-at">Hora local</label>
          <input id="compose-schedule-at" type="datetime-local" min={minimumScheduleValue()} value={customScheduleValue} onChange={(event) => setCustomScheduleValue(event.target.value)} autoFocus />
          <p>El envío saldrá con al menos un minuto de diferencia.</p>
          <div className="schedule-custom-actions"><button type="button" className="text-button" onClick={() => setCustomSchedule(false)}>Volver</button><button type="button" className="button button-primary" onClick={scheduleCustom}>Programar envío</button></div>
        </div>
      </>}
    </div>}
  </div></div>;
}
