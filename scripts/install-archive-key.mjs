import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'wrangler.production.jsonc'), 'utf8'));
if (config.vars?.APP_ENV !== 'production' || !config.account_id || !config.name) throw new Error('Completa configure y doctor de producción antes de instalar la clave.');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args, '--config', 'wrangler.production.jsonc'], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    // Error text never contains the generated key: it is sent only on stdin.
    child.stderr.on('data', value => { process.stderr.write(value); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Wrangler terminó con código ${code}.`)));
    child.stdin.end(input ?? '');
  });
}
const existing = JSON.parse(await run(['secret', 'list']));
if (!Array.isArray(existing)) throw new Error('No se pudo comprobar el listado de secretos.');
if (existing.some(secret => secret.name === 'ARCHIVE_LINK_KEY')) {
  console.log('ARCHIVE_LINK_KEY ya existe; se conserva para que sigan funcionando los enlaces anteriores.');
} else {
  const payload = JSON.stringify({ ARCHIVE_LINK_KEY: randomBytes(32).toString('base64url') });
  await run(['secret', 'bulk'], payload);
  console.log(`ARCHIVE_LINK_KEY instalada como secreto de ${config.name}. No se guardó ni mostró su valor.`);
}
