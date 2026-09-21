/**
 * Preset health check: does the shipped preset composition still load on the
 * DSH actually installed on this machine?
 *
 * Why this file exists
 * --------------------
 * `test/smoke.mjs` proves the PLUGIN works (it registers 44 tools into a mock
 * registry and validates every output schema). It cannot prove the PRESET
 * mounts, because a preset is a composition of DSH's OWN packages: if a row's
 * `config` stops matching the package's `Config` schema after a DSH upgrade,
 * the plugin code is still perfect while the preset dies at mount. That is
 * exactly the failure mode the v15 release hit on DSH 0.1.5-alpha.2 —
 * `@deepseek-ai/dsh-persona` replaced its `text` key with
 * `prefix`/`suffix`, and the composition's
 * `config: { text: ... }` began to fail with `$.prefix missing required value`.
 *
 * So this check is deliberately shallow but WIDE: for every row of a
 * composition it resolves the named package, imports it, and runs the row's
 * config through that package's own `Config` schema — the same validation the
 * Loader performs at mount, without booting a harness. It also asserts the
 * two things a composition silently rots on:
 *
 *   1. every started row names a module that exists (a renamed/uninstalled
 *      package is otherwise first noticed by a failed session start), and
 *   2. the composition still carries the rows the shipped `standard` preset
 *      carries (a preset that drops `present`, or forgets a new row upstream
 *      added, keeps working while quietly diverging from its own charter of
 *      "standard coding agent + molbio tools").
 *
 * Usage:
 *   node test/preset-health.mjs [composition.yml] [--dsh <harness root>]
 *
 * Defaults: `preset/molbio-lab/agent.cordis.yml` compared against the
 * installed DSH's shipped `standard` preset, with the harness root discovered
 * from the global npm prefix.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Rows that name no importable package. */
const NON_PACKAGE_ROWS = new Set(['cordis:group', 'cordis:builtin', 'cordis:plugin']);

/** Strip the `@deepseek-ai/` scope for the npm/global-prefix probe. */
function harnessCandidates() {
  const candidates = [];
  if (process.env.DSH_HARNESS_ROOT) candidates.push(process.env.DSH_HARNESS_ROOT);
  try {
    const prefix = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (prefix) candidates.push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'));
  } catch {
    /* npm absent: fall through to the remaining probes */
  }
  for (const probe of [
    'C:\\Users\\18771\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ]) {
    candidates.push(probe);
  }
  return candidates;
}

/** The installed harness root that actually contains the DSH packages. */
function findHarnessRoot(explicit) {
  const candidates = explicit ? [explicit, ...harnessCandidates()] : harnessCandidates();
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-persona', 'package.json'))) {
      return resolve(candidate);
    }
  }
  return undefined;
}

/** Where the harness keeps its own dependencies. */
function packagesDir(harnessRoot) {
  return join(harnessRoot, 'node_modules', '@deepseek-ai');
}

/** Node's upward `node_modules` walk, the same rule the preset roster uses. */
function packageInstalled(name, from) {
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
function entryOf(pkgDir, exportsField) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return pick(value.default ?? value.import ?? value.require);
    return undefined;
  };
  const relative = pick(exportsField) ?? 'index.js';
  return join(pkgDir, relative.replace(/^\.\//, ''));
}

/** Import an installed package by its own manifest, scope-independent. */
async function importPackage(name, harnessRoot) {
  const pkgDir = packageInstalled(name, harnessRoot);
  if (pkgDir === undefined) throw new Error(`preset-health: ${name} is not installed beside the harness`);
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  return await import(pathToFileURL(entryOf(pkgDir, manifest.exports?.['.'] ?? manifest.exports ?? manifest.main)).href);
}

/** Read a composition with the Loader's own YAML dialect (carries `!!js`). */
async function readComposition(path, harnessRoot) {
  const { entryListSchema } = await importPackage('@deepseek-ai/cordis-plugin-include', harnessRoot);
  const yaml = (await importPackage('js-yaml', harnessRoot)).default;
  const text = await readFile(path, 'utf8');
  return yaml.load(text, { schema: entryListSchema });
}

/** Flatten a composition into the rows that actually start. */
function flattenRows(rows, at = '') {
  const found = [];
  for (const [index, row] of rows.entries()) {
    const label = at === '' ? `row ${index + 1}` : `${at} > row ${index + 1}`;
    if (row && row.group === true) {
      found.push(...flattenRows(row.config, `${label} (${row.id ?? 'group'})`));
      continue;
    }
    found.push({ ...row, label });
  }
  return found;
}

/** Validate one row against its package's own `Config` schema. */
async function checkRow(row, packages, harnessRoot, presetBase) {
  const id = typeof row.id === 'string' ? row.id : row.name;
  const result = { id, name: row.name, label: row.label };
  if (NON_PACKAGE_ROWS.has(row.name)) return { ...result, status: 'skipped', detail: 'no package to import' };
  // A `disabled:` row is never started; `!!js` expressions are objects and
  // therefore truthy, which is exactly how the Loader treats them.
  if (Boolean(row.disabled)) return { ...result, status: 'disabled' };
  // The plugin this preset ships itself: a relative specifier resolves against
  // the composition's own directory, exactly as the Loader rewrites `baseUrl`.
  if (row.name.startsWith('.') || row.name.startsWith('file:')) {
    const target = row.name.startsWith('file:') ? fileURLToPath(row.name) : resolve(presetBase, row.name);
    return existsSync(target)
      ? { ...result, status: 'ok', detail: 'preset-relative module present' }
      : { ...result, status: 'unresolvable', detail: `preset-relative module not found: ${target}` };
  }

  const pkgDir = packageInstalled(row.name, harnessRoot);
  if (pkgDir === undefined) return { ...result, status: 'unresolvable', detail: 'package is not installed' };
  let entry;
  try {
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    entry = entryOf(pkgDir, manifest.exports?.['.'] ?? manifest.exports);
  } catch (error) {
    return { ...result, status: 'unresolvable', detail: `unreadable package.json: ${String(error.message ?? error)}` };
  }
  if (!existsSync(entry)) return { ...result, status: 'unresolvable', detail: `entry not found: ${entry}` };

  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (error) {
    return { ...result, status: 'import-failed', detail: String(error.message ?? error).split('\n')[0] };
  }
  const Config = mod.Config ?? mod.default?.Config;
  if (row.config === undefined) return { ...result, status: 'ok', detail: 'no config' };
  if (typeof Config !== 'function') {
    return { ...result, status: 'ok', detail: 'package exports no Config schema (config passed through unvalidated)' };
  }
  try {
    Config(row.config);
    return { ...result, status: 'ok' };
  } catch (error) {
    return { ...result, status: 'config-invalid', detail: String(error.message ?? error).split('\n')[0] };
  }
}

/** Rows, in composition order, with nested group children flattened inline. */
function orderedRows(rows) {
  const out = [];
  const walk = (list) => {
    for (const row of list) {
      if (row && row.group === true && Array.isArray(row.config)) {
        out.push(row);
        walk(row.config);
        continue;
      }
      out.push(row);
    }
  };
  walk(rows);
  return out;
}

/**
 * Rows this preset is ALLOWED to differ from the shipped `standard` on: the
 * plugin row it exists to add. Everything else must match upstream, because a
 * preset mounts DSH's own packages and an upstream drift (a renamed provider,
 * a config contract change) kills the whole preset at mount.
 */
const ALLOWED_EXTRA_ROWS = new Set(['tool-molbio']);
/** Rows upstream ships ENABLED that this preset intentionally disables. */
const ALLOWED_DISABLED_ROWS = new Set();

/**
 * A preset description claims how many tools it brings. When the toolset grows
 * and the claim does not, users read a wrong number in the mode picker and
 * nothing fails: v19 shipped 57 tools while `preset.yml` still said 52.
 *
 * Returns one message per number in `description` that does NOT equal
 * `registered` and is not explicitly attributed to something else. Descriptions
 * legitimately mention other counts (`90+ 限制酶`, `2–50 条序列`), so the parse
 * is deliberately narrow: it looks for a number directly followed by the
 * Chinese counter `个` and `molbio_*` (the exact v19 phrasing), and for an
 * English `<n> tools` form.
 *
 * @param {string} description - the preset.yml description text.
 * @param {number} registered - how many molbio_* tools the plugin registers.
 * @returns {string[]} drift messages, empty when every claim matches.
 */
function toolCountDrift(description, registered) {
  const drift = [];
  const claims = [];
  for (const match of String(description).matchAll(/(\d+)\s*个\s*molbio_\*/g)) claims.push(match[1]);
  for (const match of String(description).matchAll(/(\d+)\s+tools\b/gi)) claims.push(match[1]);
  for (const claim of claims) {
    if (Number(claim) !== registered) {
      drift.push(`the description claims ${claim} tools but the plugin registers ${registered}`);
    }
  }
  return drift;
}

/**
 * Structural drift against the shipped `standard` preset, row by row and in
 * order. Comparing ids alone (the v15–v17 behaviour) misses exactly the two
 * defects that reached a release: a provider package the harness does not
 * install (`workflow-worker-thread`) and an upstream `disabled: true` that had
 * been dropped (`tool-ralph`).
 */
function compositionDrift(standardRows, mineRows) {
  const drift = [];
  const mineById = new Map();
  for (const row of mineRows) if (row && typeof row.id === 'string') mineById.set(row.id, row);
  const standardById = new Map();
  for (const row of standardRows) if (row && typeof row.id === 'string') standardById.set(row.id, row);

  // 1. missing / extra rows, in upstream order.
  const standardIds = new Set(standardById.keys());
  const mineIds = new Set(mineById.keys());
  for (const id of standardIds) if (!mineIds.has(id)) drift.push(`missing row "${id}" (shipped standard has it)`);
  for (const id of mineIds) {
    if (!standardIds.has(id) && !ALLOWED_EXTRA_ROWS.has(id)) drift.push(`extra row "${id}" (not in shipped standard)`);
  }

  // 2. the rows that exist on both sides must be the same row.
  for (const [id, mine] of mineById) {
    const standard = standardById.get(id);
    if (standard === undefined) continue;
    const differences = [];
    if (mine.name !== standard.name) differences.push(`name "${standard.name}" -> "${mine.name}"`);
    if (Boolean(mine.disabled) !== Boolean(standard.disabled)) {
      if (Boolean(standard.disabled)) differences.push('upstream ships it disabled and this preset enables it');
      else if (ALLOWED_DISABLED_ROWS.has(id)) differences.push('disabled here (documented deviation)');
      else differences.push('this preset disables a row upstream ships enabled');
    }
    if (JSON.stringify(mine.isolate ?? null) !== JSON.stringify(standard.isolate ?? null)) differences.push('isolate realm differs');
    if (JSON.stringify(mine.config ?? null) !== JSON.stringify(standard.config ?? null)) differences.push('config differs');
    for (const difference of differences) drift.push(`row "${id}": ${difference}`);
  }

  // 3. the rows that exist on both sides must appear in the same order, so the
  // file stays a copy of upstream plus one trailing row.
  const myOrder = mineRows
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string' && standardIds.has(id));
  const standardOrder = standardRows
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string' && mineIds.has(id));
  for (let index = 0; index < Math.min(myOrder.length, standardOrder.length); index += 1) {
    if (myOrder[index] !== standardOrder[index]) {
      drift.push(`row order: position ${index + 1} is "${myOrder[index]}" here and "${standardOrder[index]}" in the shipped standard`);
      break;
    }
  }
  return drift;
}

async function main() {
  // Strict argv: an unrecognised flag or a stray value is an error rather than
  // a silently ignored path. PowerShell can rewrite `--dsh <path>` into a
  // named parameter (`$dsh`), so a harness root that arrives as a positionals
  // candidate must NOT be mistaken for the composition — otherwise the check
  // happily validates a DIFFERENT composition and reports OK.
  const argv = process.argv.slice(2);
  let explicitHarness;
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dsh') {
      explicitHarness = argv[index + 1];
      if (explicitHarness === undefined || explicitHarness.startsWith('--')) {
        console.error('preset-health: --dsh needs a harness root path');
        process.exit(2);
      }
      index += 1;
      continue;
    }
    if (value === '--help' || value === '-h') {
      console.log('usage: node test/preset-health.mjs [composition.yml] [--dsh <harness root>]');
      process.exit(0);
    }
    if (value.startsWith('--')) {
      console.error(`preset-health: unknown option ${value} (usage: node test/preset-health.mjs [composition.yml] [--dsh <harness root>])`);
      process.exit(2);
    }
    positionals.push(value);
  }
  // A composition is a YAML file; anything else positional is a mistake (a
  // harness root, a preset id) and is refused loudly.
  const candidate = positionals.find((value) => /\.(ya?ml)$/i.test(value));
  const stray = positionals.find((value) => !/\.(ya?ml)$/i.test(value));
  if (stray !== undefined) {
    console.error(`preset-health: "${stray}" is not a composition file (.yml/.yaml) — did you mean --dsh "${stray}"?`);
    process.exit(2);
  }
  const composition = resolve(candidate ?? join(repoRoot, 'preset', 'molbio-lab', 'agent.cordis.yml'));
  if (!existsSync(composition)) {
    console.error(`preset-health: no composition at ${composition}`);
    process.exit(2);
  }

  const harnessRoot = findHarnessRoot(explicitHarness);
  if (harnessRoot === undefined) {
    console.error('preset-health: could not locate an installed DSH harness (pass --dsh <root>)');
    process.exit(2);
  }
  const packages = packagesDir(harnessRoot);
  const version = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')).version;
  console.log(`harness : ${harnessRoot} (dsh ${version})`);
  console.log(`composition: ${composition}`);

  const rows = flattenRows(await readComposition(composition, harnessRoot));
  console.log(`rows    : ${rows.length}\n`);

  const failures = [];
  for (const row of rows) {
    const result = await checkRow(row, packages, harnessRoot, dirname(composition));
    const mark = result.status === 'ok' ? 'ok  ' : result.status === 'disabled' || result.status === 'skipped' ? '--  ' : 'FAIL';
    const suffix = result.detail && result.status !== 'ok' ? `  (${result.detail})` : result.status === 'ok' && result.detail ? `  (${result.detail})` : '';
    console.log(`  ${mark} ${result.id}${suffix}`);
    if (result.status !== 'ok' && result.status !== 'disabled' && result.status !== 'skipped') failures.push(result);
  }

  // Drift against the shipped `standard` preset this one is derived from. The
  // preset's own charter is "the standard coding agent + the molbio tools", so
  // anything but the tool-molbio row (and the allowed deviations above) is a
  // divergence to report — and a FAILURE, not a note: the v17 release shipped
  // an unmountable provider row while this check printed a drift NOTE and the
  // suite reported success.
  const standardPath = join(packages, 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml');
  const drift = [];
  if (existsSync(standardPath) && resolve(standardPath) !== composition) {
    drift.push(...compositionDrift(
      orderedRows(await readComposition(standardPath, harnessRoot)),
      orderedRows(await readComposition(composition, harnessRoot)),
    ));
  }

  console.log('');
  if (drift.length > 0) {
    console.error('drift vs shipped standard preset:');
    for (const line of drift) console.error(`  FAIL ${line}`);
    console.error('');
    console.error('  Absorb upstream changes verbatim (comments and key order included) so this');
    console.error('  composition stays `standard` + one trailing tool-molbio row; see the');
    console.error('  "How this file is maintained" header in preset/molbio-lab/agent.cordis.yml.');
  }

  // An unmanaged directory that no `.gitignore` entry covers ships with the repo.
  const strays = [];
  const pluginsDir = join(dirname(composition), 'plugins');
  if (existsSync(pluginsDir)) {
    for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) strays.push(entry.name);
    }
  }
  if (strays.length > 0) console.log(`version directories present: ${strays.join(', ')}\n`);

  // The version directory the composition points at must MIRROR the package
  // root module-for-module. The preset travels with the plugin, so a row that
  // names vN while vN still holds the previous release's file is a silent
  // "upgrade that changed nothing" — the exact failure the module-cache rule in
  // the composition header exists to prevent, and one that no mount check can
  // see (the old module mounts perfectly).
  const mirrorDrift = [];
  const activeMatch = /name:\s*'\.\/plugins\/([^/']+)\//.exec(await readFile(composition, 'utf8'));
  if (activeMatch !== null) {
    const versionDir = join(pluginsDir, activeMatch[1]);
    const packageRoot = join(dirname(resolve(composition)), '..', '..');
    if (!existsSync(versionDir)) {
      mirrorDrift.push(`the composition points at ${activeMatch[1]}, which does not exist`);
    } else {
      const shipped = (await readdir(versionDir)).filter((name) => name.endsWith('.mjs')).sort();
      for (const name of shipped) {
        const rootFile = join(packageRoot, name);
        if (!existsSync(rootFile)) {
          mirrorDrift.push(`${activeMatch[1]}/${name} has no counterpart at the package root`);
          continue;
        }
        const [inPreset, inRoot] = await Promise.all([readFile(join(versionDir, name)), readFile(rootFile)]);
        if (!inPreset.equals(inRoot)) mirrorDrift.push(`${activeMatch[1]}/${name} differs from ${name} at the package root`);
      }
      const missing = (await readdir(packageRoot))
        .filter((name) => name.endsWith('.mjs'))
        .filter((name) => !shipped.includes(name));
      for (const name of missing) mirrorDrift.push(`${name} exists at the package root but is missing from ${activeMatch[1]}`);
    }
  }
  if (mirrorDrift.length > 0) {
    console.error('mirror check (the preset version directory vs the package root):');
    for (const line of mirrorDrift) console.error(`  FAIL ${line}`);
    console.error('');
    console.error('  Copy the current modules into the version directory the composition names —');
    console.error('  never edit a released directory in place (see the module-cache rule in the');
    console.error('  composition header).');
  }

  // The preset's own user-facing DESCRIPTION quotes a tool count, and v19 bumped
  // the toolset from 52 to 57 without updating it: the number a user reads in the
  // mode picker was wrong for a whole release, and nothing failed. A claim about
  // the toolset is a claim this suite can check, so it does — against the count
  // the plugin actually registers.
  const countDrift = [];
  const presetYml = join(dirname(composition), 'preset.yml');
  // Count the tools the PRESET actually loads (its version directory's entry
  // module), not the package root: the mirror check above proves the two are
  // byte-identical, and this is the copy the composition names.
  const pluginEntry = activeMatch === null ? undefined : join(pluginsDir, activeMatch[1], 'index.mjs');
  if (existsSync(presetYml) && pluginEntry !== undefined && existsSync(pluginEntry)) {
    const description = /^\s*description:\s*(.+)$/m.exec(await readFile(presetYml, 'utf8'))?.[1] ?? '';
    const registered = (await readFile(pluginEntry, 'utf8')).match(/name:\s*'molbio_[a-z0-9_]+'/g)?.length ?? 0;
    countDrift.push(...toolCountDrift(description, registered));
  }
  if (countDrift.length > 0) {
    console.error('tool-count check (preset.yml description vs the registered tools):');
    for (const line of countDrift) console.error(`  FAIL ${line}`);
    console.error('');
  }

  if (failures.length > 0 || drift.length > 0 || mirrorDrift.length > 0 || countDrift.length > 0) {
    if (failures.length > 0) {
      console.error(`preset-health FAILED: ${failures.length} row(s) cannot mount on dsh ${version}`);
      for (const failure of failures) console.error(`  - ${failure.id} [${failure.status}]: ${failure.detail}`);
    }
    if (drift.length > 0) {
      console.error(`preset-health FAILED: ${drift.length} structural drift(s) from the shipped standard preset`);
    }
    if (mirrorDrift.length > 0) {
      console.error(`preset-health FAILED: ${mirrorDrift.length} file(s) in the active preset version directory are not the current sources`);
    }
    if (countDrift.length > 0) {
      console.error(`preset-health FAILED: ${countDrift.length} tool-count claim(s) in preset.yml do not match the registered tools`);
    }
    process.exit(1);
  }
  console.log(`preset-health OK: all ${rows.length} rows load on dsh ${version}, and the composition is the shipped standard plus tool-molbio`);
  console.log(`mirror OK: ${activeMatch?.[1] ?? 'no version directory'} matches the package root module-for-module`);
}

// `compositionDrift` is exported for `test/drift-probe.mjs`, which drives it
// against deliberately mutated compositions: the two defects this guard exists
// for (a phantom provider row, a dropped upstream `disabled`) must FAIL, and a
// guard nobody has seen fail is not a guard. `import.meta.main` (Node >= 22)
// keeps `node test/preset-health.mjs` behaving exactly as before.
if (import.meta.main) await main();

export { compositionDrift, toolCountDrift };
