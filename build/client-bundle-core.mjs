/**
 * dsh-molbio-tools/build/client-bundle-core.mjs
 *
 * The bundle GENERATOR, with no I/O policy of its own.
 *
 * `build/client-bundle.mjs` is the CLI: it reads each target's manifest and
 * writes the artifact. This module is the pure half — parse the module graph,
 * lower it, and render the artifact text for a package name — so the same code
 * can be called twice for two different purposes:
 *
 *   1. by the CLI, to build `lib/client.js` in both packages;
 *   2. by `test/contract.mjs`, to recompute the expected artifact IN PROCESS and
 *      compare it with the committed one.
 *
 * (2) is why this split exists. The staleness check used to run the CLI with
 * `spawnSync` and compare hashes; a confined sandbox refuses piped stdio with
 * EPERM, so the check could only refuse to run — a release gate that disappears
 * exactly where releases are automated. Importing the generator removes the
 * child process from the question entirely.
 *
 * The emitted text depends only on (a) the source modules reachable from the
 * entry and (b) the package name in `id:`. The SAME browser half ships through
 * two channels (`dsh-molbio-tools` with the tools, `dsh-molbio-panel` without),
 * which is why the registration id is a render parameter rather than a constant.
 *
 * The source modules are plain ESM with only relative `.mjs` imports and named
 * exports — no dynamic import, no re-export, no default export. That is a
 * deliberately narrow contract (asserted below) that a ~200 line generator can
 * lower correctly, and it keeps the browser bundle single-sourced from the same
 * files the Node plugin ships: there is no second copy to drift.
 */
import { readFile as readFileAsync } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Modules resolved by the host shell or by other graph rows instead of us. */
export const EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);

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
async function collect(entry, baseDir) {
  const modules = new Map();
  const order = [];
  const short = (path) => path.replace(baseDir, '.');
  const visit = async (path, stack) => {
    if (modules.has(path)) return;
    if (stack.includes(path)) throw new Error(`import cycle: ${[...stack, path].map(short).join(' -> ')}`);
    const source = await readFileAsync(path, 'utf8');
    const parsed = parseModule(source, short(path));
    for (const entry of [...parsed.imports, ...parsed.reexports]) {
      if (EXTERNALS.has(entry.specifier)) continue;
      if (entry.specifier.startsWith('node:')) {
        throw new Error(`${short(path)} imports ${entry.specifier}; the browser bundle must stay Node-free`);
      }
      if (!entry.specifier.startsWith('.')) {
        throw new Error(`${short(path)} imports the bare specifier ${entry.specifier}; only relative modules and the platform externals (${[...EXTERNALS].join(', ')}) are allowed`);
      }
      await visit(resolve(dirname(path), entry.specifier), [...stack, path]);
    }
    modules.set(path, parsed);
    order.push(path);
  };
  await visit(entry, []);
  return { modules, order };
}

/** `lib.mjs` — the module's id inside the bundle. */
function moduleId(path, baseDir) {
  return path.slice(baseDir.length + 1).split('\\').join('/');
}

/**
 * The generator. `entry` is the client entry module, `baseDir` the directory
 * module ids are relative to (the plugin package root, so BOTH targets emit the
 * same ids and differ only in the registration id).
 */
export async function createGenerator({ entry, baseDir }) {
  const { modules, order } = await collect(entry, baseDir);

  // Assign stable ids and rewrite externals to the loader's own require.
  const modulePaths = new Map(order.map((path) => [path, moduleId(path, baseDir)]));

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
      parts.push(`\t\t__molbio_modules[${JSON.stringify(moduleId(path, baseDir))}] = () => {`);
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
    const entryParsed = modules.get(entry);
    parts.push(`\t\tconst __entry = __molbio_require(${JSON.stringify(moduleId(entry, baseDir))});`);
    for (const name of entryParsed.exports) parts.push(`\t\texports.${name.local} = __entry.${name.local};`);
    parts.push('\t\treturn module.exports;');
    parts.push('\t}');
    parts.push('});');
    parts.push('');
    return { text: parts.join('\n'), externalSpecifiers };
  }

  return {
    order,
    /** Module ids in registration order, for diagnostics. */
    ids: order.map((path) => moduleId(path, baseDir)),
    renderBundle,
  };
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
