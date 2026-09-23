/**
 * dsh-molbio-tools/benchmark/harness.mjs
 *
 * Locate an installed DSH harness and read compositions with ITS YAML dialect.
 *
 * The benchmark has to agree with `test/preset-health.mjs` on two facts that
 * are easy to get subtly wrong, so this module is the single source they share:
 *
 *  - **which harness** is installed (`DSH_HARNESS_ROOT`, the global npm prefix,
 *    then the known system locations), and
 *  - **how a patch file is parsed**: not with stock YAML, but with the Loader's
 *    own `entryListSchema`, whose `!!js` scalar tag round-trips as an
 *    `{ __jsExpr }` node. Stock `yaml.load` turns `disabled: !!js ...` into a
 *    *string*, which compares unequal to the node the Loader produces — a
 *    comparison done with the wrong dialect reports drift that is not there.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** Strip the `@deepseek-ai/` scope for the npm/global-prefix probe. */
function harnessCandidates() {
  const candidates = [];
  if (process.env.DSH_HARNESS_ROOT) candidates.push(process.env.DSH_HARNESS_ROOT);
  // The global npm prefix is asked FIRST because it is the only portable
  // answer: a literal `C:\Users\<name>\AppData\...` probe (which this list used
  // to start with) is wrong on every machine but one, and there is no way to
  // tell from the code that it is wrong — the resolver just falls through and
  // reports "no harness installed".
  const globalPrefixes = [
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    process.env.npm_config_prefix === undefined ? undefined : join(process.env.npm_config_prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ];
  try {
    const prefix = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (prefix) candidates.push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'));
  } catch {
    /* npm absent: fall through to the remaining probes */
  }
  for (const candidate of globalPrefixes) {
    if (candidate !== undefined) candidates.push(candidate);
  }
  for (const probe of ['/usr/local/lib/node_modules/@deepseek-ai/dsh', '/usr/lib/node_modules/@deepseek-ai/dsh']) {
    candidates.push(probe);
  }
  return candidates;
}

/**
 * The installed harness root that actually contains the DSH packages.
 *
 * @param {string} [explicit] a `--dsh <root>` value, tried first.
 * @returns {string|undefined} the resolved root, or undefined when none is installed.
 */
export function findHarnessRoot(explicit) {
  const candidates = explicit ? [explicit, ...harnessCandidates()] : harnessCandidates();
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-persona', 'package.json'))) {
      return resolve(candidate);
    }
  }
  return undefined;
}

/** Where the harness keeps its own dependencies. */
export function packagesDir(harnessRoot) {
  return join(harnessRoot, 'node_modules', '@deepseek-ai');
}

/** Node's upward `node_modules` walk, the same rule the preset roster uses. */
export function packageInstalled(name, from) {
  const pkg = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return join(dir, 'node_modules', pkg);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The ESM entry a package exposes as its default export. */
export function entryOf(pkgDir, exportsField) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return pick(value.default ?? value.import ?? value.require);
    return undefined;
  };
  const relative = pick(exportsField) ?? 'index.js';
  return join(pkgDir, relative.replace(/^\.\//, ''));
}

/** Import an installed package by its own manifest, scope-independent. */
export async function importPackage(name, harnessRoot) {
  const pkgDir = packageInstalled(name, harnessRoot);
  if (pkgDir === undefined) throw new Error(`benchmark: ${name} is not installed beside the harness`);
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  return await import(pathToFileURL(entryOf(pkgDir, manifest.exports?.['.'] ?? manifest.exports ?? manifest.main)).href);
}

/**
 * The Loader's YAML dialect, loaded once per process.
 *
 * @param {string} harnessRoot the installed harness.
 * @returns {Promise<{yaml: object, schema: object}>} the `js-yaml` module and `entryListSchema`.
 */
export async function loaderYaml(harnessRoot) {
  const { entryListSchema } = await importPackage('@deepseek-ai/cordis-plugin-include', harnessRoot);
  const yaml = (await importPackage('js-yaml', harnessRoot)).default;
  return { yaml, schema: entryListSchema };
}

/**
 * Parse a composition (or any patch layer) with the Loader's own dialect.
 *
 * @param {string} path the YAML file.
 * @param {string} harnessRoot the installed harness.
 * @returns {Promise<unknown>} the parsed document.
 */
export async function readComposition(path, harnessRoot) {
  const { yaml, schema } = await loaderYaml(harnessRoot);
  return yaml.load(await readFile(path, 'utf8'), { schema });
}

/** The harness version, for report headers. */
export async function harnessVersion(harnessRoot) {
  return JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')).version;
}

/**
 * The JavaScript entry point of the `dsh` launcher, from its own manifest.
 *
 * The benchmark spawns this with `process.execPath` instead of calling the
 * `dsh` shim, because the shim is a `.cmd`/`.ps1`/shell script and Node refuses
 * to spawn a `.cmd` without `shell: true` — and `shell: true` CONCATENATES
 * argv rather than escaping it, so on Windows a task instruction arrived as its
 * first word only (`"Save this text exactly:\n\n…"` reached the model as
 * `Save`). Running the real JS entry with an argv array and no shell is the
 * only form that carries a multi-line instruction intact on every platform.
 *
 * @param {string} harnessRoot the installed harness.
 * @returns {Promise<{entry: string, node: string}>}
 */
export async function launcherCommand(harnessRoot) {
  const manifest = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8'));
  const bin = manifest.bin;
  const relative = typeof bin === 'string' ? bin : bin?.dsh;
  if (typeof relative !== 'string') {
    throw new Error(`benchmark: ${harnessRoot}/package.json declares no \`bin.dsh\` entry`);
  }
  const entry = join(harnessRoot, relative);
  if (!existsSync(entry)) throw new Error(`benchmark: the dsh launcher entry is missing: ${entry}`);
  return { entry, node: process.execPath };
}
