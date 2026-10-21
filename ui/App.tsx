import { LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ArchiveReplyContext, AuthOptions, Brand, Folder, MessageDetail, MessagePage, MessageSummary, SessionInfo } from '../shared/contracts';
import ComposeDialog from './components/ComposeDialog';
import LoginScreen from './components/LoginScreen';
import MessageListPanel from './components/MessageListPanel';
import ReaderPanel from './components/ReaderPanel';
import Sidebar from './components/Sidebar';
import StartupScreen from './components/StartupScreen';
import { apiFetch, ApiRequestError, getSession, MAX_DOWNLOAD_BYTES, MAX_PREVIEW_BYTES, parseRawInWorker, requestOutgoingAttachment, requestRaw, type Attachment } from './lib/api';
import { downloadBlob } from './lib/format';

type AuthQueryError = 'denied' | 'failed';
type StartupState = { status: 'loading' }
  | { status: 'ready'; session: SessionInfo }
  | { status: 'login'; options: AuthOptions; authError?: AuthQueryError }
  | { status: 'error'; error: ApiRequestError };
type MobileView = 'list' | 'reader';
type ComposeState = { replyTo?: MessageDetail; archiveReply?: ArchiveReplyContext };

function isArchiveReplyContext(value: unknown, token: string): value is ArchiveReplyContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Partial<ArchiveReplyContext>;
  return context.token === token
    && (context.from === undefined || typeof context.from === 'string')
    && Array.isArray(context.to) && context.to.every((email) => typeof email === 'string')
    && Array.isArray(context.cc) && context.cc.every((email) => typeof email === 'string')
    && typeof context.subject === 'string'
    && (context.direction === 'incoming' || context.direction === 'outgoing');
}

function removeArchiveReplyParam(token: string) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('reply') !== token) return;
  url.searchParams.delete('reply');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function takeAuthErrorParam(): AuthQueryError | undefined {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('authError')) return undefined;
  const value = url.searchParams.get('authError');
  url.searchParams.delete('authError');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return value === 'denied' || value === 'failed' ? value : undefined;
}

function isAuthOptions(value: unknown): value is AuthOptions {
  if (!value || typeof value !== 'object') return false;
  const options = value as Partial<AuthOptions>;
  const brand = options.brand as Partial<Brand> | undefined;
  return (options.provider === 'google' || options.provider === 'access' || options.provider === 'local')
    && !!brand
    && typeof brand.name === 'string'
    && typeof brand.logo === 'string'
    && typeof brand.primaryColor === 'string'
    && typeof brand.locale === 'string';
}

function asApiRequestError(error: unknown, fallback: string): ApiRequestError {
  return error instanceof ApiRequestError ? error : new ApiRequestError(500, fallback);
}

export default function App() {
  const [startup, setStartup] = useState<StartupState>({ status: 'loading' });
  const authQueryErrorRef = useRef<AuthQueryError | undefined>(undefined);
  const authQueryErrorLoadedRef = useRef(false);
  const unauthenticatedHandledRef = useRef(false);
  const sessionLoadGenerationRef = useRef(0);
  const loadSession = useCallback(() => {
    const generation = ++sessionLoadGenerationRef.current;
    const isCurrent = () => generation === sessionLoadGenerationRef.current;
    setStartup({ status: 'loading' });
    void (async () => {
      try {
        const session = await getSession();
        if (!isCurrent()) return;
        setStartup({ status: 'ready', session });
      } catch (sessionError) {
        if (!isCurrent()) return;
        const error = asApiRequestError(sessionError, 'No se pudo abrir el webmail.');
        if (error.status === 401 || error.status === 403) {
          try {
            const optionsValue: unknown = await apiFetch('/auth/options');
            if (!isCurrent()) return;
            if (!isAuthOptions(optionsValue)) throw new ApiRequestError(500, 'No se pudo abrir el webmail.');
            if (optionsValue.provider === 'google') {
              setStartup({ status: 'login', options: optionsValue, authError: authQueryErrorRef.current });
              authQueryErrorRef.current = undefined;
              return;
            }
          } catch (optionsError) {
            if (!isCurrent()) return;
            setStartup({ status: 'error', error: asApiRequestError(optionsError, 'No se pudo cargar la configuración de acceso.') });
            return;
          }
        }
        if (!isCurrent()) return;
        setStartup({ status: 'error', error });
      }
    })();
  }, []);

  useEffect(() => {
    if (!authQueryErrorLoadedRef.current) {
      authQueryErrorRef.current = takeAuthErrorParam();
      authQueryErrorLoadedRef.current = true;
    }
    loadSession();
  }, [loadSession]);
  useEffect(() => {
    if (startup.status !== 'ready') return;
    unauthenticatedHandledRef.current = false;
    const handleUnauthenticated = () => {
      if (unauthenticatedHandledRef.current) return;
      unauthenticatedHandledRef.current = true;
      loadSession();
    };
    window.addEventListener('webmail:unauthenticated', handleUnauthenticated);
    return () => window.removeEventListener('webmail:unauthenticated', handleUnauthenticated);
  }, [startup.status, loadSession]);

  if (startup.status === 'loading') return <main className="startup-screen"><LoaderCircle className="spin" aria-label="Cargando" /></main>;
  if (startup.status === 'login') return <LoginScreen brand={startup.options.brand} authError={startup.authError} />;
  if (startup.status === 'error') return <StartupScreen error={startup.error} onRetry={loadSession} />;
  return <MailApp session={startup.session} />;
}

function MailApp({ session }: { session: SessionInfo }) {
  const [folder, setFolder] = useState<Folder>('inbox');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [identityFilter, setIdentityFilter] = useState('');
  const [items, setItems] = useState<MessageSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>('list');
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [bodyText, setBodyText] = useState<string | null>(null);
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyStyles, setBodyStyles] = useState('');
  const [remoteImages, setRemoteImages] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [seedLoading, setSeedLoading] = useState(false);
  const [usageAlertTestBusy, setUsageAlertTestBusy] = useState(false);
  const [usageAlertTestPending, setUsageAlertTestPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const nextCursorRef = useRef<string | null>(null);
  const folderRequestSequenceRef = useRef(0);
  const folderRequestControllerRef = useRef<AbortController | null>(null);
  const archiveReplyStartedRef = useRef<string | null>(null);
  const archiveReplyMountedRef = useRef(false);

  useEffect(() => {
    archiveReplyMountedRef.current = true;
    const token = new URL(window.location.href).searchParams.get('reply');
    if (token === null || archiveReplyStartedRef.current === token) {
      return () => { archiveReplyMountedRef.current = false; };
    }
    archiveReplyStartedRef.current = token;

    const invalidLinkNotice = 'Este enlace de respuesta no es válido para este webmail. Contacta al administrador.';
    const openFailureNotice = 'No se pudo abrir la respuesta desde el correo. Vuelve a abrir el enlace o contacta al administrador.';
    const fail = (message: string) => {
      if (!archiveReplyMountedRef.current) return;
      removeArchiveReplyParam(token);
      setNotice(message);
    };

    if (!token || token.length > 8192) {
      fail(invalidLinkNotice);
      return () => { archiveReplyMountedRef.current = false; };
    }

    // Keep the in-flight request across StrictMode's effect replay so the token is queried once.
    void apiFetch<ArchiveReplyContext>(`/archive-reply?token=${encodeURIComponent(token)}`)
      .then((context) => {
        if (!archiveReplyMountedRef.current) return;
        if (!isArchiveReplyContext(context, token)) {
          fail(invalidLinkNotice);
          return;
        }
        removeArchiveReplyParam(token);
        setNotice(null);
        setCompose({ archiveReply: context });
      })
      .catch((error: unknown) => {
        if (!archiveReplyMountedRef.current) return;
        const invalid = error instanceof ApiRequestError && (error.status === 400 || error.status === 403);
        fail(invalid ? invalidLinkNotice : openFailureNotice);
      });

    // Do not abort this GET here: StrictMode runs cleanup before replaying the effect.
    return () => { archiveReplyMountedRef.current = false; };
  }, []);

  useEffect(() => { document.title = `${session.brand.name} Correo`; }, [session.brand.name]);

  const markRead = useCallback(async (id: string, read: boolean) => {
    try {
      await apiFetch<void>(`/messages/${encodeURIComponent(id)}/read`, { method: 'PATCH', body: JSON.stringify({ read }) });
      setItems((current) => current.map((item) => item.id === id ? { ...item, isRead: read } : item));
      setDetail((current) => current && current.id === id ? { ...current, isRead: read } : current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo actualizar el estado.');
    }
  }, []);

  useEffect(() => { nextCursorRef.current = nextCursor; }, [nextCursor]);

  const loadFolder = useCallback(async (reset: boolean) => {
    const requestSequence = folderRequestSequenceRef.current + 1;
    folderRequestSequenceRef.current = requestSequence;
    folderRequestControllerRef.current?.abort();
    const controller = new AbortController();
    folderRequestControllerRef.current = controller;
    setListLoading(true);
    setListError(null);
    if (reset) {
      nextCursorRef.current = null;
      setNextCursor(null);
      setItems([]);
      setSelectedId(null);
    }
    const cursor = reset ? null : nextCursorRef.current;
    const endpoint = folder === 'inbox' ? '/inbox' : '/sent';
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (folder === 'inbox' && unreadOnly) params.set('unread', '1');
    if (identityFilter) params.set('address', identityFilter);
    try {
      const page = await apiFetch<MessagePage>(`${endpoint}?${params.toString()}`, {}, controller.signal);
      if (controller.signal.aborted || folderRequestSequenceRef.current !== requestSequence) return;
      setItems((current) => reset ? page.items : [...current, ...page.items]);
      nextCursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
      if (reset) {
        setSelectedId(page.items[0]?.id ?? null);
      }
    } catch (error) {
      if (controller.signal.aborted || folderRequestSequenceRef.current !== requestSequence) return;
      setListError(error instanceof Error ? error.message : 'No se pudo cargar la bandeja.');
    } finally {
      if (folderRequestSequenceRef.current === requestSequence) {
        setListLoading(false);
        if (folderRequestControllerRef.current === controller) folderRequestControllerRef.current = null;
      }
    }
  }, [folder, unreadOnly, identityFilter]);

  useEffect(() => {
    void loadFolder(true);
    return () => folderRequestControllerRef.current?.abort();
  }, [folder, unreadOnly, reloadKey, loadFolder]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); setBodyText(null); setBodyHtml(''); setBodyStyles(''); setRemoteImages(0); setAttachments([]); return; }
    const controller = new AbortController();
    setReaderLoading(true); setReaderError(null); setDetail(null); setBodyText(null); setBodyHtml(''); setBodyStyles(''); setRemoteImages(0); setAttachments([]);
    void apiFetch<MessageDetail>(`/messages/${encodeURIComponent(selectedId)}`, {}, controller.signal)
      .then(async (message) => {
        setDetail(message);
        if (message.direction === 'outgoing') {
          setBodyText(message.bodyText || '');
          setAttachments((message.attachments ?? []).map((attachment, index) => ({ ...attachment, content: new ArrayBuffer(0), index })));
          return;
        }
        if (!message.rawAvailable) throw new Error('El original ya no está disponible en esta ventana local.');
        if (message.sizeBytes > MAX_PREVIEW_BYTES) throw new Error('Este mensaje supera el límite de vista previa. Descarga el original para abrirlo.');
        const raw = await requestRaw(message.id, controller.signal, MAX_PREVIEW_BYTES);
        const parsed = await parseRawInWorker(raw, controller.signal);
        setBodyText(parsed.bodyText); setBodyHtml(parsed.html); setBodyStyles(parsed.styles); setRemoteImages(parsed.remoteImages); setAttachments(parsed.attachments);
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setReaderError(error instanceof Error ? error.message : 'No se pudo leer el mensaje.'); })
      .finally(() => { if (!controller.signal.aborted) setReaderLoading(false); });
    return () => controller.abort();
  }, [folder, selectedId, reloadKey]);

  const selectedSummary = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);
  const selectMessage = useCallback((message: MessageSummary) => {
    setSelectedId(message.id); setMobileView('reader');
    if (!message.isRead) void markRead(message.id, true);
  }, [markRead]);
  const refresh = useCallback(() => {
    nextCursorRef.current = null;
    setNextCursor(null);
    setReloadKey((current) => current + 1);
  }, []);
  const openFolder = useCallback((nextFolder: Folder) => {
    setFolder(nextFolder); setUnreadOnly(false); setSelectedId(null); setMobileView('list');
  }, []);
  const seedLocal = useCallback(async () => {
    setSeedLoading(true);
    try { await apiFetch<void>('/dev/seed', { method: 'POST' }); setNotice('Ejemplos locales cargados.'); refresh(); }
    catch (error) { setListError(error instanceof Error ? error.message : 'No se pudieron cargar los ejemplos.'); }
    finally { setSeedLoading(false); }
  }, [refresh]);
  const testUsageAlert = useCallback(async () => {
    if (!session.usageAlerts?.enabled || usageAlertTestBusy || usageAlertTestPending) return;
    setUsageAlertTestBusy(true);
    try {
      const result = await apiFetch<{ status: string; used?: number; limit?: number }>('/usage-alerts/test', { method: 'POST' });
      if (result.status === 'notified') {
        setNotice(`El proveedor aceptó el aviso de prueba (${result.used}/${result.limit}). Esto no confirma su entrega en Gmail.`);
      } else if (result.status === 'pending') {
        setUsageAlertTestPending(true);
        setNotice('El envío quedó pendiente y no se reintentará automáticamente. Revisa el archivo principal antes de volver a probar.');
      } else if (result.status === 'unconfigured' || result.status === 'disabled') {
        setNotice('La prueba de alerta no está configurada en este Worker.');
      } else {
        setNotice('No se pudo preparar la prueba del aviso. No se envió ningún correo.');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo probar el aviso de cuota.');
    } finally {
      setUsageAlertTestBusy(false);
    }
  }, [session.usageAlerts?.enabled, usageAlertTestBusy, usageAlertTestPending]);
  const downloadOriginal = useCallback(async () => {
    if (!detail) return;
    try {
      const raw = await requestRaw(detail.id, undefined, MAX_DOWNLOAD_BYTES);
      const outgoing = detail.direction === 'outgoing';
      downloadBlob(new Blob([raw], { type: outgoing ? 'application/json' : 'message/rfc822' }), `${detail.subject || 'mensaje'}.${outgoing ? 'json' : 'eml'}`);
    }
    catch (error) { setNotice(error instanceof Error ? error.message : 'No se pudo descargar el original.'); }
  }, [detail]);
  const onSent = useCallback((sentFrom?: string) => {
    setCompose(null); setFolder('sent'); setUnreadOnly(false); setSelectedId(null); setMobileView('list');
    if (identityFilter && sentFrom) setIdentityFilter(sentFrom);
    setNotice(session.mode === 'local' ? 'Envío de prueba guardado.' : 'Mensaje aceptado por el proveedor. Revisa Enviados para ver el estado.');
    nextCursorRef.current = null;
    setNextCursor(null);
    setReloadKey((current) => current + 1);
  }, [identityFilter, session.mode]);
  const downloadAttachment = useCallback(async (attachment: Attachment) => {
    if (!detail) return;
    try {
      if (attachment.index !== undefined) {
        const response = await requestOutgoingAttachment(detail.id, attachment.index);
        downloadBlob(await response.blob(), attachment.filename);
      } else {
        downloadBlob(new Blob([attachment.content], { type: attachment.mimeType }), attachment.filename);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo descargar el adjunto.');
    }
  }, [detail]);
  const openCompose = useCallback(() => { setNotice(null); setCompose({}); }, []);
  const openReply = useCallback(() => {
    if (!detail) return;
    setNotice(null);
    setCompose({ replyTo: { ...detail, bodyText: bodyText ?? undefined } });
  }, [bodyText, detail]);

  return <div className="app-shell" data-mobile-view={compose ? 'compose' : mobileView} style={{ '--blue': session.brand.primaryColor } as CSSProperties}>
    <Sidebar session={session} folder={folder} onFolder={openFolder} onCompose={openCompose} onTestUsageAlert={testUsageAlert} usageAlertTestBusy={usageAlertTestBusy} usageAlertTestPending={usageAlertTestPending} />
    <MessageListPanel session={session} folder={folder} unreadOnly={unreadOnly} identityFilter={identityFilter} items={items} selectedId={selectedId} loading={listLoading} error={listError} nextCursor={nextCursor} onUnreadOnly={setUnreadOnly} onIdentityFilter={setIdentityFilter} onRefresh={refresh} onSelect={selectMessage} onLoadMore={() => void loadFolder(false)} onSeed={session.mode === 'local' ? seedLocal : undefined} seedLoading={seedLoading} locale={session.brand.locale} />
    <ReaderPanel session={session} detail={detail} bodyText={bodyText} html={bodyHtml} styles={bodyStyles} remoteImages={remoteImages} attachments={attachments} loading={readerLoading} error={readerError} onBack={() => setMobileView('list')} onMarkRead={(read) => { if (selectedId) void markRead(selectedId, read); }} onDownload={downloadOriginal} onDownloadAttachment={(attachment) => void downloadAttachment(attachment)} onReply={openReply} />
    {notice && !compose && <div className="toast" role="status">{notice}<button type="button" aria-label="Cerrar aviso" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {compose && <ComposeDialog session={session} replyTo={compose.replyTo} archiveReply={compose.archiveReply} onClose={() => setCompose(null)} onSent={onSent} />}
  </div>;
}
