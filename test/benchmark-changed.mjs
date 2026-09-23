/**
 * dsh-molbio-tools/test/benchmark-changed.mjs
 *
 * Guard `--changed`: the feature whose failure mode is a SILENT GAP.
 *
 * `--changed` exists so a change can run less than the full suite. Every
 * judgement it makes is therefore a chance to skip the benchmark for a tool that
 * actually broke — and that failure is invisible, because a skipped test is
 * green. So the properties asserted here are the ones that keep it from lying:
 *
 *  1. **Every module maps to the tools that use it.** The map comes from parsing
 *     `index.mjs` plus the module import graph; the test checks it against the
 *     tool→module dependencies declared in the plugin's own imports, so a new
 *     module or a re-exported helper cannot fall out of the map unnoticed.
 *  2. **A dependency module is not invisible.** `svgio.mjs` is imported by three
 *     feature modules and by no tool directly; it must still select their tasks.
 *  3. **Uncertainty widens, never narrows.** An unknown file, an unmapped file,
 *     `index.mjs`, and "no git at all" must all fall back to the full suite.
 *  4. **`none` means the change provably cannot affect tool behaviour** — docs,
 *     changelog, the benchmark's own sources — and must NOT decay into a full
 *     run, which is how a `--changed` default gets switched off in practice.
 *  5. **`--tools` intersects with `--changed` and unions without it.** The two
 *     operators are the difference between testing what changed and testing
 *     less than that.
 *
 * It also checks the one property that makes all of the above meaningful: the
 * task suite covers every tool the map can select, so a partial run never has to
 * fall back for lack of a task.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { changedFiles, readModuleGraph, readPluginMap, dependents, resolveChanged } from '../benchmark/changed.mjs';
import { loadTasks } from '../benchmark/score.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const { tasks } = await loadTasks();

const plugin = readPluginMap();
assert.ok(plugin !== undefined, 'the plugin map must be readable from index.mjs');
assert.equal(plugin.toolModules.size, 57, 'every registered tool must be attributed to its modules');

// ── (1) every tool's modules are real files ─────────────────────────────────

for (const [tool, modules] of plugin.toolModules) {
  assert.ok(modules.length > 0, `${tool} resolved to no module — the parser missed its execute() body`);
  for (const module of modules) {
    assert.doesNotThrow(() => readFileSync(join(REPO_ROOT, module), 'utf8'), `${tool} names a missing module: ${module}`);
  }
}

// ── (2) the map agrees with the plugin's own import list ────────────────────

const declaredModules = new Set([...plugin.toolModules.values()].flat());
const source = readFileSync(join(REPO_ROOT, 'index.mjs'), 'utf8');
for (const match of source.matchAll(/from\s*'(\.\/[^']+)'/g)) {
  const module = match[1].replace('./', '');
  // A module `index.mjs` imports is either used by a tool's execute() or it is a
  // helper the plugin uses outside any single tool. The former must be in the
  // map; the latter is the case `readModuleGraph` covers via dependents.
  if (declaredModules.has(module)) continue;
  const graph = readModuleGraph([...declaredModules, 'index.mjs']);
  assert.ok(
    [...graph.values()].some((deps) => deps.includes(module)),
    `index.mjs imports ${module}, but no tool uses it and no module depends on it — the map would not see a change there`,
  );
}

// ── (3) a dependency-only module is still reachable ─────────────────────────

{
  // `svgio.mjs` reaches no tool's execute() directly. It must still select the
  // tasks of the modules that import it, or editing it would run nothing.
  const graph = readModuleGraph([...declaredModules, 'index.mjs']);
  const importers = [...graph.entries()].filter(([, deps]) => deps.includes('svgio.mjs')).map(([module]) => module);
  assert.ok(importers.length > 0, 'svgio.mjs must be imported by feature modules');
  const decision = resolveChanged({ tasks, files: ['svgio.mjs'] });
  assert.equal(decision.mode, 'partial', 'a change to a dependency-only module must select a subset, not everything');
  assert.ok(decision.tasks.length > 0, 'svgio.mjs must select at least one task');
  for (const importer of importers) {
    const affected = dependents([importer], graph);
    assert.ok(affected.has('svgio.mjs') === false, 'dependents must walk importers, not dependencies');
  }
}

// ── (4) narrow modules select a subset; broad ones do not pretend to ────────

{
  const narrow = resolveChanged({ tasks, files: ['methylation.mjs'] });
  assert.equal(narrow.mode, 'partial');
  assert.deepEqual(narrow.tasks.map((task) => task.id).sort(), ['double-digest-buffer', 'methylation-block']);

  const broad = resolveChanged({ tasks, files: ['lib.mjs'] });
  assert.equal(broad.mode, 'partial', 'lib.mjs is a dependency of nearly everything, which is still a subset');
  assert.ok(broad.tasks.length >= tasks.length - 2, `lib.mjs must select nearly every task (selected ${broad.tasks.length}/${tasks.length})`);

  const entry = resolveChanged({ tasks, files: ['index.mjs'] });
  assert.equal(entry.mode, 'full', 'index.mjs binds every tool, so it must force a full run');
}

// ── (5) uncertainty widens ──────────────────────────────────────────────────

{
  const unknown = resolveChanged({ tasks, files: ['brand-new-module.mjs'] });
  assert.equal(unknown.mode, 'full', 'an unrecognised file must force a full run');
  assert.match(unknown.reason, /not in the plugin's module set/);

  const undeterminable = resolveChanged({ tasks, files: undefined });
  assert.equal(undeterminable.mode, 'full', 'a failure to read git must force a full run');

  // The map must never select a task whose tools it cannot map — the coverage
  // guard on the task side is what makes a partial run complete.
  const covered = new Set(tasks.flatMap((task) => task.covers));
  for (const [tool] of plugin.toolModules) {
    const decision = resolveChanged({ tasks, files: [] });
    void decision;
    assert.ok(covered.has(tool), `${tool} has no benchmark task, so a partial run could skip it`);
  }
}

// ── (6) `none` is a real outcome and must not decay into `full` ─────────────

{
  for (const files of [['README.md'], ['CHANGELOG.md'], ['docs/workflow.md'], ['test/smoke.mjs'], ['benchmark/tasks/01-core.json']]) {
    const decision = resolveChanged({ tasks, files });
    assert.equal(decision.mode, 'none', `${files.join(', ')} cannot affect tool behaviour, so it must not trigger a run`);
  }
  const empty = resolveChanged({ tasks, files: [] });
  assert.equal(empty.mode, 'none', 'a clean working tree must report nothing to run, not everything');
}

// ── (7) the operators: intersect with --changed, union without ──────────────

{
  const { selectTasks } = await import('../benchmark/run.mjs');
  const crispr = selectTasks({ tasks, changed: true, files: ['crispr.mjs'], tier: 'core' });
  assert.equal(crispr.mode, 'partial');
  assert.deepEqual(crispr.tools, ['molbio_grna_design']);

  const intersected = selectTasks({ tasks, changed: true, files: ['crispr.mjs'], tools: 'grna_design', tier: 'core' });
  assert.deepEqual(intersected.tools, ['molbio_grna_design'], '--changed --tools keeps the intersection');

  const unioned = selectTasks({ tasks, tools: 'grna_design', tier: 'core' });
  assert.deepEqual(unioned.tools, ['molbio_grna_design'], '--tools alone selects by name');

  assert.throws(
    () => selectTasks({ tasks, changed: true, files: ['crispr.mjs'], tools: 'plasmid_map', tier: 'core' }),
    /disjoint/,
    'a --tools that intersects to nothing must fail loudly rather than run nothing',
  );
  assert.throws(
    () => selectTasks({ tasks, changed: true, files: ['crispr.mjs'], task: 'crispr-guide', tier: 'core' }),
    /cannot be combined/,
    '--task with --changed is ambiguous and must be refused',
  );

  // `--changed` that cannot narrow still honours an explicit --tools.
  const fallback = selectTasks({ tasks, changed: true, files: ['brand-new.mjs'], tools: 'grna_design', tier: 'core' });
  assert.equal(fallback.mode, 'tools');
  assert.deepEqual(fallback.tools, ['molbio_grna_design']);
}

// ── (8) the git reader agrees with reality ─────────────────────────────────

{
  const files = changedFiles();
  if (files !== undefined) {
    assert.ok(Array.isArray(files), 'changedFiles must return an array when git works');
    for (const file of files) assert.ok(!file.includes('\\'), `changedFiles must return POSIX paths (got ${file})`);
  }
  console.log(`git     : changedFiles() returned ${files === undefined ? 'undefined (fallback path)' : `${files.length} path(s)`}`);
}

console.log(`map     : ${plugin.toolModules.size} tools across ${declaredModules.size} modules`);
console.log('benchmark-changed checks passed: map, dependency reach, fallback-on-uncertainty, inert outcome, and the two operators');
