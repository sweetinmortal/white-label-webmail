import type { D1Database } from '@cloudflare/workers-types';
import type {
  OrganizationLabel,
  OrganizationLabelInput,
  OrganizationMessage,
  OrganizationRule,
  OrganizationRuleActions,
  OrganizationRuleCriteria,
  OrganizationRuleInput,
  OrganizationState,
} from '../../shared/organization';
import type { Env, Identity, MailConfig } from '../types';
import { AppError } from '../errors';
import { json, readJson } from '../http';
import { ensureSchema, nowIso } from '../store/schema';

const MAX_LABELS = 100;
const MAX_RULES = 50;
const MAX_PAGE = 100;
const MAX_BODY_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MESSAGE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const schemaReady = new WeakSet<object>();
const schemaPending = new WeakMap<object, Promise<void>>();

const organizationSchema = [
  `CREATE TABLE IF NOT EXISTS mail_labels (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    color TEXT NOT NULL,
    UNIQUE (mailbox_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS mail_labels_mailbox_name
    ON mail_labels (mailbox_id, name COLLATE NOCASE, id)`,
  `CREATE TABLE IF NOT EXISTS mail_message_labels (
    message_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, label_id),
    FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES mail_labels(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS mail_message_labels_mailbox_label
    ON mail_message_labels (mailbox_id, label_id, message_id)`,
  `CREATE INDEX IF NOT EXISTS mail_message_labels_mailbox_message
    ON mail_message_labels (mailbox_id, message_id, label_id)`,
  `CREATE TABLE IF NOT EXISTS mail_rules (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    criteria_json TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS mail_rules_mailbox_order
    ON mail_rules (mailbox_id, created_at, id)`,
  `CREATE TABLE IF NOT EXISTS mail_message_organization (
    message_id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    skip_inbox INTEGER NOT NULL CHECK (skip_inbox IN (0, 1)),
    FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS mail_message_organization_mailbox_archive
    ON mail_message_organization (mailbox_id, skip_inbox, message_id)`,
];

interface LabelRow extends OrganizationLabel { mailbox_id: string }
interface RuleRow {
  id: string;
  mailbox_id: string;
  name: string;
  enabled: number;
  criteria_json: string;
  actions_json: string;
  created_at: string;
}
interface MessageRuleRow {
  id: string;
  mailbox_id: string;
  direction: string;
  delete_state: string;
  from_email: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  subject: string;
  identity_address: string | null;
}
interface SpamStateRow { is_spam: number; source: string }
interface OrganizationMessageRow { skip_inbox: number }

function changes(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertAccess(config: MailConfig, identity: Identity): void {
  const email = normalizeEmail(identity.email);
  if (!identity.mailboxIds.includes(config.mailbox.id)
    || !config.allowedUsers.map(normalizeEmail).includes(email)) {
    throw new AppError(403, 'mailbox_forbidden', 'No tienes acceso a este buzón.');
  }
}

function objectInput(value: unknown, code: string, message: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, code, message);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new AppError(400, code, message);
  return record;
}

function requiredName(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== 'string') throw new AppError(400, code, 'El nombre no es válido.');
  const name = value.trim();
  if (!name || name.length > maxLength || /[\x00-\x1f\x7f]/.test(name)) {
    throw new AppError(400, code, `El nombre debe tener entre 1 y ${maxLength} caracteres.`);
  }
  return name;
}

function labelInput(value: unknown): OrganizationLabelInput {
  const input = objectInput(value, 'label_invalid', 'La etiqueta no es válida.', ['name', 'color']);
  const name = requiredName(input.name, 80, 'label_invalid');
  if (typeof input.color !== 'string' || !/^#[\da-fA-F]{6}$/.test(input.color)) {
    throw new AppError(400, 'label_invalid', 'El color de la etiqueta debe ser un hexadecimal de seis dígitos.');
  }
  return { name, color: input.color.toLowerCase() };
}

function assertNoLegacyLabelCollision(config: MailConfig, name: string): void {
  if ((config.incomingFilters ?? []).some((rule) => rule.label.trim().toLowerCase() === name.toLowerCase())) {
    throw new AppError(409, 'label_legacy_conflict', 'El nombre coincide con una etiqueta de un filtro existente. Usa otro nombre.');
  }
}

function criteriaText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError(400, 'rule_invalid', `El criterio ${field} no es válido.`);
  const text = value.trim();
  if (!text || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) {
    throw new AppError(400, 'rule_invalid', `El criterio ${field} debe tener entre 1 y 200 caracteres.`);
  }
  return text;
}

function ruleInput(value: unknown): OrganizationRuleInput {
  const input = objectInput(value, 'rule_invalid', 'La regla no es válida.', ['name', 'enabled', 'criteria', 'actions']);
  const name = requiredName(input.name, 80, 'rule_invalid');
  if (typeof input.enabled !== 'boolean') throw new AppError(400, 'rule_invalid', 'Indica si la regla está habilitada.');

  const criteriaRecord = objectInput(input.criteria, 'rule_invalid', 'Los criterios de la regla no son válidos.', ['from', 'to', 'subject', 'excludeSubject']);
  const criteria: OrganizationRuleCriteria = {};
  for (const key of ['from', 'to', 'subject', 'excludeSubject'] as const) {
    if (criteriaRecord[key] !== undefined) criteria[key] = criteriaText(criteriaRecord[key], key);
  }
  if (!Object.keys(criteria).length) throw new AppError(400, 'rule_invalid', 'La regla necesita al menos un criterio.');

  const actionsRecord = objectInput(input.actions, 'rule_invalid', 'Las acciones de la regla no son válidas.', ['labelIds', 'skipInbox', 'markRead', 'spam']);
  if (!Array.isArray(actionsRecord.labelIds) || actionsRecord.labelIds.length > MAX_LABELS
    || actionsRecord.labelIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new AppError(400, 'rule_invalid', 'Las etiquetas de la regla no son válidas.');
  }
  const labelIds = (actionsRecord.labelIds as string[]).map((id) => id.toLowerCase());
  if (new Set(labelIds).size !== labelIds.length) throw new AppError(400, 'rule_invalid', 'La regla contiene etiquetas repetidas.');
  if (typeof actionsRecord.skipInbox !== 'boolean' || typeof actionsRecord.markRead !== 'boolean'
    || (actionsRecord.spam !== undefined && typeof actionsRecord.spam !== 'boolean')) {
    throw new AppError(400, 'rule_invalid', 'Las acciones de la regla no son válidas.');
  }
  const actions: OrganizationRuleActions = {
    labelIds,
    skipInbox: actionsRecord.skipInbox,
    markRead: actionsRecord.markRead,
    ...(actionsRecord.spam === undefined ? {} : { spam: actionsRecord.spam }),
  };
  if (!actions.labelIds.length && !actions.skipInbox && !actions.markRead && actions.spam === undefined) {
    throw new AppError(400, 'rule_invalid', 'La regla necesita al menos una acción.');
  }
  return { name, enabled: input.enabled, criteria, actions };
}

function validateUuid(value: string): string {
  let id: string;
  try { id = decodeURIComponent(value); } catch { throw new AppError(400, 'organization_id_invalid', 'El identificador no es válido.'); }
  if (!UUID_RE.test(id)) throw new AppError(400, 'organization_id_invalid', 'El identificador no es válido.');
  return id.toLowerCase();
}

function parseJson<T>(value: string, code: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new AppError(500, code, 'No se pudo leer la configuración guardada.'); }
}

function ruleFromRow(row: RuleRow): OrganizationRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    criteria: parseJson<OrganizationRuleCriteria>(row.criteria_json, 'organization_rule_invalid'),
    actions: parseJson<OrganizationRuleActions>(row.actions_json, 'organization_rule_invalid'),
  };
}

function uniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed/i.test(message);
}

async function ensureTables(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await ensureOrganizationSchema(db);
}

/** Creates organization tables only; ensureTables() initializes the base mail schema first. */
export async function ensureOrganizationSchema(db: D1Database): Promise<void> {
  const key = db as object;
  if (schemaReady.has(key)) return;
  const pending = schemaPending.get(key);
  if (pending) return pending;
  const initializing = (async () => {
    await db.batch(organizationSchema.map((sql) => db.prepare(sql)));
    schemaReady.add(key);
  })();
  schemaPending.set(key, initializing);
  try {
    await initializing;
  } finally {
    schemaPending.delete(key);
  }
}

async function validateLabelReferences(
  db: D1Database,
  mailboxId: string,
  ids: string[],
  errorCode = 'rule_label_invalid',
  errorMessage = 'La regla debe usar etiquetas de este buzón.',
): Promise<void> {
  if (!ids.length) return;
  const rows = await db.prepare(`SELECT id FROM mail_labels
    WHERE mailbox_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(mailboxId, JSON.stringify(ids)).all<{ id: string }>();
  if ((rows.results ?? []).length !== ids.length) {
    throw new AppError(400, errorCode, errorMessage);
  }
}

export async function getOrganizationState(db: D1Database, config: MailConfig): Promise<OrganizationState> {
  await ensureTables(db);
  const [labels, rules] = await Promise.all([
    db.prepare('SELECT id, name, color FROM mail_labels WHERE mailbox_id = ? ORDER BY name COLLATE NOCASE, id')
      .bind(config.mailbox.id).all<OrganizationLabel>(),
    db.prepare('SELECT id, mailbox_id, name, enabled, criteria_json, actions_json, created_at FROM mail_rules WHERE mailbox_id = ? ORDER BY created_at, id')
      .bind(config.mailbox.id).all<RuleRow>(),
  ]);
  return {
    labels: labels.results ?? [],
    rules: (rules.results ?? []).map(ruleFromRow),
  };
}

export async function attachMessageLabels<T extends { id: string }>(
  db: D1Database,
  config: MailConfig,
  items: T[],
): Promise<Array<OrganizationMessage<T>>> {
  if (!items.length) return [];
  await ensureTables(db);
  const labelsByMessage = new Map<string, OrganizationLabel[]>();
  for (let offset = 0; offset < items.length; offset += 80) {
    const chunk = items.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(`SELECT ml.message_id, l.id, l.name, l.color
      FROM mail_message_labels ml JOIN mail_labels l
        ON l.id = ml.label_id AND l.mailbox_id = ml.mailbox_id
      WHERE ml.mailbox_id = ? AND ml.message_id IN (${placeholders})
      ORDER BY l.name COLLATE NOCASE, l.id`)
      .bind(config.mailbox.id, ...chunk.map((item) => item.id))
      .all<OrganizationLabel & { message_id: string }>();
    for (const row of result.results ?? []) {
      const labels = labelsByMessage.get(row.message_id) ?? [];
      labels.push({ id: row.id, name: row.name, color: row.color });
      labelsByMessage.set(row.message_id, labels);
    }
  }
  return items.map((item) => ({ ...item, labels: labelsByMessage.get(item.id) ?? [] }));
}

async function createLabel(db: D1Database, config: MailConfig, inputValue: unknown): Promise<OrganizationLabel> {
  const input = labelInput(inputValue);
  assertNoLegacyLabelCollision(config, input.name);
  const id = crypto.randomUUID();
  try {
    const inserted = await db.prepare(`INSERT INTO mail_labels (id, mailbox_id, name, color)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM mail_labels WHERE mailbox_id = ?) < ?`)
      .bind(id, config.mailbox.id, input.name, input.color, config.mailbox.id, MAX_LABELS).run();
    if (changes(inserted) !== 1) throw new AppError(409, 'label_limit', 'Este buzón ya tiene el máximo de 100 etiquetas.');
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (uniqueError(error)) throw new AppError(409, 'label_exists', 'Ya existe una etiqueta con ese nombre.');
    throw error;
  }
  return { id, ...input };
}

async function updateLabel(db: D1Database, config: MailConfig, id: string, inputValue: unknown): Promise<OrganizationLabel> {
  const input = labelInput(inputValue);
  assertNoLegacyLabelCollision(config, input.name);
  try {
    await db.prepare('UPDATE mail_labels SET name = ?, color = ? WHERE id = ? AND mailbox_id = ?')
      .bind(input.name, input.color, id, config.mailbox.id).run();
  } catch (error) {
    if (uniqueError(error)) throw new AppError(409, 'label_exists', 'Ya existe una etiqueta con ese nombre.');
    throw error;
  }
  const row = await db.prepare('SELECT id, name, color FROM mail_labels WHERE id = ? AND mailbox_id = ?')
    .bind(id, config.mailbox.id).first<OrganizationLabel>();
  if (!row) throw new AppError(404, 'label_not_found', 'La etiqueta no existe en este buzón.');
  return row;
}

async function labelUsedByRule(db: D1Database, mailboxId: string, labelId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS used FROM mail_rules r, json_each(r.actions_json, '$.labelIds') label
    WHERE r.mailbox_id = ? AND label.value = ? LIMIT 1`).bind(mailboxId, labelId).first<{ used: number }>();
  return Boolean(row);
}

async function deleteLabel(db: D1Database, config: MailConfig, id: string): Promise<void> {
  if (await labelUsedByRule(db, config.mailbox.id, id)) {
    throw new AppError(409, 'label_in_use', 'No se puede eliminar una etiqueta usada por una regla. Edita o elimina la regla primero.');
  }
  await db.prepare(`DELETE FROM mail_labels WHERE id = ? AND mailbox_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM mail_rules r, json_each(r.actions_json, '$.labelIds') label
      WHERE r.mailbox_id = mail_labels.mailbox_id AND label.value = mail_labels.id
    )`).bind(id, config.mailbox.id).run();
  const remaining = await db.prepare('SELECT id FROM mail_labels WHERE id = ? AND mailbox_id = ?')
    .bind(id, config.mailbox.id).first<{ id: string }>();
  if (!remaining) return;
  if (await labelUsedByRule(db, config.mailbox.id, id)) {
    throw new AppError(409, 'label_in_use', 'No se puede eliminar una etiqueta usada por una regla. Edita o elimina la regla primero.');
  }
  throw new AppError(404, 'label_not_found', 'La etiqueta no existe en este buzón.');
}

async function createRule(db: D1Database, config: MailConfig, inputValue: unknown): Promise<OrganizationRule> {
  const input = ruleInput(inputValue);
  await validateLabelReferences(db, config.mailbox.id, input.actions.labelIds);
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const actionsJson = JSON.stringify(input.actions);
  const inserted = await db.prepare(`INSERT INTO mail_rules (id, mailbox_id, name, enabled, criteria_json, actions_json, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM mail_rules WHERE mailbox_id = ?) < ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?, '$.labelIds') requested LEFT JOIN mail_labels l
          ON l.id = requested.value AND l.mailbox_id = ? WHERE l.id IS NULL
      )`)
    .bind(id, config.mailbox.id, input.name, Number(input.enabled), JSON.stringify(input.criteria), actionsJson,
      createdAt, config.mailbox.id, MAX_RULES, actionsJson, config.mailbox.id).run();
  if (changes(inserted) !== 1) {
    const count = await db.prepare('SELECT COUNT(*) AS count FROM mail_rules WHERE mailbox_id = ?')
      .bind(config.mailbox.id).first<{ count: number }>();
    if (Number(count?.count ?? 0) >= MAX_RULES) throw new AppError(409, 'rule_limit', 'Este buzón ya tiene el máximo de 50 reglas.');
    await validateLabelReferences(db, config.mailbox.id, input.actions.labelIds);
    throw new AppError(400, 'rule_label_invalid', 'La regla debe usar etiquetas de este buzón.');
  }
  return { id, ...input };
}

async function updateRule(db: D1Database, config: MailConfig, id: string, inputValue: unknown): Promise<OrganizationRule> {
  const input = ruleInput(inputValue);
  await validateLabelReferences(db, config.mailbox.id, input.actions.labelIds);
  const actionsJson = JSON.stringify(input.actions);
  const updated = await db.prepare(`UPDATE mail_rules SET name = ?, enabled = ?, criteria_json = ?, actions_json = ?
    WHERE id = ? AND mailbox_id = ? AND NOT EXISTS (
      SELECT 1 FROM json_each(?, '$.labelIds') requested LEFT JOIN mail_labels l
        ON l.id = requested.value AND l.mailbox_id = ? WHERE l.id IS NULL
    )`)
    .bind(input.name, Number(input.enabled), JSON.stringify(input.criteria), actionsJson, id, config.mailbox.id,
      actionsJson, config.mailbox.id).run();
  const row = await db.prepare('SELECT id, mailbox_id, name, enabled, criteria_json, actions_json, created_at FROM mail_rules WHERE id = ? AND mailbox_id = ?')
    .bind(id, config.mailbox.id).first<RuleRow>();
  if (!row) throw new AppError(404, 'rule_not_found', 'La regla no existe en este buzón.');
  if (changes(updated) === 0) {
    await validateLabelReferences(db, config.mailbox.id, input.actions.labelIds);
    const saved = ruleFromRow(row);
    if (JSON.stringify(saved.criteria) !== JSON.stringify(input.criteria) || JSON.stringify(saved.actions) !== actionsJson
      || saved.name !== input.name || saved.enabled !== input.enabled) {
      throw new AppError(400, 'rule_label_invalid', 'La regla debe usar etiquetas de este buzón.');
    }
  }
  return ruleFromRow(row);
}

async function deleteRule(db: D1Database, config: MailConfig, id: string): Promise<void> {
  const removed = await db.prepare('DELETE FROM mail_rules WHERE id = ? AND mailbox_id = ?').bind(id, config.mailbox.id).run();
  if (!changes(removed)) throw new AppError(404, 'rule_not_found', 'La regla no existe en este buzón.');
}

function parsedRecipients(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry === 'string') return [entry];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const email = (entry as { email?: unknown }).email;
        return typeof email === 'string' ? [email] : [];
      }
      return [];
    });
  } catch { return []; }
}

function ruleMatches(rule: OrganizationRule, message: MessageRuleRow): boolean {
  const criteria = rule.criteria;
  const from = `${message.from_email} ${message.from_name}`.toLowerCase();
  const recipients = [
    ...parsedRecipients(message.to_json),
    ...parsedRecipients(message.cc_json),
    ...(message.identity_address ? [message.identity_address] : []),
  ].join('\n').toLowerCase();
  const subject = message.subject.toLowerCase();
  if (criteria.from && !from.includes(criteria.from.toLowerCase())) return false;
  if (criteria.to && !recipients.includes(criteria.to.toLowerCase())) return false;
  if (criteria.subject && !subject.includes(criteria.subject.toLowerCase())) return false;
  if (criteria.excludeSubject && subject.includes(criteria.excludeSubject.toLowerCase())) return false;
  return true;
}

async function getRuleMessage(db: D1Database, config: MailConfig, messageId: string): Promise<MessageRuleRow> {
  const row = await db.prepare(`SELECT m.id, m.mailbox_id, m.direction, m.delete_state, m.from_email, m.from_name,
      m.to_json, m.cc_json, m.subject, i.address AS identity_address
    FROM mail_messages m LEFT JOIN mail_message_identities i ON i.message_id = m.id
    WHERE m.id = ? AND m.mailbox_id = ? AND m.delete_state = 'active'
      AND m.direction = 'incoming'`).bind(messageId, config.mailbox.id).first<MessageRuleRow>();
  if (!row) throw new AppError(404, 'message_not_found', 'El mensaje recibido no existe en este buzón.');
  return row;
}

async function applyMatchedRules(
  db: D1Database,
  config: MailConfig,
  message: MessageRuleRow,
  matchedRules: OrganizationRule[],
): Promise<{ matched: boolean; skipInbox: boolean; isSpam: boolean }> {
  const current = await Promise.all([
    db.prepare('SELECT skip_inbox FROM mail_message_organization WHERE message_id = ? AND mailbox_id = ?')
      .bind(message.id, config.mailbox.id).first<OrganizationMessageRow>(),
    db.prepare('SELECT is_spam, source FROM mail_message_spam WHERE message_id = ? AND mailbox_id = ?')
      .bind(message.id, config.mailbox.id).first<SpamStateRow>(),
  ]);
  let skipInbox = current[0]?.skip_inbox === 1;
  let spamValue: boolean | undefined;
  let markRead = false;
  const labelIds = new Set<string>();
  const matched: OrganizationRule[] = [];
  for (const rule of matchedRules) {
    if (!ruleMatches(rule, message)) continue;
    matched.push(rule);
    skipInbox ||= rule.actions.skipInbox;
    markRead ||= rule.actions.markRead;
    rule.actions.labelIds.forEach((id) => labelIds.add(id));
    if (rule.actions.spam !== undefined) spamValue = rule.actions.spam;
  }
  if (!matched.length) return { matched: false, skipInbox, isSpam: current[1]?.is_spam === 1 };

  const statements: D1PreparedStatement[] = [];
  if (labelIds.size) {
    const ids = [...labelIds];
    const validRows = await db.prepare(`SELECT id FROM mail_labels
      WHERE mailbox_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(config.mailbox.id, JSON.stringify(ids)).all<{ id: string }>();
    for (const labelId of validRows.results ?? []) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO mail_message_labels (message_id, label_id, mailbox_id, created_at)
        VALUES (?, ?, ?, ?)`).bind(message.id, labelId.id, config.mailbox.id, nowIso()));
    }
  }
  if (matched.some((rule) => rule.actions.skipInbox)) {
    statements.push(db.prepare(`INSERT INTO mail_message_organization (message_id, mailbox_id, skip_inbox)
      VALUES (?, ?, 1) ON CONFLICT(message_id) DO UPDATE SET skip_inbox = 1
      WHERE mail_message_organization.mailbox_id = excluded.mailbox_id`).bind(message.id, config.mailbox.id));
  }
  if (markRead) {
    const users = [...new Set(config.allowedUsers.map(normalizeEmail))];
    for (const user of users) {
      statements.push(db.prepare('INSERT OR IGNORE INTO mail_read_states (message_id, user_email, read_at) VALUES (?, ?, ?)')
        .bind(message.id, user, nowIso()));
    }
  }
  if (spamValue !== undefined) {
    statements.push(db.prepare(`INSERT INTO mail_message_spam (message_id, mailbox_id, is_spam, reason, source, updated_at)
      VALUES (?, ?, ?, ?, 'rule', ?)
      ON CONFLICT(message_id) DO UPDATE SET is_spam = excluded.is_spam, reason = excluded.reason,
        source = 'rule', updated_at = excluded.updated_at
      WHERE mail_message_spam.mailbox_id = excluded.mailbox_id AND mail_message_spam.source <> 'manual'`)
      .bind(message.id, config.mailbox.id, Number(spamValue), spamValue ? 'Marcado como spam por una regla de la empresa.' : '', nowIso()));
  }
  if (statements.length) await db.batch(statements);

  const [organization, spam] = await Promise.all([
    db.prepare('SELECT skip_inbox FROM mail_message_organization WHERE message_id = ? AND mailbox_id = ?')
      .bind(message.id, config.mailbox.id).first<OrganizationMessageRow>(),
    db.prepare('SELECT is_spam FROM mail_message_spam WHERE message_id = ? AND mailbox_id = ?')
      .bind(message.id, config.mailbox.id).first<{ is_spam: number }>(),
  ]);
  return { matched: true, skipInbox: organization?.skip_inbox === 1, isSpam: spam?.is_spam === 1 };
}

export async function applyIncomingRules(
  db: D1Database,
  config: MailConfig,
  messageId: string,
): Promise<{ skipInbox: boolean; isSpam: boolean }> {
  await ensureTables(db);
  const message = await getRuleMessage(db, config, messageId);
  // created_at has millisecond precision; id is the stable tie-break for same-tick rules.
  const result = await db.prepare(`SELECT id, mailbox_id, name, enabled, criteria_json, actions_json, created_at
    FROM mail_rules WHERE mailbox_id = ? AND enabled = 1 ORDER BY created_at, id`)
    .bind(config.mailbox.id).all<RuleRow>();
  const rules = (result.results ?? []).map(ruleFromRow);
  const applied = await applyMatchedRules(db, config, message, rules);
  return { skipInbox: applied.skipInbox, isSpam: applied.isSpam };
}

async function applyRulePage(db: D1Database, config: MailConfig, ruleId: string, cursor?: string): Promise<{ processed: number; matched: number; nextCursor: string | null }> {
  const ruleRow = await db.prepare(`SELECT id, mailbox_id, name, enabled, criteria_json, actions_json, created_at
    FROM mail_rules WHERE id = ? AND mailbox_id = ?`).bind(ruleId, config.mailbox.id).first<RuleRow>();
  if (!ruleRow) throw new AppError(404, 'rule_not_found', 'La regla no existe en este buzón.');
  const rule = ruleFromRow(ruleRow);
  if (!rule.enabled) throw new AppError(409, 'rule_disabled', 'Habilita la regla antes de aplicarla a mensajes existentes.');
  await validateLabelReferences(db, config.mailbox.id, rule.actions.labelIds);
  let rows: MessageRuleRow[];
  const selectPage = `SELECT m.id, m.mailbox_id, m.direction, m.delete_state, m.from_email, m.from_name,
      m.to_json, m.cc_json, m.subject, i.address AS identity_address
    FROM mail_messages m LEFT JOIN mail_message_identities i ON i.message_id = m.id
    WHERE m.mailbox_id = ? AND m.direction = 'incoming' AND m.delete_state = 'active'`;
  if (cursor) {
    rows = (await db.prepare(`${selectPage} AND m.id > ? ORDER BY m.id LIMIT ?`)
      .bind(config.mailbox.id, cursor, MAX_PAGE + 1).all<MessageRuleRow>()).results ?? [];
  } else {
    rows = (await db.prepare(`${selectPage} ORDER BY m.id LIMIT ?`)
      .bind(config.mailbox.id, MAX_PAGE + 1).all<MessageRuleRow>()).results ?? [];
  }
  const page = rows.slice(0, MAX_PAGE);
  const matches = page.filter((message) => ruleMatches(rule, message));
  if (matches.length) {
    const ids = matches.map((message) => message.id);
    const activeIncoming = `FROM mail_messages m WHERE m.mailbox_id = ? AND m.direction = 'incoming'
      AND m.delete_state = 'active' AND m.id IN (SELECT value FROM json_each(?))`;
    const statements: D1PreparedStatement[] = [];
    const at = nowIso();
    const idsJson = JSON.stringify(ids);
    for (const labelId of rule.actions.labelIds) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO mail_message_labels (message_id, label_id, mailbox_id, created_at)
        SELECT m.id, ?, m.mailbox_id, ? ${activeIncoming}`)
        .bind(labelId, at, config.mailbox.id, idsJson));
    }
    if (rule.actions.skipInbox) {
      statements.push(db.prepare(`INSERT INTO mail_message_organization (message_id, mailbox_id, skip_inbox)
        SELECT m.id, m.mailbox_id, 1 ${activeIncoming}
        ON CONFLICT(message_id) DO UPDATE SET skip_inbox = 1
        WHERE mail_message_organization.mailbox_id = excluded.mailbox_id`)
        .bind(config.mailbox.id, idsJson));
    }
    if (rule.actions.markRead) {
      for (const user of [...new Set(config.allowedUsers.map(normalizeEmail))]) {
        statements.push(db.prepare(`INSERT OR IGNORE INTO mail_read_states (message_id, user_email, read_at)
          SELECT m.id, ?, ? ${activeIncoming}`)
          .bind(user, at, config.mailbox.id, idsJson));
      }
    }
    if (rule.actions.spam !== undefined) {
      const spam = rule.actions.spam;
      statements.push(db.prepare(`INSERT INTO mail_message_spam (message_id, mailbox_id, is_spam, reason, source, updated_at)
        SELECT m.id, m.mailbox_id, ?, ?, 'rule', ? ${activeIncoming}
        ON CONFLICT(message_id) DO UPDATE SET is_spam = excluded.is_spam, reason = excluded.reason,
          source = 'rule', updated_at = excluded.updated_at
        WHERE mail_message_spam.mailbox_id = excluded.mailbox_id AND mail_message_spam.source <> 'manual'`)
        .bind(Number(spam), spam ? 'Marcado como spam por una regla de la empresa.' : '', at, config.mailbox.id, idsJson));
    }
    if (statements.length) await db.batch(statements);
  }
  return {
    processed: page.length,
    matched: matches.length,
    nextCursor: rows.length > MAX_PAGE && page.length ? page[page.length - 1].id : null,
  };
}

async function replaceMessageLabels(db: D1Database, config: MailConfig, messageId: string, value: unknown): Promise<void> {
  const input = objectInput(value, 'message_labels_invalid', 'Las etiquetas del mensaje no son válidas.', ['labelIds']);
  if (!Array.isArray(input.labelIds) || input.labelIds.length > MAX_LABELS
    || input.labelIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new AppError(400, 'message_labels_invalid', 'Las etiquetas del mensaje no son válidas.');
  }
  const labelIds = (input.labelIds as string[]).map((id) => id.toLowerCase());
  if (new Set(labelIds).size !== labelIds.length) throw new AppError(400, 'message_labels_invalid', 'No repitas etiquetas.');
  const message = await db.prepare(`SELECT id FROM mail_messages WHERE id = ? AND mailbox_id = ? AND delete_state = 'active'`)
    .bind(messageId, config.mailbox.id).first<{ id: string }>();
  if (!message) throw new AppError(404, 'message_not_found', 'El mensaje no existe en este buzón.');
  await validateLabelReferences(db, config.mailbox.id, labelIds, 'message_labels_invalid', 'Las etiquetas deben pertenecer a este buzón.');
  const at = nowIso();
  const statements = [db.prepare('DELETE FROM mail_message_labels WHERE message_id = ? AND mailbox_id = ?')
    .bind(messageId, config.mailbox.id)];
  for (const labelId of labelIds) {
    statements.push(db.prepare(`INSERT INTO mail_message_labels (message_id, label_id, mailbox_id, created_at)
      VALUES (?, ?, ?, ?)`).bind(messageId, labelId, config.mailbox.id, at));
  }
  await db.batch(statements);
}

async function setMessageArchive(db: D1Database, config: MailConfig, messageId: string, value: unknown): Promise<void> {
  const input = objectInput(value, 'archive_invalid', 'El estado de archivo no es válido.', ['archived']);
  if (typeof input.archived !== 'boolean') throw new AppError(400, 'archive_invalid', 'Indica si el mensaje debe archivarse.');
  const message = await db.prepare(`SELECT direction FROM mail_messages
    WHERE id = ? AND mailbox_id = ? AND delete_state = 'active'`).bind(messageId, config.mailbox.id).first<{ direction: string }>();
  if (!message) throw new AppError(404, 'message_not_found', 'El mensaje no existe en este buzón.');
  if (message.direction !== 'incoming') throw new AppError(400, 'archive_incoming_only', 'Solo puedes archivar mensajes recibidos.');
  await db.prepare(`INSERT INTO mail_message_organization (message_id, mailbox_id, skip_inbox)
    VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET skip_inbox = excluded.skip_inbox
    WHERE mail_message_organization.mailbox_id = excluded.mailbox_id`)
    .bind(messageId, config.mailbox.id, Number(input.archived)).run();
}

async function applyRuleEndpoint(db: D1Database, config: MailConfig, ruleId: string, value: unknown) {
  const input = objectInput(value, 'rule_apply_invalid', 'La solicitud para aplicar la regla no es válida.', ['cursor']);
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 128 || !MESSAGE_ID_RE.test(input.cursor)) {
      throw new AppError(400, 'rule_apply_cursor_invalid', 'La página solicitada no es válida.');
    }
    cursor = input.cursor;
  }
  return applyRulePage(db, config, ruleId, cursor);
}

function routeId(value: string): string {
  try {
    const id = decodeURIComponent(value);
    if (!MESSAGE_ID_RE.test(id)) throw new Error('invalid');
    return id;
  } catch { throw new AppError(400, 'message_id_invalid', 'El identificador del mensaje no es válido.'); }
}

function methodNotAllowed(): never {
  throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
}

export async function handleOrganization(request: Request, env: Env, config: MailConfig, identity: Identity): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const labelPath = /^\/api\/labels\/([^/]+)$/.exec(path);
  const ruleApplyPath = /^\/api\/rules\/([^/]+)\/apply$/.exec(path);
  const rulePath = /^\/api\/rules\/([^/]+)$/.exec(path);
  const messageLabelsPath = /^\/api\/messages\/([^/]+)\/labels$/.exec(path);
  const messageArchivePath = /^\/api\/messages\/([^/]+)\/archive$/.exec(path);
  const recognized = path === '/api/organization' || path === '/api/labels' || path === '/api/rules'
    || Boolean(labelPath || ruleApplyPath || rulePath || messageLabelsPath || messageArchivePath);
  if (!recognized) return null;
  assertAccess(config, identity);
  await ensureTables(env.DB);

  if (path === '/api/organization') {
    if (request.method !== 'GET') methodNotAllowed();
    return json(await getOrganizationState(env.DB, config));
  }
  if (path === '/api/labels') {
    if (request.method !== 'POST') methodNotAllowed();
    return json(await createLabel(env.DB, config, await readJson(request, MAX_BODY_BYTES)), 201);
  }
  if (labelPath) {
    const id = validateUuid(labelPath[1]);
    if (request.method === 'PATCH') return json(await updateLabel(env.DB, config, id, await readJson(request, MAX_BODY_BYTES)));
    if (request.method === 'DELETE') {
      await deleteLabel(env.DB, config, id);
      return new Response(null, { status: 204 });
    }
    methodNotAllowed();
  }
  if (path === '/api/rules') {
    if (request.method !== 'POST') methodNotAllowed();
    return json(await createRule(env.DB, config, await readJson(request, MAX_BODY_BYTES)), 201);
  }
  if (ruleApplyPath) {
    if (request.method !== 'POST') methodNotAllowed();
    return json(await applyRuleEndpoint(env.DB, config, validateUuid(ruleApplyPath[1]), await readJson(request, MAX_BODY_BYTES)));
  }
  if (rulePath) {
    const id = validateUuid(rulePath[1]);
    if (request.method === 'PATCH') return json(await updateRule(env.DB, config, id, await readJson(request, MAX_BODY_BYTES)));
    if (request.method === 'DELETE') {
      await deleteRule(env.DB, config, id);
      return new Response(null, { status: 204 });
    }
    methodNotAllowed();
  }
  if (messageLabelsPath) {
    if (request.method !== 'PATCH') methodNotAllowed();
    await replaceMessageLabels(env.DB, config, routeId(messageLabelsPath[1]), await readJson(request, MAX_BODY_BYTES));
    return new Response(null, { status: 204 });
  }
  if (messageArchivePath) {
    if (request.method !== 'PATCH') methodNotAllowed();
    await setMessageArchive(env.DB, config, routeId(messageArchivePath[1]), await readJson(request, MAX_BODY_BYTES));
    return new Response(null, { status: 204 });
  }
  return null;
}
