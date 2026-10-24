#!/usr/bin/env node
/**
 * Aplica una actualización de la plantilla pública sobre una instalación.
 *
 * No usa la historia de Git de la instalación: descarga la versión anterior y
 * la nueva de la plantilla y hace un merge de tres vías por archivo. La versión
 * anterior queda registrada en `.template-version`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const templateRepo = process.env.TEMPLATE_REPO || 'sweetinmortal/white-label-webmail';
const templateUrl = process.env.TEMPLATE_GIT_URL || `https://github.com/${templateRepo}.git`;
const templateToken = process.env.TEMPLATE_TOKEN || '';
const requestedTag = process.env.TEMPLATE_TARGET_TAG || '';
const gitEnvironment = { ...process.env };

if (templateToken && !process.env.TEMPLATE_GIT_URL) {
  const basic = Buffer.from(`x-access-token:${templateToken}`).toString('base64');
  gitEnvironment.GIT_CONFIG_COUNT = '1';
  gitEnvironment.GIT_CONFIG_KEY_0 = `http.${templateUrl}.extraheader`;
  gitEnvironment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
}
const versionFile = '.template-version';
const versionPath = path.join(cwd, versionFile);
const summaryPath = process.env.UPDATE_SUMMARY_PATH || '';

const excludedExact = new Set([
  '.template-version',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'DCO',
  'CODE_OF_CONDUCT.md',
  'THIRD_PARTY_NOTICES.md',
  '.github/pull_request_template.md',
  '.github/workflows/dco.yml',
  '.github/workflows/release.yml',
  'wrangler.jsonc',
  'wrangler.local.jsonc',
]);

const excludedPrefixes = [
  '.git/',
  'node_modules/',
  'dist/',
  '.wrangler/',
  '.qa/',
  'coverage/',
  'test-results/',
  'playwright-report/',
  'docs/',
  'config/companies/',
  'public/brand/',
];

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment,
  });
}

function readGitFile(root, relativePath) {
  const result = spawnSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function listGitFiles(root) {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`No se pudo listar el árbol Git de ${root}`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isExcluded(relativePath) {
  if (relativePath === 'config/companies/example.json') return false;
  if (relativePath === '.dev.vars.example' || relativePath === '.env.example') return false;
  if (excludedExact.has(relativePath)) return true;
  return excludedPrefixes.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function equal(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareTags(left, right) {
  const a = parseTag(left);
  const b = parseTag(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function latestTemplateTag() {
  const output = runGit(cwd, ['ls-remote', '--tags', '--refs', templateUrl]);
  const tags = output
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/tags\//, ''))
    .filter((tag) => parseTag(tag));

  if (tags.length === 0) {
    throw new Error(`No hay tags vX.Y.Z en ${templateUrl}`);
  }

  tags.sort(compareTags);
  return tags.at(-1);
}

async function writeRepoFile(relativePath, content) {
  const fullPath = path.join(cwd, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function deleteRepoFile(relativePath) {
  await rm(path.join(cwd, relativePath), { force: true });
}

async function mergeText(workDir, index, local, base, next) {
  const mergeDir = path.join(workDir, `merge-${index}`);
  await mkdir(mergeDir, { recursive: true });
  const localPath = path.join(mergeDir, 'local');
  const basePath = path.join(mergeDir, 'base');
  const nextPath = path.join(mergeDir, 'next');
  await writeFile(localPath, local);
  await writeFile(basePath, base);
  await writeFile(nextPath, next);

  const result = spawnSync('git', [
    'merge-file',
    '-p',
    '--diff3',
    '-L',
    'instalacion',
    '-L',
    'base',
    '-L',
    'plantilla',
    localPath,
    basePath,
    nextPath,
  ], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status === null || result.status < 0) {
    throw new Error(`git merge-file falló para ${localPath}`);
  }

  return { content: result.stdout, conflicts: result.status > 0 };
}

async function checkMigrationCollisions(conflicts) {
  const migrationsDir = path.join(cwd, 'migrations');
  if (!existsSync(migrationsDir)) return;

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql'));
  const byPrefix = new Map();
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue;
    const list = byPrefix.get(match[1]) ?? [];
    list.push(file);
    byPrefix.set(match[1], list);
  }

  for (const [prefix, names] of byPrefix) {
    if (names.length > 1) {
      conflicts.push(`migrations: prefijo numérico duplicado ${prefix}: ${names.join(', ')}`);
    }
  }
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
}

async function main() {
  const rawCurrent = existsSync(versionPath) ? (await readFile(versionPath, 'utf8')).trim() : '';
  if (!rawCurrent) {
    throw new Error(`Falta ${versionFile}. Una instalación debe conservar la versión base de la plantilla.`);
  }
  if (rawCurrent === 'source') {
    console.log('Repositorio de la plantilla: no hay actualización que aplicar.');
    await setOutput('has_changes', 'false');
    await setOutput('has_conflicts', 'false');
    return;
  }
  if (!parseTag(rawCurrent)) {
    throw new Error(`${versionFile} debe contener un tag vX.Y.Z o "source"; contiene "${rawCurrent}".`);
  }

  const dirty = runGit(cwd, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty) {
    throw new Error(`Hay cambios locales sin commit:\n${dirty}\nHaz commit o stash antes de actualizar.`);
  }

  const latest = requestedTag || latestTemplateTag();
  if (!parseTag(latest)) {
    throw new Error(`El tag destino no es válido: ${latest}`);
  }
  if (compareTags(latest, rawCurrent) <= 0) {
    console.log(`La instalación ya está en ${rawCurrent}; último tag disponible: ${latest}.`);
    await setOutput('has_changes', 'false');
    await setOutput('has_conflicts', 'false');
    await setOutput('from', rawCurrent);
    await setOutput('to', latest);
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'webmail-template-update-'));
  const oldDir = path.join(workDir, 'old');
  const newDir = path.join(workDir, 'new');
  const changes = [];
  const conflicts = [];
  let packageChanged = false;

  try {
    console.log(`Actualizando ${templateRepo}: ${rawCurrent} -> ${latest}`);
    runGit(cwd, ['clone', '--quiet', '--depth', '1', '--branch', rawCurrent, templateUrl, oldDir]);
    runGit(cwd, ['clone', '--quiet', '--depth', '1', '--branch', latest, templateUrl, newDir]);

    const oldFiles = new Set(listGitFiles(oldDir).filter((file) => !isExcluded(file)));
    const newFiles = new Set(listGitFiles(newDir).filter((file) => !isExcluded(file)));
    const localFiles = new Set(listGitFiles(cwd).filter((file) => !isExcluded(file)));
    const allFiles = [...new Set([...oldFiles, ...newFiles, ...localFiles])].sort();

    let mergeIndex = 0;
    for (const relativePath of allFiles) {
      const base = oldFiles.has(relativePath) ? readGitFile(oldDir, relativePath) : null;
      const next = newFiles.has(relativePath) ? readGitFile(newDir, relativePath) : null;
      let local = localFiles.has(relativePath) ? readGitFile(cwd, relativePath) : null;
      const fullPath = path.join(cwd, relativePath);

      if (local === null && existsSync(fullPath) && !localFiles.has(relativePath)) {
        local = await readFile(fullPath);
      }

      if (base === null && local === null && next === null) continue;

      if (local === null) {
        if (base !== null && next === null) continue;
        if (base !== null) {
          if (!equal(base, next)) conflicts.push(`${relativePath}: borrado en la instalación pero modificado en la plantilla`);
          continue;
        }
        if (next !== null) {
          if (existsSync(fullPath)) {
            conflicts.push(`${relativePath}: archivo local sin trackear bloquea un archivo nuevo de la plantilla`);
          } else {
            await writeRepoFile(relativePath, next);
            changes.push({ path: relativePath, kind: 'added' });
          }
        }
        continue;
      }

      if (base === null) {
        if (next === null) continue;
        if (!equal(local, next)) {
          conflicts.push(`${relativePath}: creado en la instalación y en la plantilla con contenido distinto`);
        }
        continue;
      }

      if (next === null) {
        if (equal(local, base)) {
          await deleteRepoFile(relativePath);
          changes.push({ path: relativePath, kind: 'deleted' });
        } else {
          conflicts.push(`${relativePath}: modificado en la instalación pero borrado en la plantilla`);
        }
        continue;
      }

      if (equal(local, base)) {
        await writeRepoFile(relativePath, next);
        changes.push({ path: relativePath, kind: 'updated' });
        if (relativePath === 'package.json') packageChanged = true;
        continue;
      }

      if (equal(next, base) || equal(local, next)) continue;

      if (isBinary(local) || isBinary(base) || isBinary(next)) {
        conflicts.push(`${relativePath}: archivo binario modificado en ambos lados`);
        continue;
      }

      mergeIndex += 1;
      const merged = await mergeText(workDir, mergeIndex, local, base, next);
      await writeRepoFile(relativePath, merged.content);
      changes.push({ path: relativePath, kind: merged.conflicts ? 'conflicted' : 'merged' });
      if (relativePath === 'package.json') packageChanged = true;
      if (merged.conflicts) conflicts.push(`${relativePath}: conflicto de merge`);
    }

    await checkMigrationCollisions(conflicts);
    await writeFile(versionPath, `${latest}\n`);

    const branch = `automation/template-${latest}`;
    const summary = {
      template: templateRepo,
      from: rawCurrent,
      to: latest,
      branch,
      changes,
      conflicts: [...new Set(conflicts)],
      packageChanged,
      generatedAt: new Date().toISOString(),
    };

    if (summaryPath) {
      await mkdir(path.dirname(summaryPath), { recursive: true });
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    }

    console.log(`Archivos actualizados: ${changes.length}`);
    for (const change of changes) console.log(`  ${change.kind}: ${change.path}`);
    if (summary.conflicts.length > 0) {
      console.warn(`Conflictos: ${summary.conflicts.length}`);
      for (const conflict of summary.conflicts) console.warn(`  ${conflict}`);
    }

    await setOutput('has_changes', 'true');
    await setOutput('has_conflicts', String(summary.conflicts.length > 0));
    await setOutput('from', rawCurrent);
    await setOutput('to', latest);
    await setOutput('branch', branch);
    await setOutput('package_changed', String(packageChanged));
    if (summaryPath) await setOutput('summary_path', summaryPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
