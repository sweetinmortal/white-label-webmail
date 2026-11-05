import { AlertCircle, Check, LoaderCircle, Plus, RefreshCw, Save, Settings, Tag, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { GmailSyncStatus } from '../../shared/gmail';
import type { OrganizationLabel, OrganizationLabelInput, OrganizationRule, OrganizationRuleInput, OrganizationState } from '../../shared/organization';
import { apiFetch, ApiRequestError } from '../lib/api';

type SettingsTab = 'labels' | 'rules' | 'gmail';
export type GmailFeedback = 'connected' | 'failed' | 'denied' | 'wrong_account';
type ApplyReply = { processed: number; matched: number; nextCursor: string | null };
type RuleDraft = {
  name: string;
  enabled: boolean;
  from: string;
  to: string;
  subject: string;
  excludeSubject: string;
  labelIds: string[];
  skipInbox: boolean;
  markRead: boolean;
  spam: 'unchanged' | 'spam' | 'never';
};

const blankRule = (): RuleDraft => ({ name: '', enabled: true, from: '', to: '', subject: '', excludeSubject: '', labelIds: [], skipInbox: false, markRead: false, spam: 'unchanged' });

export default function SettingsDialog({ initialTab = 'labels', gmailFeedback, onClose, onChanged }: {
  initialTab?: SettingsTab;
  gmailFeedback?: GmailFeedback;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [organization, setOrganization] = useState<OrganizationState | null>(null);
  const [loadingOrganization, setLoadingOrganization] = useState(true);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [labelName, setLabelName] = useState('');
  const [labelColor, setLabelColor] = useState('#4f46e5');
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(blankRule);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [applyingRuleId, setApplyingRuleId] = useState<string | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ processed: number; matched: number; done: boolean; cancelled?: boolean; failed?: boolean } | null>(null);
  const [gmailStatus, setGmailStatus] = useState<GmailSyncStatus | null>(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailNotice, setGmailNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const applyControllerRef = useRef<AbortController | null>(null);
  const organizationControllerRef = useRef<AbortController | null>(null);
  const gmailControllerRef = useRef<AbortController | null>(null);
  const tabId = 'settings-tabs';

  const loadOrganization = async (signal?: AbortSignal) => {
    setLoadingOrganization(true);
    setOrganizationError(null);
    try {
      const result = await apiFetch<OrganizationState>('/organization', {}, signal);
      if (!signal?.aborted && mountedRef.current) setOrganization(result);
    } catch (error) {
      if (!signal?.aborted && mountedRef.current) setOrganizationError(error instanceof Error ? error.message : 'No se pudieron cargar las etiquetas y reglas.');
    } finally {
      if (!signal?.aborted && mountedRef.current) setLoadingOrganization(false);
    }
  };

  const loadGmail = async () => {
    gmailControllerRef.current?.abort();
    const controller = new AbortController();
    gmailControllerRef.current = controller;
    setGmailLoading(true);
    setGmailError(null);
    try {
      const result = await apiFetch<GmailSyncStatus>('/gmail/status', {}, controller.signal);
      if (!controller.signal.aborted && mountedRef.current) setGmailStatus(result);
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) setGmailError(error instanceof ApiRequestError ? gmailErrorMessage(error.code) : 'No se pudo cargar el estado de Gmail.');
    } finally {
      if (!controller.signal.aborted && mountedRef.current) setGmailLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    organizationControllerRef.current = controller;
    void loadOrganization(controller.signal);
    if (initialTab === 'gmail') void loadGmail();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      mountedRef.current = false;
      controller.abort();
      applyControllerRef.current?.abort();
      gmailControllerRef.current?.abort();
      window.removeEventListener('keydown', closeOnEscape);
    };
    // The dialog is mounted only while open; its initial tab and close callback are stable for this lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const labels = organization?.labels ?? [];
  const rules = organization?.rules ?? [];

  const setRuleField = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setRuleDraft((current) => ({ ...current, [key]: value }));
  const toggleRuleLabel = (id: string) => setRuleDraft((current) => ({ ...current, labelIds: current.labelIds.includes(id) ? current.labelIds.filter((labelId) => labelId !== id) : [...current.labelIds, id] }));

  const saveLabel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = labelName.trim();
    if (!name || labelBusy) return;
    setLabelBusy(true);
    setOrganizationError(null);
    const input: OrganizationLabelInput = { name, color: labelColor };
    try {
      if (editingLabelId) {
        await apiFetch<void>(`/labels/${encodeURIComponent(editingLabelId)}`, { method: 'PATCH', body: JSON.stringify(input) });
      } else {
        await apiFetch<void>('/labels', { method: 'POST', body: JSON.stringify(input) });
      }
      setLabelName(''); setLabelColor('#4f46e5'); setEditingLabelId(null);
      await loadOrganization();
      await onChanged();
    } catch (error) {
      setOrganizationError(error instanceof Error ? error.message : 'No se pudo guardar la etiqueta.');
    } finally {
      if (mountedRef.current) setLabelBusy(false);
    }
  };

  const editLabel = (label: OrganizationLabel) => { setEditingLabelId(label.id); setLabelName(label.name); setLabelColor(validColor(label.color) ? label.color : '#4f46e5'); };
  const cancelLabelEdit = () => { setEditingLabelId(null); setLabelName(''); setLabelColor('#4f46e5'); };

  const deleteLabel = async (label: OrganizationLabel) => {
    if (!window.confirm(`¿Eliminar la etiqueta “${label.name}”?`)) return;
    setLabelBusy(true);
    setOrganizationError(null);
    try {
      await apiFetch<void>(`/labels/${encodeURIComponent(label.id)}`, { method: 'DELETE' });
      if (editingLabelId === label.id) cancelLabelEdit();
      await loadOrganization();
      await onChanged();
    } catch (error) {
      setOrganizationError(error instanceof Error ? error.message : 'No se pudo eliminar la etiqueta.');
    } finally {
      if (mountedRef.current) setLabelBusy(false);
    }
  };

  const openNewRule = () => { setEditingRuleId(null); setRuleDraft(blankRule()); setRuleError(null); setRuleFormOpen(true); };
  const editRule = (rule: OrganizationRule) => {
    setEditingRuleId(rule.id);
    setRuleDraft({ name: rule.name, enabled: rule.enabled, from: rule.criteria.from ?? '', to: rule.criteria.to ?? '', subject: rule.criteria.subject ?? '', excludeSubject: rule.criteria.excludeSubject ?? '', labelIds: [...rule.actions.labelIds], skipInbox: rule.actions.skipInbox, markRead: rule.actions.markRead, spam: rule.actions.spam === true ? 'spam' : rule.actions.spam === false ? 'never' : 'unchanged' });
    setRuleError(null); setRuleFormOpen(true);
  };
  const cancelRuleEdit = () => { setRuleFormOpen(false); setEditingRuleId(null); setRuleDraft(blankRule()); setRuleError(null); };

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ruleBusy) return;
    const criteria = Object.fromEntries([
      ['from', ruleDraft.from], ['to', ruleDraft.to], ['subject', ruleDraft.subject], ['excludeSubject', ruleDraft.excludeSubject],
    ].flatMap(([key, value]) => typeof value === 'string' && value.trim() ? [[key, value.trim()]] : [])) as OrganizationRuleInput['criteria'];
    const spamAction = ruleDraft.spam === 'unchanged' ? undefined : ruleDraft.spam === 'spam';
    const actions: OrganizationRuleInput['actions'] = { labelIds: [...ruleDraft.labelIds], skipInbox: ruleDraft.skipInbox, markRead: ruleDraft.markRead, ...(spamAction === undefined ? {} : { spam: spamAction }) };
    if (Object.keys(criteria).length === 0) { setRuleError('Añade al menos un criterio de remitente, destinatario o asunto.'); return; }
    if (actions.labelIds.length === 0 && !actions.skipInbox && !actions.markRead && spamAction === undefined) { setRuleError('Elige al menos una acción.'); return; }
    const input: OrganizationRuleInput = { name: ruleDraft.name.trim(), enabled: ruleDraft.enabled, criteria, actions };
    if (!input.name) { setRuleError('Escribe un nombre para la regla.'); return; }
    setRuleBusy(true); setRuleError(null);
    try {
      if (editingRuleId) await apiFetch<void>(`/rules/${encodeURIComponent(editingRuleId)}`, { method: 'PATCH', body: JSON.stringify(input) });
      else await apiFetch<void>('/rules', { method: 'POST', body: JSON.stringify(input) });
      cancelRuleEdit();
      await loadOrganization();
      await onChanged();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : 'No se pudo guardar la regla.');
    } finally {
      if (mountedRef.current) setRuleBusy(false);
    }
  };

  const toggleRule = async (rule: OrganizationRule) => {
    setRuleBusy(true); setRuleError(null);
    try {
      const { id: _id, ...input } = rule;
      await apiFetch<void>(`/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify({ ...input, enabled: !rule.enabled }) });
      await loadOrganization();
      await onChanged();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : 'No se pudo actualizar la regla.');
    } finally {
      if (mountedRef.current) setRuleBusy(false);
    }
  };

  const deleteRule = async (rule: OrganizationRule) => {
    if (!window.confirm(`¿Eliminar la regla “${rule.name}”?`)) return;
    setRuleBusy(true); setRuleError(null);
    try {
      await apiFetch<void>(`/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      await loadOrganization();
      await onChanged();
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : 'No se pudo eliminar la regla.');
    } finally {
      if (mountedRef.current) setRuleBusy(false);
    }
  };

  const applyRule = async (rule: OrganizationRule) => {
    if (applyingRuleId) return;
    const controller = new AbortController();
    applyControllerRef.current = controller;
    setApplyingRuleId(rule.id);
    setApplyProgress({ processed: 0, matched: 0, done: false });
    setRuleError(null);
    let cursor: string | undefined;
    let processed = 0;
    let matched = 0;
    const seenCursors = new Set<string>();
    try {
      while (!controller.signal.aborted && mountedRef.current) {
        const result = await apiFetch<ApplyReply>(`/rules/${encodeURIComponent(rule.id)}/apply`, { method: 'POST', body: JSON.stringify(cursor ? { cursor } : {}) }, controller.signal);
        if (controller.signal.aborted || !mountedRef.current) return;
        processed += result.processed;
        matched += result.matched;
        setApplyProgress({ processed, matched, done: !result.nextCursor });
        if (!result.nextCursor) break;
        if (seenCursors.has(result.nextCursor)) throw new Error('La aplicación de la regla no avanzó al siguiente bloque.');
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      if (!controller.signal.aborted && mountedRef.current) {
        setApplyProgress({ processed, matched, done: true });
        await onChanged();
      }
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) {
        setRuleError(error instanceof Error ? error.message : 'No se pudo aplicar la regla a los mensajes existentes.');
        setApplyProgress((current) => current ? { ...current, done: true, failed: true } : current);
      }
    } finally {
      if (mountedRef.current) {
        setApplyingRuleId(null);
        if (controller.signal.aborted) setApplyProgress((current) => current ? { ...current, done: true, cancelled: true } : current);
      }
      if (applyControllerRef.current === controller) applyControllerRef.current = null;
    }
  };

  const setActiveTab = (nextTab: SettingsTab) => {
    setTab(nextTab);
    if (nextTab === 'gmail' && !gmailStatus && !gmailLoading) void loadGmail();
  };

  const connectGmail = async () => {
    if (gmailBusy || !gmailStatus?.enabled || !gmailStatus.configured) return;
    setGmailBusy(true); setGmailError(null); setGmailNotice(null);
    try {
      const result = await apiFetch<{ url: string }>('/gmail/connect', { method: 'POST' });
      const target = new URL(result.url);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') throw new Error('No se pudo iniciar una conexión segura con Google.');
      window.location.assign(target.toString());
    } catch (error) {
      if (mountedRef.current) setGmailError(error instanceof ApiRequestError ? gmailErrorMessage(error.code) : error instanceof Error ? error.message : 'No se pudo iniciar la conexión con Gmail.');
      if (mountedRef.current) setGmailBusy(false);
    }
  };

  const syncGmail = async () => {
    if (gmailBusy || !gmailStatus?.enabled || !gmailStatus.configured || !gmailStatus.connected) return;
    setGmailBusy(true); setGmailError(null); setGmailNotice(null);
    try {
      const result = await apiFetch<GmailSyncStatus>('/gmail/sync', { method: 'POST' });
      if (mountedRef.current) {
        setGmailStatus(result);
        if (result.lastError) setGmailError(gmailErrorMessage(result.lastError));
        else if (result.lastSyncedAt === gmailStatus.lastSyncedAt) setGmailNotice('Estado actualizado. El siguiente lote se procesará cuando corresponda al intervalo de sincronización.');
        else setGmailNotice(result.scanning ? 'La sincronización continúa en segundo plano.' : 'Sincronización completada.');
        await onChanged();
      }
    } catch (error) {
      const message = error instanceof ApiRequestError ? gmailErrorMessage(error.code) : 'No se pudo sincronizar Gmail.';
      if (mountedRef.current) {
        await loadGmail();
        if (mountedRef.current) setGmailError(message);
      }
    } finally {
      if (mountedRef.current) setGmailBusy(false);
    }
  };

  const disconnectGmail = async () => {
    if (gmailBusy || !window.confirm('¿Desconectar la cuenta de Gmail de esta copia local?')) return;
    setGmailBusy(true); setGmailError(null); setGmailNotice(null);
    try {
      await apiFetch<void>('/gmail/connection', { method: 'DELETE' });
      if (mountedRef.current) setGmailNotice('Cuenta de Gmail desconectada. Los mensajes y etiquetas locales existentes se conservan.');
      await loadGmail();
    } catch (error) {
      if (mountedRef.current) setGmailError(error instanceof ApiRequestError ? gmailErrorMessage(error.code) : 'No se pudo desconectar Gmail.');
    } finally {
      if (mountedRef.current) setGmailBusy(false);
    }
  };

  const feedback = useMemo(() => gmailFeedback ? feedbackText(gmailFeedback) : null, [gmailFeedback]);

  return <div className="settings-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <header className="settings-header">
        <div><Settings size={20} aria-hidden="true" /><h2 id="settings-title">Ajustes</h2></div>
        <button className="icon-button" type="button" aria-label="Cerrar ajustes" onClick={onClose} autoFocus><X size={20} /></button>
      </header>
      <div className="settings-tabbar" role="tablist" aria-label="Secciones de ajustes">
        <button id={`${tabId}-labels`} role="tab" type="button" aria-selected={tab === 'labels'} aria-controls="settings-panel" onClick={() => setActiveTab('labels')}><Tag size={16} />Etiquetas</button>
        <button id={`${tabId}-rules`} role="tab" type="button" aria-selected={tab === 'rules'} aria-controls="settings-panel" onClick={() => setActiveTab('rules')}>Reglas</button>
        <button id={`${tabId}-gmail`} role="tab" type="button" aria-selected={tab === 'gmail'} aria-controls="settings-panel" onClick={() => setActiveTab('gmail')}>Gmail</button>
      </div>
      <div className="settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`${tabId}-${tab}`}>
        {tab === 'labels' && <section aria-labelledby="labels-heading">
          <div className="settings-section-heading"><div><h3 id="labels-heading">Etiquetas de la copia local</h3><p>Organiza mensajes dentro de este webmail. Los nombres, incluidas las barras, se guardan tal como los escribes.</p></div></div>
          <form className="settings-label-form" onSubmit={(event) => void saveLabel(event)}>
            <label>Nombre<input value={labelName} onChange={(event) => setLabelName(event.target.value)} maxLength={80} required placeholder="Ej. Clientes/Soporte" /></label>
            <label>Color<input type="color" value={labelColor} onChange={(event) => setLabelColor(event.target.value)} aria-label="Color de la etiqueta" /></label>
            <div className="settings-form-actions"><button className="button button-primary" type="submit" disabled={labelBusy || !labelName.trim()}>{labelBusy ? <LoaderCircle className="spin" size={16} /> : editingLabelId ? <Save size={16} /> : <Plus size={16} />}{editingLabelId ? 'Guardar cambios' : 'Crear etiqueta'}</button>{editingLabelId && <button className="button button-secondary" type="button" onClick={cancelLabelEdit} disabled={labelBusy}>Cancelar</button>}</div>
          </form>
          {organizationError && <div className="settings-error" role="alert"><AlertCircle size={17} />{organizationError}</div>}
          {loadingOrganization ? <p className="settings-muted">Cargando etiquetas…</p> : labels.length === 0 ? <p className="settings-empty">Aún no hay etiquetas personalizadas.</p> : <ul className="settings-label-list">{labels.map((label) => <li key={label.id}>
            <span className="label-dot" style={{ background: validColor(label.color) ? label.color : '#64748b' }} aria-hidden="true" /><span className="settings-label-name">{label.name}</span>
            <button className="button button-secondary settings-small-button" type="button" onClick={() => editLabel(label)} disabled={labelBusy}>Editar</button>
            <button className="icon-button settings-delete-button" type="button" aria-label={`Eliminar etiqueta ${label.name}`} title={`Eliminar ${label.name}`} onClick={() => void deleteLabel(label)} disabled={labelBusy}><Trash2 size={17} /></button>
          </li>)}</ul>}
          <p className="settings-footnote">Las etiquetas heredadas de los filtros existentes siguen disponibles en la navegación y son de solo lectura.</p>
        </section>}

        {tab === 'rules' && <section aria-labelledby="rules-heading">
          <div className="settings-section-heading settings-rules-heading"><div><h3 id="rules-heading">Reglas para mensajes nuevos</h3><p>Los criterios se comparan como texto literal en las cabeceras. No se revisa el cuerpo del mensaje.</p></div><button type="button" className="button button-primary" onClick={openNewRule} disabled={ruleBusy || Boolean(applyingRuleId)}><Plus size={16} />Nueva regla</button></div>
          {ruleError && <div className="settings-error" role="alert"><AlertCircle size={17} />{ruleError}</div>}
          {applyProgress && <div className="settings-progress" role="status">{applyProgress.cancelled ? 'Aplicación detenida.' : applyProgress.failed ? 'Aplicación incompleta.' : applyProgress.done ? 'Aplicación terminada.' : `Aplicando regla: ${applyProgress.processed} mensajes revisados…`} Coincidencias: {applyProgress.matched}.{applyingRuleId && <button type="button" className="text-button" onClick={() => applyControllerRef.current?.abort()}>Detener</button>}</div>}
          {ruleFormOpen && <form className="settings-rule-form" onSubmit={(event) => void saveRule(event)}>
            <div className="settings-form-title"><h4>{editingRuleId ? 'Editar regla' : 'Nueva regla'}</h4><button className="icon-button" type="button" aria-label="Cerrar formulario de regla" onClick={cancelRuleEdit} disabled={ruleBusy}><X size={18} /></button></div>
            <label>Nombre de la regla<input value={ruleDraft.name} onChange={(event) => setRuleField('name', event.target.value)} maxLength={80} required /></label>
            <fieldset><legend>Criterios (se deben cumplir todos)</legend><div className="settings-rule-criteria">
              <label>De<input value={ruleDraft.from} onChange={(event) => setRuleField('from', event.target.value)} placeholder="parte de la dirección del remitente" /></label>
              <label>Para<input value={ruleDraft.to} onChange={(event) => setRuleField('to', event.target.value)} placeholder="parte de la dirección destinataria" /></label>
              <label>Asunto contiene<input value={ruleDraft.subject} onChange={(event) => setRuleField('subject', event.target.value)} placeholder="texto literal" /></label>
              <label>Asunto no contiene<input value={ruleDraft.excludeSubject} onChange={(event) => setRuleField('excludeSubject', event.target.value)} placeholder="texto literal" /></label>
            </div><p>Escribe al menos un criterio. Se evalúan encabezados, nunca el cuerpo.</p></fieldset>
            <fieldset><legend>Acciones (elige una o más)</legend>
              <div className="settings-rule-actions">
                <label><input type="checkbox" checked={ruleDraft.skipInbox} onChange={(event) => setRuleField('skipInbox', event.target.checked)} />Sacar de Recibidos</label>
                <label><input type="checkbox" checked={ruleDraft.markRead} onChange={(event) => setRuleField('markRead', event.target.checked)} />Marcar como leído</label>
                <fieldset className="settings-spam-action"><legend>Spam</legend>
                  <label><input type="radio" name="rule-spam-action" checked={ruleDraft.spam === 'unchanged'} onChange={() => setRuleField('spam', 'unchanged')} />No cambiar</label>
                  <label><input type="radio" name="rule-spam-action" checked={ruleDraft.spam === 'spam'} onChange={() => setRuleField('spam', 'spam')} />Marcar como spam</label>
                  <label><input type="radio" name="rule-spam-action" checked={ruleDraft.spam === 'never'} onChange={() => setRuleField('spam', 'never')} />Nunca marcar como spam</label>
                </fieldset>
              </div>
              {labels.length > 0 && <div className="settings-rule-labels"><span>Aplicar etiquetas</span>{labels.map((label) => <label key={label.id}><input type="checkbox" checked={ruleDraft.labelIds.includes(label.id)} onChange={() => toggleRuleLabel(label.id)} />{label.name}</label>)}</div>}
            </fieldset>
            <label className="settings-enabled-option"><input type="checkbox" checked={ruleDraft.enabled} onChange={(event) => setRuleField('enabled', event.target.checked)} />Regla habilitada</label>
            <div className="settings-form-actions"><button className="button button-primary" type="submit" disabled={ruleBusy}>{ruleBusy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{editingRuleId ? 'Guardar regla' : 'Crear regla'}</button><button className="button button-secondary" type="button" onClick={cancelRuleEdit} disabled={ruleBusy}>Cancelar</button></div>
          </form>}
          {loadingOrganization ? <p className="settings-muted">Cargando reglas…</p> : rules.length === 0 ? <p className="settings-empty">Aún no hay reglas personalizadas.</p> : <ul className="settings-rule-list">{rules.map((rule) => <li key={rule.id}>
            <div className="settings-rule-summary"><strong>{rule.name}</strong><span>{describeRule(rule, labels)}</span><small>{rule.enabled ? 'Habilitada' : 'Deshabilitada'}</small></div>
            <div className="settings-rule-buttons">
              <button type="button" className="button button-secondary settings-small-button" onClick={() => void toggleRule(rule)} disabled={ruleBusy || Boolean(applyingRuleId)}>{rule.enabled ? 'Deshabilitar' : 'Habilitar'}</button>
              <button type="button" className="button button-secondary settings-small-button" onClick={() => editRule(rule)} disabled={ruleBusy || Boolean(applyingRuleId)}>Editar</button>
              <button type="button" className="button button-outline settings-small-button" onClick={() => void applyRule(rule)} disabled={ruleBusy || Boolean(applyingRuleId)}>Aplicar a existentes</button>
              <button className="icon-button settings-delete-button" type="button" aria-label={`Eliminar regla ${rule.name}`} title={`Eliminar ${rule.name}`} onClick={() => void deleteRule(rule)} disabled={ruleBusy || Boolean(applyingRuleId)}><Trash2 size={17} /></button>
            </div>
          </li>)}</ul>}
          <p className="settings-footnote">Guardar una regla solo afecta mensajes nuevos. Para mensajes existentes, usa “Aplicar a existentes”; se procesan en páginas de hasta 100.</p>
        </section>}

        {tab === 'gmail' && <section aria-labelledby="gmail-heading">
          <div className="settings-section-heading"><div><h3 id="gmail-heading">Sincronización opcional con Gmail</h3><p>Refleja la clasificación de Spam de Gmail en las copias institucionales que conserva este webmail.</p></div></div>
          {feedback && <div className={gmailFeedback === 'failed' || gmailFeedback === 'wrong_account' ? 'settings-error' : 'settings-notice'} role={gmailFeedback === 'failed' || gmailFeedback === 'wrong_account' ? 'alert' : 'status'}>{feedback}</div>}
          {gmailNotice && <div className="settings-notice" role="status">{gmailNotice}</div>}
          {gmailError && <div className="settings-error" role="alert"><AlertCircle size={17} />{gmailError}</div>}
          {gmailLoading ? <p className="settings-muted">Consultando el estado de Gmail…</p> : gmailStatus && <>
            {!gmailStatus.enabled ? <div className="settings-callout"><strong>Función desactivada</strong><p>La sincronización con Gmail está deshabilitada para esta plantilla.</p></div>
              : !gmailStatus.configured ? <div className="settings-callout"><strong>Falta configuración</strong><p>El administrador debe configurar la integración de Gmail antes de conectar una cuenta.</p></div>
                : <div className="gmail-status-card">
                  <div className="gmail-status-title"><span className={gmailStatus.connected ? 'gmail-status-dot connected' : 'gmail-status-dot'} aria-hidden="true" /><div><strong>{gmailStatus.connected ? 'Conectado' : 'No conectado'}</strong><span>{gmailStatus.connected ? gmailStatus.email || 'Cuenta de Google' : 'La sincronización está lista para conectarse.'}</span></div></div>
                  {gmailStatus.connected && <dl><div><dt>Última sincronización</dt><dd>{formatDate(gmailStatus.lastSyncedAt)}</dd></div><div><dt>Mensajes que coinciden</dt><dd>{gmailStatus.matchedCount}</dd></div>{gmailStatus.scanning && <div><dt>Estado</dt><dd>Sincronización en curso</dd></div>}</dl>}
                  {gmailStatus.lastError && <div className="settings-error" role="status">{gmailErrorMessage(gmailStatus.lastError)}</div>}
                  <div className="settings-form-actions">{gmailStatus.connected
                    ? <><button className="button button-primary" type="button" onClick={() => void syncGmail()} disabled={gmailBusy || gmailStatus.scanning}>{gmailBusy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{gmailStatus.scanning ? 'Sincronizando…' : 'Sincronizar ahora'}</button><button className="button button-secondary" type="button" onClick={() => void disconnectGmail()} disabled={gmailBusy}>Desconectar</button></>
                    : <button className="button button-primary" type="button" onClick={() => void connectGmail()} disabled={gmailBusy}><Settings size={16} />Conectar Gmail</button>}</div>
                </div>}
            <div className="settings-callout"><strong>Permisos y alcance</strong><p>Google concede acceso a las cabeceras y etiquetas del buzón. Solo se conservan datos de mensajes con una dirección institucional configurada; no se descargan cuerpos ni adjuntos. La clasificación afecta la copia local: las etiquetas y reglas del webmail no cambian Gmail.</p></div>
          </>}
          <button className="text-button gmail-refresh" type="button" onClick={() => void loadGmail()} disabled={gmailLoading || gmailBusy}><RefreshCw size={14} />Actualizar estado</button>
        </section>}
      </div>
      <footer className="settings-footer"><span>Los cambios se aplican a esta copia del webmail.</span><button className="button button-secondary" type="button" onClick={onClose}>Cerrar</button></footer>
    </section>
  </div>;
}

function validColor(value: string) { return /^#[\da-f]{6}$/i.test(value); }

function describeRule(rule: OrganizationRule, labels: OrganizationLabel[]) {
  const conditions = [rule.criteria.from && `De contiene “${rule.criteria.from}”`, rule.criteria.to && `Para contiene “${rule.criteria.to}”`, rule.criteria.subject && `Asunto contiene “${rule.criteria.subject}”`, rule.criteria.excludeSubject && `Asunto excluye “${rule.criteria.excludeSubject}”`].filter(Boolean);
  const labelNames = labels.filter((label) => rule.actions.labelIds.includes(label.id)).map((label) => label.name);
  const actions = [...labelNames, rule.actions.skipInbox ? 'sacar de Recibidos' : '', rule.actions.markRead ? 'marcar leído' : '', rule.actions.spam === true ? 'marcar spam' : rule.actions.spam === false ? 'nunca marcar spam' : ''].filter(Boolean);
  return `${conditions.join(' · ')} → ${actions.join(', ') || 'sin acciones'}`;
}

function formatDate(value?: string) {
  if (!value) return 'Todavía no se sincronizó';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function feedbackText(feedback: GmailFeedback) {
  if (feedback === 'connected') return 'La cuenta de Gmail se conectó correctamente.';
  if (feedback === 'denied') return 'Se canceló la autorización de Gmail. Puedes volver a intentarlo cuando quieras.';
  if (feedback === 'wrong_account') return 'Google devolvió una cuenta distinta. Verifica la cuenta seleccionada e inténtalo de nuevo.';
  return 'No se pudo completar la conexión con Gmail. Inténtalo de nuevo más tarde.';
}

function gmailErrorMessage(code: string) {
  switch (code) {
    case 'reconnect': return 'La conexión con Gmail venció. Desconecta la cuenta y vuelve a conectarla.';
    case 'rate_limit': return 'Espera unos minutos antes de volver a sincronizar.';
    case 'provider_error': return 'Gmail no pudo completar la sincronización. Inténtalo más tarde.';
    case 'history_reset': return 'Gmail reinició el historial de sincronización. Vuelve a sincronizar para reconstruirlo.';
    case 'sync_failed': return 'No se pudo completar la sincronización. Inténtalo más tarde.';
    case 'wrong_account': return 'La cuenta autorizada no coincide. Vuelve a conectar la cuenta correcta.';
    case 'response_limit': return 'La sincronización encontró demasiados resultados. Ajusta los criterios y vuelve a intentarlo.';
    default: return 'No se pudo completar la operación de Gmail. Inténtalo más tarde.';
  }
}
