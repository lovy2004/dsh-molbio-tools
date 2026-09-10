/**
 * dsh-molbio-tools/build/client-bundle.mjs
 *
 * Build the browser half of this package: the molbio computation modules plus
 * the panel components, emitted as the lazy-CJS bundle format the DSH Web
 * client's module loader expects.
 *
 * Why a hand-written bundler
 * --------------------------
 * The official shared bundler preset for client packages (`tsdown.client.ts`
 * inside the DSH monorepo) is NOT published to npm, and the official docs say a
 * third-party package has to reproduce its output format itself. That format is
 * small and fully specified by the loader:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<exact package name>",
 *     factory: (require) => { ... var module = {exports:{}}; ... return module.exports; }
 *   });
 *
 * Executing the file must only REGISTER that factory — every side effect,
 * including CSS injection, has to live inside it, because materialization (and
 * therefore module order) is the loader's business. `require` resolves against
 * the platform seed (react and friends, provided by the shell) and against the
 * other packages named in `dsh.client.inject`/`external`.
 *
 * The source modules here are plain ESM with only relative `.mjs` imports and
 * named exports — no dynamic import, no re-export, no default export. That is a
 * deliberately narrow contract (asserted below) that a ~200 line bundler can
 * lower correctly, and it keeps the browser bundle single-sourced from the same
 * files the Node plugin ships: there is no second copy to drift.
 *
 * Usage: node build/client-bundle.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/**
 * The bundles to emit. The SAME browser half ships through two channels:
 *
 * - `dsh-molbio-tools` — the plugin package: one install gives the 46 tools
 *   plus the panel (its host half also registers the tools).
 * - `dsh-molbio-panel` — a panel-only package: installing it adds the tab to a
 *   profile WITHOUT dragging the tools into every session of that profile,
 *   which is what a shared Web profile wants.
 *
 * Both artifacts are built from the same sources in one run, so they cannot
 * drift; only the registration `id` (the package name the loader keys on) and
 * the output path differ.
 */
const TARGETS = [
  { packageRoot, label: 'tools + panel' },
  { packageRoot: join(packageRoot, 'packages', 'molbio-panel'), label: 'panel only' },
];

/** Entry module: the panel's apply/inject face. */
const ENTRY = join(here, 'client-entry.mjs');

// ── parse once: the module graph is identical for every target ──────────────

/** Modules resolved by the host shell or by other graph rows instead of us. */
const EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$/gm;
// The `async` modifier is part of the captured prefix, so lowering
// `export async function f` keeps `async` (dropping it would produce a factory
// body that calls `await` outside an async function).
const EXPORT_DECL_RE = /^export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;\s*$/gm;
/** `export { a, b as c } from './mod.mjs';` — a re-export, not a local list. */
const REEXPORT_RE = /^export\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$/gm;

/** `a`, `a as b` → { imported, local }. */
function parseNames(list, path) {
  const out = [];
  for (const entry of list.split(',').map((item) => item.trim()).filter((item) => item !== '')) {
    const alias = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(entry);
    if (alias === null) throw new Error(`${path}: unsupported binding ${JSON.stringify(entry)}`);
    out.push({ imported: alias[1], local: alias[2] ?? alias[1] });
  }
  return out;
}

/** Parse one module: its dependencies (imports + re-exports) and exported names. */
function parseModule(source, path) {
  // Re-exports are dependencies too: the target must land in the bundle, and
  // the exported name is assigned from the target's namespace, not locally.
  const reexports = [];
  for (const match of source.matchAll(REEXPORT_RE)) {
    for (const name of parseNames(match[1], path)) reexports.push({ ...name, specifier: match[2] });
  }
  const imports = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifiers = parseNames(match[1], path);
    imports.push({ specifiers, specifier: match[2] });
  }
  if (/^import\s+(?!\{)/m.test(source)) throw new Error(`${path}: only named imports are supported`);
  if (/^export\s+(default|\*)/m.test(source)) throw new Error(`${path}: default and star exports are not supported`);
  if (/\bimport\s*\(/.test(source)) throw new Error(`${path}: dynamic import() is not supported in the browser bundle`);

  const exports = [];
  for (const match of source.matchAll(EXPORT_DECL_RE)) exports.push({ local: match[2], source: null });
  const declared = (source.match(EXPORT_DECL_RE) ?? []).length;
  for (const match of source.matchAll(EXPORT_LIST_RE)) {
    for (const name of parseNames(match[1], path)) exports.push({ local: name.local, source: null });
  }
  for (const name of reexports) exports.push({ local: name.local, source: name.specifier });
  const listCount = (source.match(EXPORT_LIST_RE) ?? []).length;
  const reexportCount = (source.match(REEXPORT_RE) ?? []).length;
  const keywordCount = (source.match(/^export\s/gm) ?? []).length;
  if (declared + listCount + reexportCount !== keywordCount) {
    throw new Error(`${path}: found ${keywordCount} "export" keyword(s) but understood ${declared + listCount + reexportCount}; the bundler lowers declaration exports, export lists and re-exports`);
  }
  return { imports, reexports, exports };
}

/** Depth-first module graph: dependency factories must register before consumers. */
async function collect(entry) {
  const modules = new Map();
  const order = [];
  const visit = async (path, stack) => {
    if (modules.has(path)) return;
    if (stack.includes(path)) throw new Error(`import cycle: ${[...stack, path].map((p) => p.replace(packageRoot, '.')).join(' -> ')}`);
    const source = await readFile(path, 'utf8');
    const parsed = parseModule(source, path.replace(packageRoot, '.'));
    for (const entry of [...parsed.imports, ...parsed.reexports]) {
      if (EXTERNALS.has(entry.specifier)) continue;
      if (entry.specifier.startsWith('node:')) {
        throw new Error(`${path.replace(packageRoot, '.')} imports ${entry.specifier}; the browser bundle must stay Node-free`);
      }
      if (!entry.specifier.startsWith('.')) {
        throw new Error(`${path.replace(packageRoot, '.')} imports the bare specifier ${entry.specifier}; only relative modules and the platform externals (${[...EXTERNALS].join(', ')}) are allowed`);
      }
      await visit(resolve(dirname(path), entry.specifier), [...stack, path]);
    }
    modules.set(path, parsed);
    order.push(path);
  };
  await visit(entry, []);
  return { modules, order };
}

/** Lower one module to a CJS factory body. */
function lower(path, source, modulePaths, externalBindings) {
  let body = source;
  // `export function f` -> `function f`, collected into the exports object.
  body = body.replace(EXPORT_DECL_RE, '$1 $2');
  // A trailing `export { a, b };` list carries no code of its own, and a
  // re-export's names come from another module: both statements go away here
  // and their names are assigned into `exports` by the generator.
  body = body.replace(EXPORT_LIST_RE, '');
  body = body.replace(REEXPORT_RE, '');
  // Imports become destructuring from the dependency factory — or from the
  // hoisted external binding when the specifier is a platform module.
  body = body.replace(IMPORT_RE, (whole, names, specifier) => {
    const list = names.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    const pattern = list
      .map((entry) => {
        const alias = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(entry);
        return alias[2] === undefined ? alias[1] : `${alias[1]}: ${alias[2]}`;
      })
      .join(', ');
    if (EXTERNALS.has(specifier)) return `const { ${pattern} } = ${externalBindings.get(specifier)};`;
    const target = resolve(dirname(path), specifier);
    const id = modulePaths.get(target);
    if (id === undefined) throw new Error(`${path}: unresolvable import ${specifier}`);
    return `const { ${pattern} } = __molbio_require(${JSON.stringify(id)});`;
  });
  return body;
}

function moduleId(path) {
  return path.slice(packageRoot.length + 1).split('\\').join('/');
}

const { modules, order } = await collect(ENTRY);

// Assign stable ids and rewrite externals to the loader's own require.
const modulePaths = new Map(order.map((path) => [path, moduleId(path)]));

/** Build the artifact text for one target: only the registration id differs. */
function renderBundle(packageName) {
  const parts = [];
  parts.push('// Generated by build/client-bundle.mjs — do not edit by hand.');
  parts.push('// Source of truth: the root .mjs modules and build/client-*.mjs; rerun `node build/client-bundle.mjs`.');
  parts.push('window.__ModuleLoader__.load({');
  parts.push(`\tid: ${JSON.stringify(packageName)},`);
  parts.push('\tfactory: (require) => {');
  parts.push('\t\tvar module = { exports: {} };');
  parts.push('\t\tvar exports = module.exports;');
  parts.push('\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });');
  parts.push('\t\tconst __molbio_modules = {};');
  parts.push('\t\tconst __molbio_cache = {};');
  parts.push('\t\tconst __molbio_require = (id) => {');
  parts.push('\t\t\tif (__molbio_cache[id] !== undefined) return __molbio_cache[id];');
  parts.push('\t\t\tconst factory = __molbio_modules[id];');
  parts.push('\t\t\tif (factory === undefined) throw new Error(`molbio client bundle: unknown internal module "${id}"`);');
  parts.push('\t\t\tconst value = factory();');
  parts.push('\t\t\t__molbio_cache[id] = value;');
  parts.push('\t\t\treturn value;');
  parts.push('\t\t};');
  // External requires are hoisted to factory top level: the loader's require is
  // synchronous, so an external must already be materialized when we ask.
  const externalSpecifiers = new Set();
  for (const path of order) {
    for (const entry of modules.get(path).imports) if (EXTERNALS.has(entry.specifier)) externalSpecifiers.add(entry.specifier);
  }
  const externalBindings = new Map();
  let externalIndex = 0;
  for (const specifier of externalSpecifiers) {
    const binding = `__ext${externalIndex++}`;
    externalBindings.set(specifier, binding);
    parts.push(`\t\tconst ${binding} = require(${JSON.stringify(specifier)});`);
  }
  for (const path of order) {
    const parsed = modules.get(path);
    const source = readFileSync(path, 'utf8');
    const body = lower(path, source, modulePaths, externalBindings);
    parts.push(`\t\t__molbio_modules[${JSON.stringify(moduleId(path))}] = () => {`);
    parts.push('\t\t\tconst exports = {};');
    parts.push(body.split('\n').map((line) => (line === '' ? '' : `\t\t\t${line}`)).join('\n'));
    for (const name of parsed.exports) {
      if (name.source === null) {
        parts.push(`\t\t\texports.${name.local} = ${name.local};`);
        continue;
      }
      // A re-export reads the target module's namespace by its exported name.
      const target = resolve(dirname(path), name.source);
      const id = modulePaths.get(target);
      if (id === undefined) throw new Error(`${path}: unresolvable re-export ${name.source}`);
      parts.push(`\t\t\texports.${name.local} = __molbio_require(${JSON.stringify(id)}).${name.imported};`);
    }
    parts.push('\t\t\treturn exports;');
    parts.push('\t\t};');
  }
  // The entry module's exports ARE the plugin's: apply/inject must be visible.
  const entryParsed = modules.get(ENTRY);
  parts.push(`\t\tconst __entry = __molbio_require(${JSON.stringify(moduleId(ENTRY))});`);
  for (const name of entryParsed.exports) parts.push(`\t\texports.${name.local} = __entry.${name.local};`);
  parts.push('\t\treturn module.exports;');
  parts.push('\t}');
  parts.push('});');
  parts.push('');
  return { text: parts.join('\n'), externalSpecifiers };
}

const written = [];
for (const target of TARGETS) {
  const manifest = JSON.parse(await readFile(join(target.packageRoot, 'package.json'), 'utf8'));
  const declaration = manifest.dsh?.client;
  if (declaration === undefined) {
    console.warn(`skipped ${manifest.name}: no dsh.client declaration (the row would never be scanned)`);
    continue;
  }
  const clientRel = typeof manifest.exports?.['./client'] === 'string'
    ? manifest.exports['./client']
    : manifest.exports?.['./client']?.default;
  if (typeof clientRel !== 'string') {
    console.warn(`skipped ${manifest.name}: no exports["./client"] string`);
    continue;
  }
  const output = join(target.packageRoot, clientRel);
  const { text, externalSpecifiers } = renderBundle(manifest.name);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text, 'utf8');
  written.push({ manifest, output, text, externalSpecifiers, label: target.label });
}

for (const { manifest, output, text, externalSpecifiers, label } of written) {
  console.log(`client bundle written: ${output.replace(packageRoot, '.')} (${(text.length / 1024).toFixed(1)} KB) — ${label}`);
  console.log(`  package id : ${manifest.name}`);
  console.log(`  externals  : ${[...externalSpecifiers].join(', ') || '(none)'}`);
}
console.log(`modules    : ${order.length} (${order.map((path) => moduleId(path)).join(', ')})`);
