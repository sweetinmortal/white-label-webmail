import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const companyFlag = args.indexOf('--company');
if (companyFlag >= 0 && !args[companyFlag + 1]) throw new Error('Indica una ruta después de --company.');
const companyPath = path.resolve(root, companyFlag >= 0 ? args[companyFlag + 1] : 'config/companies/example.json');
const company = JSON.parse(await readFile(companyPath, 'utf8'));
const authProvider = company.auth?.provider ?? 'access';
if (company.auth !== undefined && (!company.auth || typeof company.auth !== 'object' || Array.isArray(company.auth)
  || typeof company.auth.provider !== 'string' || Object.keys(company.auth).some((key) => key !== 'provider')
  || !['google', 'access'].includes(authProvider))) {
  throw new Error('auth debe contener únicamente provider: google o access.');
}
if (!['google', 'access'].includes(authProvider)) throw new Error('auth.provider debe ser google o access.');
const storageProvider = company.storageProvider ?? 'r2';
if (!['r2', 'turso'].includes(storageProvider)) throw new Error('storageProvider debe ser r2 o turso.');
const usageAlertDelivery = company.usageAlerts?.delivery ?? 'mailjet';
const archiveCopiesEnabled = company.archiveCopies?.enabled !== false;
if (!['mailjet', 'cloudflare'].includes(usageAlertDelivery)) throw new Error('usageAlerts.delivery debe ser mailjet o cloudflare.');
if (company.incomingSummary?.enabled && (typeof company.incomingSummary.from?.email !== 'string' || !company.incomingSummary.from.email)) {
  throw new Error('incomingSummary.from.email es obligatorio cuando el resumen está activo.');
}
const summarySender = company.incomingSummary?.enabled ? company.incomingSummary.from.email : undefined;
const allowedArchiveSenders = [...new Set([company.mailbox.address, ...(summarySender ? [summarySender] : [])])];
const companyJson = JSON.stringify(company);
const productionPath = path.join(root, 'wrangler.production.jsonc');

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

const base = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: 'company-webmail',
  main: 'worker/index.ts',
  compatibility_date: '2026-07-17',
  workers_dev: false,
  preview_urls: false,
  assets: { binding: 'ASSETS', directory: './dist', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
  d1_databases: [{ binding: 'DB', database_name: 'company-mail', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
  triggers: { crons: ['15 * * * *'] },
  vars: { APP_ENV: 'production', COMPANY_CONFIG: companyJson },
};
if (storageProvider === 'r2') {
  base.r2_buckets = [{ binding: 'MAIL', bucket_name: 'company-mail' }];
} else {
  // The draft has no production URL; this empty value permits a local dry run.
  base.vars.TURSO_DATABASE_URL = '';
}

// Draft config has no routes and does not include a production route.
await writeFile(path.join(root, 'wrangler.jsonc'), JSON.stringify(base, null, 2) + '\n');
const local = structuredClone(base);
local.name = 'company-webmail-local';
local.d1_databases[0].database_name = 'company-mail-local';
// Local development always uses the R2 emulator, independent of the production store.
local.r2_buckets = [{ binding: 'MAIL', bucket_name: 'company-mail-local' }];
delete local.triggers;
delete local.vars.TURSO_DATABASE_URL;
local.vars = { ...local.vars, APP_ENV: 'local', APP_ORIGIN: 'http://127.0.0.1:8788', DEV_AUTH_EMAIL: company.allowedUsers[0] };
await writeFile(path.join(root, 'wrangler.local.jsonc'), JSON.stringify(local, null, 2) + '\n');

let deployment;
try { deployment = JSON.parse(await readFile(path.join(root, 'deployment.local.json'), 'utf8')); }
catch (error) {
  await rm(productionPath, { force: true });
  if (error.code !== 'ENOENT') throw error;
  console.log('Configuración local lista. Completa deployment.local.json para generar producción.');
  process.exit(0);
}

// An incomplete manifest must never leave an older deployable config behind.
await rm(productionPath, { force: true });
if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) throw new Error('deployment.local.json debe ser un objeto JSON.');
const required = ['accountId', 'd1DatabaseId', ...(authProvider === 'google' ? ['googleClientId'] : ['accessTeamDomain', 'accessAudience'])];
for (const key of required) {
  if (typeof deployment[key] !== 'string' || !deployment[key]) throw new Error(`Falta ${key} en deployment.local.json.`);
}
if (!/^[a-f0-9]{32}$/.test(deployment.accountId)) throw new Error('accountId de Cloudflare no válido.');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deployment.d1DatabaseId)
  || deployment.d1DatabaseId === '00000000-0000-0000-0000-000000000000') throw new Error('d1DatabaseId de Cloudflare no válido.');
if (authProvider === 'google') {
  if (Object.hasOwn(deployment, 'accessTeamDomain') || Object.hasOwn(deployment, 'accessAudience')) throw new Error('La configuración Google no debe incluir accessTeamDomain ni accessAudience.');
  if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(deployment.googleClientId)) throw new Error('googleClientId de Google no válido.');
} else {
  if (Object.hasOwn(deployment, 'googleClientId')) throw new Error('La configuración Access no debe declarar googleClientId.');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(deployment.accessTeamDomain)) throw new Error('accessTeamDomain no válido.');
}

if (storageProvider === 'r2') {
  if (Object.hasOwn(deployment, 'tursoDatabaseUrl')) throw new Error('deployment.local.json para R2 no debe declarar tursoDatabaseUrl.');
  if (typeof deployment.r2Bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(deployment.r2Bucket)) throw new Error('Falta un r2Bucket válido en deployment.local.json.');
} else {
  if (Object.hasOwn(deployment, 'r2Bucket')) throw new Error('deployment.local.json para Turso no debe declarar r2Bucket.');
  if (!isTursoDatabaseUrl(deployment.tursoDatabaseUrl)) throw new Error('tursoDatabaseUrl debe ser una URL libsql:// o https:// de *.turso.io, sin ruta, puerto, credenciales, query ni fragmento.');
}

const production = structuredClone(base);
production.name = deployment.workerName || 'company-webmail';
if (!/^[a-z0-9-]+$/.test(production.name) || production.name === 'company-systems-web') throw new Error('Usa un Worker separado del sitio corporativo.');
production.account_id = deployment.accountId;
production.d1_databases[0] = { ...base.d1_databases[0], database_name: deployment.d1DatabaseName || 'company-mail', database_id: deployment.d1DatabaseId };
if (storageProvider === 'r2') {
  production.r2_buckets = [{ binding: 'MAIL', bucket_name: deployment.r2Bucket }];
} else {
  delete production.r2_buckets;
  production.vars.TURSO_DATABASE_URL = deployment.tursoDatabaseUrl;
}
production.routes = [{ pattern: new URL(company.appOrigin).hostname, custom_domain: true }];
if (authProvider === 'google') {
  production.vars.GOOGLE_CLIENT_ID = deployment.googleClientId;
} else {
  production.vars.ACCESS_TEAM_DOMAIN = deployment.accessTeamDomain;
  production.vars.ACCESS_AUD = deployment.accessAudience;
}
if (company.usageAlerts?.enabled) production.vars.CLOUDFLARE_ACCOUNT_ID = deployment.accountId;
if (company.usageAlerts?.enabled && usageAlertDelivery === 'cloudflare') {
  production.send_email = [{
    name: 'USAGE_ALERT_EMAIL',
    destination_address: company.archiveAddress,
    allowed_sender_addresses: [company.mailbox.address],
  }];
}
if (archiveCopiesEnabled || summarySender) {
  (production.send_email ??= []).push({
    name: 'ARCHIVE_EMAIL_COPY',
    destination_address: company.archiveAddress,
    allowed_sender_addresses: allowedArchiveSenders,
  });
}
await writeFile(productionPath, JSON.stringify(production, null, 2) + '\n');
console.log('Configuración local y de producción generadas. No se ha creado ni desplegado ningún recurso.');
