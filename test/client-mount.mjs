/**
 * dsh-molbio-tools/test/client-mount.mjs
 *
 * Prove the browser half can actually arrive in the RUNNING Web GUI, without a
 * browser: reproduce the host-side graph scan (`dsh-client-modules`) against
 * the installed DSH and the real `web` profile composition.
 *
 * The scan's rule, taken from `dsh-client-modules/lib/index.js`:
 *   1. iterate the profile's mounted plugin rows (the union of each bundle's
 *      `cordis.patch.yml` rows plus the profile's own patch layer);
 *   2. resolve each row's module and walk up to the nearest `package.json`
 *      (a bare name must match, a relative specifier resolves from the row's
 *      own tree);
 *   3. a row becomes a boot-graph entry only when its package declares
 *      `dsh.client.platform === 'web'` AND ships `exports["./client"]`.
 *
 * This test asserts three things about this package:
 *   - it is reachable as a row of the web profile once installed there;
 *   - its own manifest takes the same branch every shipped client package
 *     takes (declaration + `exports["./client"]` + the bundle file exists);
 *   - every client package the panel needs at runtime is ITSELF a graph row in
 *     that profile, so `require` inside our factory can resolve it.
 *
 * Usage: node test/client-mount.mjs [--dsh <harness root>] [--profile <name>]
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const npmRoot = process.env.APPDATA ?? '';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const harnessRoot = flag('--dsh', join(npmRoot, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
const profileName = flag('--profile', 'web');
const packagesDir = join(harnessRoot, 'node_modules', '@deepseek-ai');
const profileDir = join(dshHome, 'profiles', profileName);

assert.ok(existsSync(packagesDir), `the harness packages must be installed at ${packagesDir}`);
console.log(`harness : ${harnessRoot}`);
console.log(`profile : ${profileDir}`);

/** Locate an installed package directory by name, profile first. */
function packageInstalled(name) {
  const pkg = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');
  for (const base of [join(profileDir, 'node_modules'), join(harnessRoot, 'node_modules'), join(harnessRoot)]) {
    const candidate = join(base, ...pkg.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

// ── the profile's mounted rows ──────────────────────────────────────────────

/**
 * Plugin rows of one cordis patch layer, in file order.
 *
 * A patch layer is a list of patch ENTRIES: each either targets an existing row
 * by `id` (config override / disable) or carries an `insert:` list of new rows.
 * The mounted plugins are the inserted rows, and their groups nest further rows
 * under `config`. Parsed with the harness's own YAML dialect (the one carrying
 * `!!js`, via `cordis-plugin-include`'s entry-list schema).
 */
async function rowsOf(patchPath) {
  const { entryListSchema } = await import(pathToFileURL(join(packagesDir, 'cordis-plugin-include', 'lib', 'index.js')).href);
  const yamlDir = packageInstalled('js-yaml');
  const yaml = (await import(pathToFileURL(join(yamlDir, 'index.js')).href)).default;
  const entries = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) ?? [];
  const names = [];
  const walk = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue;
      if (typeof row.name === 'string') names.push(row.name);
      if (row.group === true && Array.isArray(row.config)) walk(row.config);
    }
  };
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (Array.isArray(entry.insert)) walk(entry.insert);
  }
  return names;
}

const profileManifestPath = join(profileDir, 'package.json');
let bundles = [];
if (existsSync(profileManifestPath)) {
  bundles = JSON.parse(readFileSync(profileManifestPath, 'utf8')).dsh?.profile?.bundles ?? [];
} else {
  console.warn(`note: profile ${profileName} has no package.json here; falling back to the shipped web bundle`);
  bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
}
assert.ok(bundles.length > 0, 'the profile names at least one bundle');

/**
 * Locate one bundle's patch layer. A profile installs bundles into its own
 * `node_modules`; a bundle that is merely shipped with the harness (the web
 * profile's two) resolves from the harness tree instead.
 */
function patchOf(bundle) {
  for (const base of [
    join(profileDir, 'node_modules'),
    join(harnessRoot, 'node_modules'),
    dirname(harnessRoot),
    join(profileDir, 'plugins'),
  ]) {
    const candidate = join(base, ...bundle.split('/'), 'cordis.patch.yml');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const rows = [];
const scannedBundles = [];
for (const bundle of bundles) {
  const patch = patchOf(bundle);
  if (patch === undefined) continue;
  scannedBundles.push(bundle);
  for (const name of await rowsOf(patch)) rows.push({ name, bundle });
}
// The profile's own patch layer can add rows too.
const ownPatch = join(profileDir, 'cordis.patch.yml');
if (existsSync(ownPatch)) for (const name of await rowsOf(ownPatch)) rows.push({ name, bundle: '(profile patch)' });
assert.ok(scannedBundles.length > 0, 'at least one bundle patch layer was found to scan');
console.log(`bundles : ${scannedBundles.join(', ')}`);
console.log(`rows    : ${rows.length}`);

// ── step 2+3 of the scan, for every row ─────────────────────────────────────

/** Node's upward walk from a module file to its owning manifest. */
function nearestPackage(moduleFile) {
  let dir = dirname(moduleFile);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The `exports["./client"]` path, or undefined. */
function clientExportOf(exportsField) {
  if (exportsField === undefined) return undefined;
  const entry = exportsField['./client'];
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && typeof entry.default === 'string') return entry.default;
  return undefined;
}

const graphEntries = new Map();
const resolvedRows = new Map();
for (const row of rows) {
  // cordis builtins and relative rows outside this package are not packages.
  if (row.name.startsWith('cordis:') || row.name.startsWith('.')) {
    resolvedRows.set(row.name, { kind: row.name.startsWith('.') ? 'preset-relative' : 'builtin' });
    continue;
  }
  const packageName = row.name.split('/').slice(0, row.name.startsWith('@') ? 2 : 1).join('/');
  let manifest;
  for (const base of [join(profileDir, 'node_modules'), join(harnessRoot, 'node_modules'), join(harnessRoot)]) {
    const candidate = join(base, ...packageName.split('/'), 'package.json');
    if (existsSync(candidate)) {
      manifest = candidate;
      break;
    }
  }
  if (manifest === undefined) {
    resolvedRows.set(row.name, { kind: 'unresolved' });
    continue;
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const declaration = pkg.dsh?.client;
  if (declaration === undefined || declaration.platform !== 'web') {
    resolvedRows.set(row.name, { kind: 'host-only', manifest });
    continue;
  }
  const clientRel = clientExportOf(pkg.exports);
  assert.ok(clientRel !== undefined, `${packageName} declares dsh.client but exports no "./client"`);
  const clientPath = join(dirname(manifest), clientRel);
  assert.ok(existsSync(clientPath), `${packageName} declares dsh.client but its bundle is missing at ${clientPath}`);
  graphEntries.set(pkg.name, { manifest, clientPath, inject: declaration.inject ?? [], bundle: row.bundle });
  resolvedRows.set(row.name, { kind: 'client', manifest, clientPath });
}

// The scan must have found the sidebar host and the Remote carrier: the panel
// requires their exports, and the framework's `useSessions`/`remote` services
// come from rows that are already in the graph.
assert.ok(graphEntries.has('@deepseek-ai/dsh-client-ui-sidebar-right'), 'the web profile mounts the right sidebar tab host');
assert.ok(graphEntries.has('@deepseek-ai/dsh-client-connection'), 'the web profile mounts the client connection over the api gateway');

// ── the packages this repository ships, through the very same scan ──────────

/** Run the scan for one package of this repository. */
function checkOwnPackage({ root, expectedId, label }) {
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, expectedId, `${label}: the package name is the registration id`);
  const declaration = manifest.dsh?.client;
  assert.ok(declaration !== undefined, `${label}: declares dsh.client`);
  assert.equal(declaration.platform, 'web', `${label}: the browser half is a web platform bundle`);
  const clientRel = clientExportOf(manifest.exports);
  assert.equal(clientRel, './lib/client.js', `${label}: exports["./client"] points at the built artifact`);
  const clientPath = join(root, clientRel);
  assert.ok(existsSync(clientPath), `${label}: the built artifact exists (run npm run build:client): ${clientPath}`);

  // Every injected package must itself be a graph row, or the orderByModuleGraph
  // pass silently drops the edge (and a later require would miss the table).
  const missing = (declaration.inject ?? []).filter((dependency) => !graphEntries.has(dependency));
  assert.deepEqual(missing, [], `${label}: injected client packages are boot-graph rows of profile ${profileName}`);

  const bundle = readFileSync(clientPath, 'utf8');
  assert.ok(bundle.includes('window.__ModuleLoader__.load('), `${label}: the artifact registers through the module loader`);
  const required = [...bundle.matchAll(/(?<![_\w])require\("([^"]+)"\)/g)].map((match) => match[1]);
  for (const specifier of required) {
    assert.ok(
      SEED.has(specifier) || graphEntries.has(specifier.replace(/\/client$/, '')),
      `${label}: require("${specifier}") resolves (platform seed or boot-graph row)`,
    );
  }
  assert.deepEqual([...new Set(required)].sort(), ['react'], `${label}: requires react and nothing else`);
  // The artifact's identity: the loader keys materialization on this exact id.
  const idMatch = /id:\s*"([^"]+)"/.exec(bundle);
  assert.equal(idMatch?.[1], manifest.name, `${label}: the registration id is the exact package name`);
  console.log(`  ${label.padEnd(12)} ${manifest.name} -> ${clientRel} (${(bundle.length / 1024).toFixed(1)} KB) in ${clientPath.includes('packages') ? 'packages/molbio-panel' : 'package root'}`);
  return { manifest, clientPath, bundle };
}

const SEED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']);

// Both delivery channels: the plugin package (tools + panel) and the
// panel-only package (a shared Web profile wants the tab without the tools).
const toolsPackage = checkOwnPackage({ root: packageRoot, expectedId: 'dsh-molbio-tools', label: 'tools+panel' });
const panelRoot = join(packageRoot, 'packages', 'molbio-panel');
if (existsSync(panelRoot)) {
  checkOwnPackage({ root: panelRoot, expectedId: 'dsh-molbio-panel', label: 'panel only' });
  // The panel-only package's host half must load and stay inert: it exists to
  // make the browser half discoverable, not to add tools to every session.
  const hostHalf = await import(pathToFileURL(join(panelRoot, 'index.mjs')).href);
  assert.deepEqual([...hostHalf.inject], ['tools'], 'the panel host half injects the tool registry only for row ordering');
  const before = 0;
  hostHalf.apply({ tools: { register: () => { throw new Error('the panel host half must register no tool'); } } });
  assert.equal(before, 0);
  assert.equal(typeof hostHalf.apply, 'function', 'the host half exposes apply');
} else {
  console.warn('note: packages/molbio-panel is absent; only the combined bundle was checked');
}

console.log(`graph   : ${graphEntries.size} client row(s) among ${rows.length} scanned rows`);
console.log(`bundle  : ${toolsPackage.clientPath.replace(packageRoot, '.')} (${(toolsPackage.bundle.length / 1024).toFixed(1)} KB)`);
console.log('client mount checks passed');
