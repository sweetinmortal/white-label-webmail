import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const strict = process.argv.includes('--strict');
const errors = [];

async function readJson(fileName, label) {
  try {
    return JSON.parse(await readFile(path.join(root, fileName), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') errors.push(`Falta ${label}.`);
    else errors.push(`No se pudo leer ${label}: ${error.message}`);
    return undefined;
  }
}

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key);
}

function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function isTursoDatabaseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  if (!/^(?:libsql|https):\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+turso\.io\/?$/i.test(value)) return false;
  let url;
  try { url = new URL(value); }
  catch { return false; }
  const validHost = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+turso\.io$/i.test(url.hostname);
  return ['https:', 'libsql:'].includes(url.protocol)
    && validHost
    && (url.pathname === '/' || url.pathname === '');
}

function isGoogleClientId(value) {
  return typeof value === 'string' && /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value);
}

function oneBinding(config, listName, bindingName) {
  const items = config?.[listName];
  return Array.isArray(items) && items.length === 1 && items[0]?.binding === bindingName ? items[0] : undefined;
}

const draft = await readJson('wrangler.jsonc', 'wrangler.jsonc');
const local = await readJson('wrangler.local.jsonc', 'wrangler.local.jsonc');
const deployment = await readJson('deployment.local.json', 'deployment.local.json');
const production = await readJson('wrangler.production.jsonc', 'wrangler.production.jsonc');

let company;
if (draft?.vars?.COMPANY_CONFIG === undefined) {
  errors.push('wrangler.jsonc no contiene vars.COMPANY_CONFIG.');
} else {
  try { company = JSON.parse(draft.vars.COMPANY_CONFIG); }
  catch { errors.push('vars.COMPANY_CONFIG del borrador no contiene JSON válido.'); }
}

const authProvider = company?.auth?.provider ?? 'access';
if (company?.auth !== undefined && (!company.auth || typeof company.auth !== 'object' || Array.isArray(company.auth)
  || Object.keys(company.auth).some((key) => key !== 'provider')
  || !['google', 'access'].includes(company.auth.provider))) {
  errors.push('auth debe contener únicamente provider: google o access.');
}
if (!['google', 'access'].includes(authProvider)) errors.push('auth.provider debe ser google o access.');

const storageProvider = company?.storageProvider ?? 'r2';
const usageAlertDelivery = company?.usageAlerts?.delivery ?? 'mailjet';
if (company && !['r2', 'turso'].includes(storageProvider)) errors.push('storageProvider debe ser r2 o turso.');
if (company && !['mailjet', 'cloudflare'].includes(usageAlertDelivery)) errors.push('usageAlerts.delivery debe ser mailjet o cloudflare.');
let companyHost;
if (company) {
  if (company.archiveCopies !== undefined && (!company.archiveCopies || typeof company.archiveCopies.enabled !== 'boolean' || (company.archiveCopies.maxDecoratedBytes !== undefined && (!Number.isSafeInteger(company.archiveCopies.maxDecoratedBytes) || company.archiveCopies.maxDecoratedBytes < 1024 || company.archiveCopies.maxDecoratedBytes > 3145728)))) errors.push('archiveCopies no es válido: revisa enabled y el tamaño máximo de 3 MiB.');
  if (company.incomingSummary !== undefined) {
    const summary = company.incomingSummary;
    if (!summary || typeof summary.enabled !== 'boolean' || !Number.isSafeInteger(summary.batchSize) || summary.batchSize < 1 || summary.batchSize > 50) {
      errors.push('incomingSummary no es válido: revisa enabled y batchSize.');
    } else if (summary.enabled) {
      if (!summary.from || typeof summary.from.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(summary.from.email)) errors.push('incomingSummary.from.email es obligatorio cuando el resumen está activo.');
      if (summary.from?.email === company.archiveAddress) errors.push('El remitente del resumen no puede ser el buzón de archivo.');
      try { new Intl.DateTimeFormat('en', { timeZone: summary.timeZone ?? 'UTC' }).format(new Date()); }
      catch { errors.push('incomingSummary.timeZone no es válida.'); }
    }
  }
  if (company.archiveAddress === company.mailbox?.address) errors.push('El archivo principal forma un bucle con el remitente.');
  if (!company.allowedUsers?.length) errors.push('Faltan identidades autorizadas.');
  const identityEmailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/;
  if (company.identities !== undefined) {
    if (!Array.isArray(company.identities) || company.identities.length > 20) {
      errors.push('identities debe ser una lista de hasta veinte direcciones.');
    } else {
      const seenIdentities = new Set();
      for (const identity of company.identities) {
        if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
          errors.push('Cada identity debe incluir una dirección válida.');
          continue;
        }
        const email = identity.email;
        if (typeof email !== 'string' || email.length > 254 || !identityEmailPattern.test(email)) {
          errors.push('Cada identity debe incluir una dirección válida.');
          continue;
        }
        const normalizedEmail = email.toLowerCase();
        if (seenIdentities.has(normalizedEmail) || normalizedEmail === company.archiveAddress?.toLowerCase()) {
          errors.push('Hay direcciones repetidas o una identity coincide con el archivo principal.');
        }
        seenIdentities.add(normalizedEmail);
        if (identity.name !== undefined && (typeof identity.name !== 'string' || !identity.name || identity.name.length > 200 || /[\x00-\x1f\x7f]/.test(identity.name))) {
          errors.push('El nombre de cada identity debe ser texto válido.');
        }
      }
    }
  }
  if (company.retentionDays < 1 || company.retentionDays > 3650) errors.push('La retención no es válida.');
  if (company.storageBudgetBytes > 8000000000) errors.push('El presupuesto supera el margen máximo previsto.');
  try {
    const appOrigin = new URL(company.appOrigin);
    if (appOrigin.protocol !== 'https:' || appOrigin.origin !== company.appOrigin) throw new Error('origin');
    companyHost = appOrigin.hostname;
  } catch {
    errors.push('El appOrigin de COMPANY_CONFIG debe ser un origen HTTPS válido.');
  }
}

if (draft) {
  const d1 = oneBinding(draft, 'd1_databases', 'DB');
  if (!d1) errors.push('El borrador debe declarar exactamente un binding D1 llamado DB.');
  if (storageProvider === 'r2') {
    if (!oneBinding(draft, 'r2_buckets', 'MAIL')) errors.push('El borrador R2 debe declarar exactamente un binding llamado MAIL.');
    if (hasOwn(draft.vars, 'TURSO_DATABASE_URL')) errors.push('El borrador R2 no debe declarar TURSO_DATABASE_URL.');
  } else if (storageProvider === 'turso' && hasOwn(draft, 'r2_buckets')) {
    errors.push('El borrador Turso no debe declarar r2_buckets.');
  }
  if (hasOwn(draft, 'send_email')) errors.push('El borrador local no debe declarar bindings send_email de producción.');
}

if (local && hasOwn(local, 'send_email')) {
  errors.push('La configuración local no debe declarar bindings send_email de producción.');
}

if (deployment) {
  const required = ['accountId', 'd1DatabaseId', ...(authProvider === 'google' ? ['googleClientId'] : ['accessTeamDomain', 'accessAudience'])];
  for (const key of required) {
    if (typeof deployment[key] !== 'string' || !deployment[key]) errors.push(`Falta ${key} en deployment.local.json.`);
  }
  if (deployment.accountId && !/^[a-f0-9]{32}$/.test(deployment.accountId)) errors.push('accountId de deployment.local.json no es válido.');
  if (deployment.d1DatabaseId && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deployment.d1DatabaseId)
    || deployment.d1DatabaseId === '00000000-0000-0000-0000-000000000000')) errors.push('d1DatabaseId de deployment.local.json no es válido.');
  if (authProvider === 'google') {
    if (hasOwn(deployment, 'accessTeamDomain') || hasOwn(deployment, 'accessAudience')) errors.push('La configuración Google no debe declarar accessTeamDomain ni accessAudience.');
    if (deployment.googleClientId && !isGoogleClientId(deployment.googleClientId)) errors.push('googleClientId de deployment.local.json no es válido.');
  } else {
    if (hasOwn(deployment, 'googleClientId')) errors.push('La configuración Access no debe declarar googleClientId.');
    if (deployment.accessTeamDomain && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(deployment.accessTeamDomain)) errors.push('accessTeamDomain de deployment.local.json no es válido.');
  }
  if (storageProvider === 'r2') {
    if (hasOwn(deployment, 'tursoDatabaseUrl')) errors.push('deployment.local.json para R2 no debe declarar tursoDatabaseUrl.');
    if (typeof deployment.r2Bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(deployment.r2Bucket)) errors.push('Falta un r2Bucket válido en deployment.local.json.');
  } else if (storageProvider === 'turso') {
    if (hasOwn(deployment, 'r2Bucket')) errors.push('deployment.local.json para Turso no debe declarar r2Bucket.');
    if (!isTursoDatabaseUrl(deployment.tursoDatabaseUrl)) errors.push('Falta un tursoDatabaseUrl válido en deployment.local.json.');
  }

  const emailBindings = production.send_email;
  const expected = [];
  if (company?.usageAlerts?.enabled && usageAlertDelivery === 'cloudflare') {
    expected.push({
      name: 'USAGE_ALERT_EMAIL',
      destination_address: company.archiveAddress,
      allowed_sender_addresses: [company.mailbox.address],
    });
  }
  const archiveEnabled = company?.archiveCopies?.enabled !== false;
  const summaryEnabled = company?.incomingSummary?.enabled === true;
  if (archiveEnabled || summaryEnabled) {
    const allowedArchiveSenders = [...new Set([company.mailbox.address, ...(summaryEnabled ? [company.incomingSummary.from.email] : [])])];
    expected.push({ name: 'ARCHIVE_EMAIL_COPY', destination_address: company.archiveAddress, allowed_sender_addresses: allowedArchiveSenders });
  }
  if (expected.length ? !sameJson(emailBindings, expected) : hasOwn(production, 'send_email')) errors.push('Los bindings Email Service deben limitarse a los canales habilitados, archiveAddress y mailbox.address.');
}

if (production) {
  const vars = production.vars ?? {};
  const d1 = oneBinding(production, 'd1_databases', 'DB');
  const assets = production.assets;

  if (production.name === 'company-systems-web') errors.push('El webmail debe tener un Worker separado.');
  if (typeof production.name !== 'string' || !/^[a-z0-9-]+$/.test(production.name)) errors.push('El nombre del Worker de producción no es válido.');
  if (deployment?.workerName && production.name !== deployment.workerName) errors.push('El nombre del Worker no coincide con deployment.local.json.');
  if (deployment?.accountId && production.account_id !== deployment.accountId) errors.push('account_id no coincide con deployment.local.json.');

  if (!d1) errors.push('Producción debe declarar exactamente un binding D1 llamado DB.');
  if (!assets || assets.binding !== 'ASSETS') errors.push('Producción debe declarar el binding de assets ASSETS.');
  if (d1 && deployment?.d1DatabaseId && d1.database_id !== deployment.d1DatabaseId) errors.push('El database_id de D1 no coincide con deployment.local.json.');
  if (d1 && deployment?.d1DatabaseName && d1.database_name !== deployment.d1DatabaseName) errors.push('El nombre de D1 no coincide con deployment.local.json.');
  if (d1?.database_id?.startsWith('00000000')) errors.push('La base D1 no está configurada.');

  if (storageProvider === 'r2') {
    const r2 = oneBinding(production, 'r2_buckets', 'MAIL');
    if (!r2) errors.push('Producción R2 debe declarar exactamente un binding R2 llamado MAIL.');
    if (r2 && deployment?.r2Bucket && r2.bucket_name !== deployment.r2Bucket) errors.push('El bucket R2 no coincide con deployment.local.json.');
    if (hasOwn(vars, 'TURSO_DATABASE_URL')) errors.push('Producción R2 no debe declarar TURSO_DATABASE_URL.');
  } else if (storageProvider === 'turso') {
    if (hasOwn(production, 'r2_buckets')) errors.push('Producción Turso no debe declarar r2_buckets.');
    if (!isTursoDatabaseUrl(vars.TURSO_DATABASE_URL)) errors.push('Producción debe declarar una TURSO_DATABASE_URL válida.');
    if (deployment && hasOwn(deployment, 'tursoDatabaseUrl') && vars.TURSO_DATABASE_URL !== deployment.tursoDatabaseUrl) errors.push('TURSO_DATABASE_URL no coincide con deployment.local.json.');
  }

  let productionCompany;
  try { productionCompany = JSON.parse(vars.COMPANY_CONFIG); }
  catch { productionCompany = undefined; }
  if (!draft || !sameJson(productionCompany, company)) errors.push('La configuración de producción está desactualizada. Ejecuta configure con el archivo de la empresa.');
  if (vars.APP_ENV !== 'production') errors.push('Producción debe usar APP_ENV=production.');
  for (const localVar of ['APP_ORIGIN', 'DEV_AUTH_EMAIL']) {
    if (hasOwn(vars, localVar)) errors.push(`Producción contiene la variable local ${localVar}.`);
  }
  if (production.workers_dev !== false || production.preview_urls !== false) errors.push('Los hosts alternativos deben estar deshabilitados.');

  if (companyHost) {
    const routes = production.routes;
    const route = Array.isArray(routes) && routes.length === 1 ? routes[0] : undefined;
    if (!route || route.custom_domain !== true || route.pattern !== companyHost) errors.push('El custom domain de producción no coincide con COMPANY_CONFIG.appOrigin.');
  }
  if (authProvider === 'google') {
    if (!isGoogleClientId(vars.GOOGLE_CLIENT_ID)) errors.push('Producción debe declarar un GOOGLE_CLIENT_ID válido.');
    if (deployment?.googleClientId && vars.GOOGLE_CLIENT_ID !== deployment.googleClientId) errors.push('GOOGLE_CLIENT_ID no coincide con deployment.local.json.');
    if (hasOwn(vars, 'ACCESS_TEAM_DOMAIN') || hasOwn(vars, 'ACCESS_AUD')) errors.push('Producción Google no debe declarar variables de Cloudflare Access.');
  } else {
    if (deployment?.accessTeamDomain && vars.ACCESS_TEAM_DOMAIN !== deployment.accessTeamDomain) errors.push('ACCESS_TEAM_DOMAIN no coincide con deployment.local.json.');
    if (deployment?.accessAudience && vars.ACCESS_AUD !== deployment.accessAudience) errors.push('ACCESS_AUD no coincide con deployment.local.json.');
    if (!vars.ACCESS_TEAM_DOMAIN || !vars.ACCESS_AUD) errors.push('Falta configurar Cloudflare Access.');
    if (hasOwn(vars, 'GOOGLE_CLIENT_ID')) errors.push('Producción Access no debe declarar GOOGLE_CLIENT_ID.');
  }
  if (company?.usageAlerts?.enabled && vars.CLOUDFLARE_ACCOUNT_ID !== deployment?.accountId) errors.push('La cuenta para las alertas de uso no coincide con deployment.local.json.');
}

const emailProvider = company?.provider ?? 'mailjet';
const requiredSecrets = [];
if (emailProvider === 'mailjet') requiredSecrets.push('MAILJET_API_KEY', 'MAILJET_API_SECRET', 'MAILJET_WEBHOOK_USER', 'MAILJET_WEBHOOK_PASSWORD');
if (authProvider === 'google') requiredSecrets.push('GOOGLE_CLIENT_SECRET');
if (storageProvider === 'turso') requiredSecrets.push('TURSO_AUTH_TOKEN');
if (company?.usageAlerts?.enabled) requiredSecrets.push('CF_USAGE_API_TOKEN');
if (company?.archiveCopies?.enabled !== false || company?.incomingSummary?.enabled) requiredSecrets.push('ARCHIVE_LINK_KEY');

console.log(`Webmail: ${company?.mailbox?.address ?? 'configuración incompleta'}`);
if (company) console.log(`Retención: ${company.retentionDays} días; almacén temporal: ${storageProvider}; presupuesto: ${(company.storageBudgetBytes / 1e9).toFixed(1)} GB.`);
console.log('Verificación local únicamente; no se consultan recursos remotos y las credenciales no se verifican.');
for (const error of errors) console.log(`PENDIENTE: ${error}`);
console.log(`Secretos remotos requeridos (no verificados): ${requiredSecrets.length ? requiredSecrets.join(', ') : 'ninguno'}.`);
if (strict && errors.length) process.exitCode = 1;
