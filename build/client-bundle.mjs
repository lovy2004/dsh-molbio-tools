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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** The bundle's `id` must be the exact package name — the loader keys on it. */
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const PACKAGE_NAME = manifest.name;

/** Entry module: the panel's apply/inject face. */
const ENTRY = join(here, 'client-entry.mjs');
/** Output: what `exports["./client"]` points at. */
const OUTPUT = join(packageRoot, 'lib', 'client.js');

/** Modules resolved by the host shell or by other graph rows instead of us. */
const EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
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
const parts = [];
parts.push('// Generated by build/client-bundle.mjs — do not edit by hand.');
parts.push('// Source of truth: the root .mjs modules and build/client-*.mjs; rerun `node build/client-bundle.mjs`.');
parts.push('window.__ModuleLoader__.load({');
parts.push(`\tid: ${JSON.stringify(PACKAGE_NAME)},`);
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
  const source = await readFile(path, 'utf8');
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

const bundle = parts.join('\n');
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, bundle, 'utf8');

const modulesInBundle = order.length;
console.log(`client bundle written: ${OUTPUT.replace(packageRoot, '.')} (${(bundle.length / 1024).toFixed(1)} KB)`);
console.log(`  package id : ${PACKAGE_NAME}`);
console.log(`  modules    : ${modulesInBundle} (${order.map((p) => moduleId(p)).join(', ')})`);
console.log(`  externals  : ${[...externalSpecifiers].join(', ') || '(none)'}`);
