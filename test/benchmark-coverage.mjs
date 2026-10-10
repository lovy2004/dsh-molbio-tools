/**
 * dsh-molbio-tools/test/benchmark-coverage.mjs
 *
 * Guard the benchmark suite's COVERAGE and its fixture premises.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `benchmark/README.md` states the rule this file enforces: every registered
 * `molbio_*` tool must be exercised by at least one task, and a task that is
 * added or changed must keep its offline verifier. Without a machine check,
 * "cover all the tools" is a promise that decays the first time someone adds a
 * tool in a hurry — which is exactly how the suite fell to 12 of 57 tools in the
 * first place.
 *
 * It also asserts the PREMISES the fixtures rest on, because a fixture that
 * silently stops satisfying its task looks exactly like a model failure:
 *
 *  - the Golden Gate vector is BsaI-free (the task's whole premise);
 *  - the mutagenesis template still admits a primer pair (its seed was searched
 *    for that property, and a designer change could invalidate it);
 *  - the intron target still yields a junction-spanning pair;
 *  - every task's tier is core or full, and core is a non-empty minority.
 *
 * Exit code non-zero = do not ship.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadTasks, tasksForTier } from '../benchmark/score.mjs';
import { invocationsFor, usePlasmid, useWorkspaceRoot } from '../benchmark/verifications.mjs';
import { FIXTURES, NAMED_SEQUENCES, expandInstruction } from '../benchmark/sequences.mjs';
import { parseSnapGeneBytes } from '../snapgene.mjs';
import { loadTools } from '../benchmark/tools.mjs';

process.env.MOLBIO_AUTO_VIEW = '0';

const harness = loadTools({ workspaceRoot: join(import.meta.dirname, '..', 'benchmark', '.coverage-workspace') });
const registered = new Set(harness.names);
const { tasks, files } = await loadTasks();

console.log(`suite   : ${tasks.length} task(s) from ${files.length} file(s)`);
console.log(`tools   : ${registered.size} registered`);

// ── (1) every registered tool is covered ────────────────────────────────────

const covered = new Set(tasks.flatMap((task) => task.covers));
const uncovered = [...registered].filter((tool) => !covered.has(tool)).sort();
assert.deepEqual(
  uncovered,
  [],
  `these tools are registered but NO task exercises them: ${uncovered.join(', ')}\n` +
    'Add a task (and an offline verifier in benchmark/verifications.mjs), or the tool is untested usability-wise.',
);

// A `covers` entry that names nothing real is equally a bug: it inflates the
// coverage number without exercising anything.
const phantom = [...covered].filter((tool) => !registered.has(tool)).sort();
assert.deepEqual(phantom, [], `these \`covers\` entries name tools that are not registered: ${phantom.join(', ')}`);

console.log(`coverage: ${covered.size}/${registered.size} tools covered by ${tasks.length} task(s)`);

// ── (2) tools referenced by selection rules are real, and `covers` is not a lie ──

for (const task of tasks) {
  for (const key of ['expect_tools', 'forbid_tools', 'expect_absent']) {
    for (const tool of task[key] ?? []) {
      assert.ok(registered.has(tool), `${task.id}.${key} names "${tool}", which is not a registered tool`);
    }
  }
  // `expect_tools` and `covers` answer different questions and both matter: a
  // tool the task REQUIRES must be one it claims to cover.
  for (const tool of task.expect_tools ?? []) {
    assert.ok(task.covers.includes(tool), `${task.id} requires ${tool} but does not list it in \`covers\``);
  }
}

// `covers` is what `--tools` selects on, so an over-claim is worse than a gap: it
// would let `--tools X` run a task that never exercises X and report a pass.
// Every covered tool must therefore appear either in the task's selection rules
// or in the invocations its `where: "tool"` assertions are checked against.
//
// The builders need the pUC118 fixture bound before they can run, so bind a stub
// here and collect EVERY over-claim rather than dying on the first one — fixing
// them one assertion-failure at a time is how this check would get disabled.
useWorkspaceRoot(join(import.meta.dirname, '..', 'benchmark', '.coverage-workspace'));
usePlasmid({ sequence: 'A'.repeat(3162), length: 3162, topology: 'circular', features: [] });
const overClaims = [];
for (const task of tasks) {
  const invocations = invocationsFor(task, {});
  if (invocations === undefined) continue; // NETWORK_TASKS and its kin; checked below
  for (const tool of task.covers) {
    const required = ['expect_tools', 'expect_absent', 'forbid_tools'].some((key) => (task[key] ?? []).includes(tool));
    const invoked = invocations.some((invocation) => invocation.tool === tool);
    if (!required && !invoked) {
      overClaims.push(
        `${task.id} claims to cover ${tool} but neither requires it nor runs it — \`--tools ${tool.replace('molbio_', '')}\` would run a task that does not exercise it`,
      );
    }
  }
}
assert.deepEqual(overClaims, [], 'the suite over-claims coverage (see the list above)');

// ── (3) tiers ───────────────────────────────────────────────────────────────

const core = tasksForTier(tasks, 'core');
const full = tasksForTier(tasks, 'full');
assert.ok(core.length > 0, 'the core tier must not be empty');
assert.equal(full.length, tasks.length, 'the full tier must be every task');
assert.ok(core.length < tasks.length, 'core must be a strict subset — otherwise the tier split buys nothing');

// The core tier is a SAMPLE, not a partition: it must exercise a meaningful
// share of the catalog, but demanding one representative per category would
// force artificial tasks (there is no natural "core" genome-scale scan). What is
// asserted is that core is a real subset with real reach, so `npm run bench`
// cannot quietly degrade into a two-task smoke test.
const coreTools = new Set(core.flatMap((task) => task.covers));
const allCategories = new Set(tasks.map((task) => task.category));
assert.ok(
  coreTools.size >= 12,
  `the core tier covers only ${coreTools.size} tool(s); it is meant to be a broad sample of the catalog, not a smoke test`,
);
assert.ok(
  core.length >= Math.ceil(tasks.length / 6),
  `the core tier is ${core.length} of ${tasks.length} tasks — too small to represent the suite`,
);
// Anything the core tier REQUIRES must also be one it claims to cover, or the
// two lists can drift.
for (const task of core) {
  for (const tool of task.expect_tools ?? []) {
    assert.ok(task.covers.includes(tool), `core task ${task.id} requires ${tool} but does not cover it`);
  }
}

console.log(
  `tiers   : ${core.length} core (${coreTools.size} tools), ${tasks.length - core.length} full-only, ${allCategories.size} categories`,
);

// ── (4) the fixtures still satisfy their task's premise ─────────────────────

assert.deepEqual(
  ['GGTCTC', 'GAGACC'].filter((site) => FIXTURES.GG_BACKBONE.includes(site)),
  [],
  'the Golden Gate vector is no longer BsaI-free — the assembly task would fail for a reason that is not the model',
);

const mutagenesis = invocationsFor({ id: 'mutagenesis', assertions: [{ where: 'tool', pattern: 'x' }] });
const mutagenesisArgs = mutagenesis[0].args;
const mutagenesisValue = await harness.run('molbio_mutagenesis_primers', mutagenesisArgs);
assert.ok(
  mutagenesisValue.pairs.length > 0,
  'the mutagenesis fixture no longer admits a primer pair — its seed was searched for that property; re-search it',
);
console.log(`fixtures: mutagenesis seed still yields ${mutagenesisValue.pairs.length} pair(s); GG backbone BsaI-free`);

// ── (4b) the two pUC118 fixtures still describe the same molecule ───────────
// `genbank-parse` asks the model whether the .gb and the .dna are the same
// plasmid, so their agreement IS that task's premise. They are authored
// separately (the .gb is not machine-generated from the .dna — it carries fewer
// annotations), so nothing but this check keeps them in step: edit one and the
// task quietly becomes unanswerable.
const genbankFixture = await harness.run('molbio_parse_genbank', {
  genbank: await readFile(join(import.meta.dirname, '..', FIXTURES.GENBANK_PATH), 'utf8'),
});
const snapgeneFixture = parseSnapGeneBytes(new Uint8Array(await readFile(join(import.meta.dirname, 'fixtures', 'pUC118.dna'))));
assert.equal(
  genbankFixture.sequence,
  snapgeneFixture.sequence,
  'the committed pUC118.gb and pUC118.dna no longer hold the same sequence — `genbank-parse` asks the model to compare exactly that',
);
assert.equal(genbankFixture.length, snapgeneFixture.length, 'and they still agree on the length');

// ── (4c) every offline builder still names a real task ──────────────────────
// The grader only ever asks for a task that exists, so a builder left behind by a
// task RENAME is never consulted and never fails — it just stops verifying
// anything (two were found that way: `plasmid-map`, `restriction-map`). The ids
// live in a function-local map, so they are read from the source; the count
// assertion first is what keeps a reformat from turning this into a blind scan.
const verifierSource = await readFile(join(import.meta.dirname, '..', 'benchmark', 'verifications.mjs'), 'utf8');
const builderIds = [...verifierSource.matchAll(/^ {4}'([a-z0-9-]+)':\s*\(\)\s*=>/gm)].map((match) => match[1]);
assert.ok(
  builderIds.length >= 45,
  `the builder scan found ${builderIds.length} id(s) — if the map was reformatted, fix this pattern rather than letting the check go blind`,
);
const taskIds = new Set(tasks.map((task) => task.id));
const orphanedBuilders = builderIds.filter((id) => !taskIds.has(id)).sort();
assert.deepEqual(
  orphanedBuilders,
  [],
  `these offline builders name tasks that no longer exist: ${orphanedBuilders.join(', ')} — renamed or removed, so the builder verifies nothing`,
);
console.log(`fixtures: .gb and .dna agree on all ${genbankFixture.length} bases; builders: ${builderIds.length} declared, every one naming a real task`);

// ── (5) every instruction expands ───────────────────────────────────────────

for (const task of tasks) {
  const rendered = expandInstruction(task.instruction);
  assert.ok(!/\{[a-z_]+:/.test(rendered), `${task.id}: an unexpanded placeholder survived: ${rendered.slice(0, 120)}`);
  assert.ok(rendered.length >= 20, `${task.id}: the rendered instruction is suspiciously short`);
}
console.log(`expand  : ${tasks.length} instruction(s) expand with no surviving placeholder`);

// ── (6) the ONLINE tasks are honestly marked ────────────────────────────────

const { NETWORK_TASKS } = await import('../benchmark/verifications.mjs');
for (const id of NETWORK_TASKS) {
  const task = tasks.find((entry) => entry.id === id);
  assert.ok(task, `NETWORK_TASKS names "${id}", which is not a task`);
  assert.deepEqual(
    task.assertions.filter((assertion) => assertion.where === 'tool'),
    [],
    `${id} is listed as online-only but carries a \`where: "tool"\` assertion — a live-API result cannot be pinned`,
  );
}
console.log(`online  : ${NETWORK_TASKS.size} task(s) marked answer-only (live API, nothing pinnable)`);

// ── (7) the suite's own metadata is consistent ──────────────────────────────

const presetYml = await readFile(join(import.meta.dirname, '..', 'preset', 'molbio-lab', 'preset.yml'), 'utf8');
const claimed = /(\d+)\s*个\s*molbio_|\b(\d+)\s+tools\b/.exec(presetYml);
if (claimed !== null) {
  assert.equal(Number(claimed[1] ?? claimed[2]), registered.size, 'preset.yml advertises a different tool count than the plugin registers');
}

assert.ok(NAMED_SEQUENCES.qc_reads.split('\n').filter((line) => line.startsWith('@')).length === 3, 'qc_reads must carry the three reads the fastq-qc task describes');

console.log(`\nbenchmark-coverage OK: ${registered.size}/${registered.size} tools covered, ${tasks.length} tasks (${core.length} core), ${files.length} suite file(s)`);
