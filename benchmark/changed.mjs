/**
 * dsh-molbio-tools/benchmark/changed.mjs
 *
 * "I changed these files — which benchmark tasks must re-run?"
 *
 * ── The design goal is AVOIDING FALSE NEGATIVES ─────────────────────────────
 *
 * This module exists so a change can run LESS than the whole suite, which makes
 * every judgement it makes a potential silent gap: a wrong answer here means a
 * broken tool ships because its benchmark was skipped. The whole design therefore
 * leans the other way, and every uncertain case falls back to the FULL suite with
 * the reason printed.
 *
 * ── Why the map needs a dependency graph ────────────────────────────────────
 *
 * Parsing `index.mjs` alone gives a tempting but wrong answer: it says
 * `molbio_plot` lives in `papers.mjs` (because `execute`'s first imported call
 * there is `workspaceFilePath`) and that 26 tools live in `lib.mjs`. Both are
 * consequences of a helper module being imported by feature modules — a real
 * dependency, but not the tool's IMPLEMENTATION.
 *
 * Measured, not guessed: 26 of the 57 tools call bindings from more than one
 * module. So a per-file → tool map is not a partition, it is a graph, and the
 * honest model is:
 *
 *     changed file → the module(s) it belongs to
 *                  → every module that transitively depends on them
 *                  → every tool those modules implement
 *                  → every task covering those tools
 *
 * `lib.mjs` comes out of that as what it is: a dependency of almost everything,
 * so a change there legitimately selects nearly the whole suite. That is the
 * correct answer, and it is printed as such rather than hardcoded as a special
 * case.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Paths whose changes cannot affect tool behaviour, so they never force a run.
 *
 * Kept deliberately SMALL and specific. A path that is not listed here is
 * treated as possibly-relevant, and an unmapped one forces a full run — so
 * forgetting to list something costs time, never coverage.
 */
const INERT_PREFIXES = ['benchmark/', 'docs/', 'test/'];
const INERT_FILES = new Set(['.gitignore', 'CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json']);

/**
 * Files changed in the working tree, as repo-relative POSIX paths.
 *
 * `git diff --name-only HEAD` catches staged and unstaged edits; untracked files
 * are added because a brand-new module is exactly the case that must not be
 * missed. Any git failure (no git, no HEAD, a tarball checkout) returns
 * `undefined`, which callers treat as "cannot tell" — never as "nothing
 * changed".
 *
 * @param {string} [repoRoot] the checkout root.
 * @returns {string[]|undefined} relative paths, or undefined when undeterminable.
 */
export function changedFiles(repoRoot = REPO_ROOT) {
  const run = (args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const lines = (text) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    const tracked = lines(run(['diff', '--name-only', 'HEAD']));
    const untracked = lines(run(['ls-files', '--others', '--exclude-standard']));
    return [...new Set([...tracked, ...untracked])].map((path) => path.split(sep).join('/')).sort();
  } catch {
    return undefined;
  }
}

/** Split an import clause's `a, b as c` list into the LOCAL binding names. */
function bindingsOf(clause) {
  return clause
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/).pop().trim())
    .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
}

/** The slice of `index.mjs` belonging to one tool: its `define({...})` block. */
function toolBlocks(source) {
  const spans = [];
  const re = /name:\s*'(molbio_[a-z_]+)'/g;
  let match;
  while ((match = re.exec(source))) spans.push({ name: match[1], at: match.index });
  return spans.map((span, index) => ({
    name: span.name,
    body: source.slice(span.at, index + 1 < spans.length ? spans[index + 1].at : source.length),
  }));
}

/**
 * Read the plugin's structure out of `index.mjs` — statically, and verifiably.
 *
 * @param {string} [path] the plugin entry.
 * @returns {{moduleOf: Map<string, string>, toolModules: Map<string, string[]>, toolBindings: Map<string, string[]>}|undefined}
 */
export function readPluginMap(path = resolve(REPO_ROOT, 'index.mjs')) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  // Local import bindings: `import { a, b } from './c.mjs'` — multi-line safe.
  const bindings = new Map();
  const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*'(\.\/[^']+)'/g;
  let match;
  while ((match = importRe.exec(source))) {
    const module = match[2].replace('./', '');
    for (const name of bindingsOf(match[1])) bindings.set(name, module);
  }
  if (bindings.size === 0) return undefined;

  const moduleOf = new Map();
  const toolModules = new Map();
  const toolBindings = new Map();
  for (const { name, body } of toolBlocks(source)) {
    // Only what `execute` calls. `execute` is the tool's whole behaviour; the
    // rest of the block is description strings and schema, whose prose contains
    // words like `sequence (` that would otherwise look like calls.
    const execute = /execute\s*\([^)]*\)\s*\{/.exec(body);
    const called = [];
    if (execute !== undefined) {
      const after = body.slice(execute.index + execute[0].length);
      const callRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
      let call;
      while ((call = callRe.exec(after))) {
        if (bindings.has(call[1])) called.push(call[1]);
      }
    }
    const modules = [...new Set(called.map((name) => bindings.get(name)))];
    toolModules.set(name, modules);
    toolBindings.set(name, [...new Set(called)]);
    for (const module of modules) if (!moduleOf.has(module)) moduleOf.set(module, module);
  }
  if (toolModules.size === 0) return undefined;
  return { moduleOf, toolModules, toolBindings };
}

/**
 * The module → its local imports, read from the modules themselves.
 *
 * Built by reading each module's own import statements (not by executing it), so
 * it works without side effects and covers a module that no tool uses yet.
 *
 * @param {string[]} modules repo-relative module paths.
 * @returns {Map<string, string[]>} module → direct local dependencies.
 */
export function readModuleGraph(modules) {
  const graph = new Map();
  for (const module of modules) {
    let source;
    try {
      source = readFileSync(resolve(REPO_ROOT, module), 'utf8');
    } catch {
      graph.set(module, []);
      continue;
    }
    const deps = new Set();
    // Both `import ... from './x.mjs'` and a bare `import './x.mjs'`.
    const re = /from\s*'(\.\.?\/[^']+)'|import\s*'(\.\.?\/[^']+)'/g;
    let match;
    while ((match = re.exec(source))) {
      const spec = match[1] ?? match[2];
      deps.add(relative(REPO_ROOT, resolve(dirname(resolve(REPO_ROOT, module)), spec)).split(sep).join('/'));
    }
    graph.set(module, [...deps]);
  }
  return graph;
}

/**
 * Every module that transitively depends on `roots`, including the roots.
 *
 * @param {string[]} roots changed modules.
 * @param {Map<string, string[]>} graph module → direct local dependencies.
 * @returns {Set<string>} the affected modules.
 */
export function dependents(roots, graph) {
  const affected = new Set(roots);
  // Reverse edges: dependency -> the modules that import it (directly or not).
  const importers = new Map();
  for (const [module, deps] of graph) {
    for (const dep of deps) {
      if (!importers.has(dep)) importers.set(dep, []);
      importers.get(dep).push(module);
    }
  }
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const importer of importers.get(current) ?? []) {
      if (affected.has(importer)) continue; // visited
      affected.add(importer);
      queue.push(importer);
    }
  }
  return affected;
}

/**
 * Resolve `--changed` into a decision the runner can act on.
 *
 * Three outcomes, and the distinction between the last two matters:
 *
 *   `partial`  the changed modules affect a strict subset of the suite
 *   `full`     cannot be shown to affect a subset — run everything
 *   `none`     the change provably cannot affect tool behaviour (docs, the
 *              changelog, the benchmark's own files, a test suite)
 *
 * `none` must not decay into `full`. A documentation commit that silently
 * triggers 49 model calls is how a `--changed` default gets switched off and the
 * full suite goes back to running every time — the exact behaviour this module
 * exists to stop. The suffix runs only when `--changed` is given, so everything
 * unlisted still fails safe.
 *
 * @param {{tasks: object[], files: string[]|undefined}} options
 * @returns {{mode: 'full'|'partial'|'none', files: string[], reason: string, tasks?: object[], tools?: string[], modules?: string[], inert?: string[]}}
 */
export function resolveChanged(options) {
  const { tasks, files } = options;
  if (files === undefined) {
    return { mode: 'full', files: [], reason: 'could not determine the changed files (no git, or no HEAD)' };
  }
  if (files.length === 0) {
    return { mode: 'none', files: [], reason: 'the working tree has no uncommitted changes' };
  }

  const inert = files.filter((path) => INERT_FILES.has(path) || INERT_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const relevant = files.filter((path) => !inert.includes(path));
  if (relevant.length === 0) {
    return {
      mode: 'none',
      files,
      inert,
      reason: `${files.length} changed file(s) are all non-functional (docs, benchmark or test sources, config)`,
    };
  }

  const plugin = readPluginMap();
  if (plugin === undefined) {
    return { mode: 'full', files, reason: 'the plugin structure could not be read from index.mjs' };
  }

  // The module set is every `.mjs` in the package root, not just the ones that
  // contribute tools. `svgio.mjs` is the reason: no tool calls a `svgio` binding
  // directly, but `composition.mjs`, `fastq-qc.mjs` and `phylo.mjs` import it, so
  // it is a real dependency module that a tool-contribution scan cannot see.
  const modules = packageModules();
  const unknown = relevant.filter((path) => !modules.has(path) && path !== 'index.mjs');
  if (unknown.length > 0) {
    const testOnly = unknown.every((path) => path.startsWith('test/') || path.startsWith('benchmark/') || path.startsWith('docs/'));
    return {
      mode: 'full',
      files,
      reason: testOnly
        ? `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not plugin modules but also not inert — running everything`
        : `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the plugin's module set (new or unrecognised) — running everything`,
    };
  }
  if (relevant.includes('index.mjs')) {
    return { mode: 'full', files, reason: 'index.mjs is the entry that binds every tool — running everything' };
  }

  // `dependents` walks IMPORTERS, so it answers "who is affected by a change
  // here". The graph must therefore contain every module as a key — including
  // the entry and including dependency-only modules like `svgio.mjs`, which no
  // tool calls directly but three feature modules import.
  const graph = readModuleGraph([...modules, 'index.mjs']);
  const affected = dependents(relevant, graph);

  // A tool is selected if ANY module it uses is affected — not just its
  // implementation. That is deliberately over-approximate, and it is also what
  // makes attribution mistakes harmless: whether `molbio_plot` is "in"
  // `plot.mjs` or `papers.mjs` (it calls into both), a change to either selects
  // it. Twenty-six of the fifty-seven tools span more than one module, so a
  // single "owning module" would be a fiction anyway.
  const affectedModules = new Set(affected);
  const tools = [...plugin.toolModules.entries()]
    .filter(([, toolModuleList]) => toolModuleList.some((module) => affectedModules.has(module)))
    .map(([tool]) => tool)
    .sort();

  const covered = new Set(tasks.flatMap((task) => task.covers));
  const uncovered = tools.filter((tool) => !covered.has(tool));
  if (tools.length === 0) {
    return { mode: 'full', files, reason: 'no tool is implemented in the changed module(s) — running everything rather than nothing' };
  }
  if (uncovered.length > 0) {
    return {
      mode: 'full',
      files,
      reason: `${uncovered.join(', ')} ${uncovered.length === 1 ? 'has' : 'have'} no benchmark task — running everything`,
    };
  }

  const selected = tasks.filter((task) => task.covers.some((tool) => tools.includes(tool)));
  if (selected.length === 0) {
    return { mode: 'full', files, reason: 'the affected tools select no task — running everything' };
  }
  return { mode: 'partial', files, inert, reason: '', tools, modules: [...affected].sort(), tasks: selected };
}

/**
 * Every `.mjs` in the package root: the plugin's own module set.
 *
 * A directory read rather than the import graph, because the two differ: a
 * module can be a dependency without any tool calling it directly, and a NEW
 * module added to the graph must be recognised rather than reported as unknown.
 *
 * @returns {Set<string>} repo-relative module paths.
 */
function packageModules() {
  const modules = new Set();
  let entries;
  try {
    entries = readdirSync(REPO_ROOT, { withFileTypes: true });
  } catch {
    return modules;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) modules.add(entry.name);
  }
  return modules;
}

/**
 * Persist the measured map, so a decision can be inspected without re-deriving it.
 *
 * @param {string} path destination.
 * @param {object} map the value from {@link resolveChanged} plus its inputs.
 * @returns {Promise<void>}
 */
export async function writeSnapshot(path, map) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}
