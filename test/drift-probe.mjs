/**
 * dsh-molbio-tools/test/drift-probe.mjs
 *
 * Does the preset drift guard actually catch drift?
 *
 * `test/preset-health.mjs` compares `preset/molbio-lab/agent.cordis.yml` against
 * the `standard` preset installed beside the harness. That check is only worth
 * its runtime if it FAILS on the defects it exists for — and the two defects
 * that actually reached a release both slipped through the previous guard, which
 * compared row IDs only:
 *
 *   - v17 shipped `@deepseek-ai/dsh-workflow-worker-thread`, a provider package
 *     no released DSH installs. The row mounted nothing and the preset died at
 *     load. The id comparison saw a row named `workflow-worker-thread`, noted it
 *     as drift, printed a note, and exited 0.
 *   - The same composition enabled `tool-ralph`, which upstream `standard`
 *     ships with `disabled: true`. Same row id, so the guard was blind to it.
 *
 * So this file mutates a copy of the composition and asserts the guard reports
 * the mutation, then asserts a clean composition reports NOTHING (a guard that
 * fires on everything is equally useless).
 *
 * Usage: node test/drift-probe.mjs [--dsh <harness root>]
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compositionDrift, toolCountDrift } from './preset-health.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const argv = process.argv.slice(2);
const dshFlag = argv.indexOf('--dsh');
const harnessRoot = resolve(
  dshFlag === -1
    ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
    : argv[dshFlag + 1],
);

/** Node's upward `node_modules` walk, as the preset roster resolves packages. */
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

/** Import an installed package by its own manifest, scope-independent. */
async function importPackage(name) {
  const pkgDir = packageInstalled(name, harnessRoot);
  assert.ok(pkgDir !== undefined, `${name} is installed beside the harness`);
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return pick(value.default ?? value.import ?? value.require);
    return undefined;
  };
  const entry = pick(manifest.exports?.['.'] ?? manifest.exports ?? manifest.main) ?? 'index.js';
  return await import(pathToFileURL(join(pkgDir, entry.replace(/^\.\//, ''))).href);
}

/** Read a composition with the Loader's own YAML dialect (carries `!!js`). */
async function readComposition(path) {
  const { entryListSchema } = await importPackage('@deepseek-ai/cordis-plugin-include');
  const yaml = (await importPackage('js-yaml')).default;
  return yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema });
}

/** Rows with nested group children flattened inline, in composition order. */
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

const standardPath = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml');
assert.ok(existsSync(standardPath), `the shipped standard preset is installed at ${standardPath}`);

const standardRows = orderedRows(await readComposition(standardPath));
const mineRows = orderedRows(await readComposition(join(repoRoot, 'preset', 'molbio-lab', 'agent.cordis.yml')));
console.log(`harness : ${harnessRoot}`);
console.log(`rows    : standard ${standardRows.length}, molbio-lab ${mineRows.length}\n`);

let failed = 0;
let total = 0;
const check = (name, run) => {
  total += 1;
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${String(error?.message ?? error).split('\n')[0]}`);
  }
};

const withRow = (id, patch) => mineRows.map((row) => (row?.id === id ? { ...row, ...patch } : row));
const withoutRow = (id) => mineRows.filter((row) => row?.id !== id);
const driftText = (rows) => compositionDrift(standardRows, rows).join(' | ');

// ── the guard stays quiet when the composition is right ─────────────────────

check('the shipped composition produces no drift at all', () => {
  assert.deepEqual(compositionDrift(standardRows, mineRows), []);
});

// ── the two defects that reached a release ─────────────────────────────────

check('a phantom provider package is caught (v17: dsh-workflow-worker-thread)', () => {
  // The real defect replaced the row wholesale: a different id AND a different
  // package name. The guard has no row to pair it with, so it must report the
  // pair (a row upstream no longer finds, and a row upstream does not ship) —
  // which is exactly how an operator reads the two packages in the diff.
  const mutated = withRow('workflow-ptc', {
    id: 'workflow-worker-thread',
    name: '@deepseek-ai/dsh-workflow-worker-thread',
  });
  const text = driftText(mutated);
  assert.match(text, /missing row "workflow-ptc" \(shipped standard has it\)/, text);
  assert.match(text, /extra row "workflow-worker-thread" \(not in shipped standard\)/, text);
});

check('an upstream `disabled: true` that was dropped is caught (v17: tool-ralph)', () => {
  const text = driftText(withRow('tool-ralph', { disabled: undefined }));
  assert.match(text, /row "tool-ralph": upstream ships it disabled and this preset enables it/, text);
});

// ── the other ways a copied composition rots ───────────────────────────────

check('a renamed package under an unchanged id is caught', () => {
  const text = driftText(withRow('tool-web', { name: '@deepseek-ai/dsh-tool-web-fetch' }));
  assert.match(text, /row "tool-web": name "@deepseek-ai\/dsh-tool-web" -> "@deepseek-ai\/dsh-tool-web-fetch"/, text);
});

check('a changed config is caught', () => {
  const text = driftText(withRow('tool-web', { config: { fetch: false, searchTimeoutMs: 60000 } }));
  assert.match(text, /row "tool-web": config differs/, text);
});

check('a changed isolate realm is caught', () => {
  const mutated = mineRows.map((row) => (row?.id === 'delegation' ? { ...row, isolate: {} } : row));
  assert.match(driftText(mutated), /row "delegation": isolate realm differs/, driftText(mutated));
});

check('a dropped upstream row is caught', () => {
  assert.match(driftText(withoutRow('present')), /missing row "present"/, driftText(withoutRow('present')));
});

check('an unexpected extra row is caught, while tool-molbio is allowed', () => {
  const extra = [...mineRows, { id: 'tool-something-else', name: '@deepseek-ai/dsh-tool-web' }];
  const text = driftText(extra);
  assert.match(text, /extra row "tool-something-else"/, text);
  assert.doesNotMatch(text, /extra row "tool-molbio"/, text);
});

check('reordering the rows is caught', () => {
  const reordered = [...mineRows];
  const from = reordered.findIndex((row) => row?.id === 'tool-ask-user');
  const to = reordered.findIndex((row) => row?.id === 'tool-todo');
  assert.ok(from !== -1 && to !== -1, 'both rows exist');
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  assert.match(driftText(reordered), /row order: position \d+ is "tool-todo" here and "tool-ask-user"/, driftText(reordered));
});

// ── the tool-count claim in preset.yml ─────────────────────────────────────
// v19 grew the toolset from 52 to 57 while `preset.yml` kept advertising 52,
// so the mode picker showed a wrong number for a whole release. The guard that
// now checks it is worth exactly as much as its ability to fail.

check('the tool-count guard is quiet when the claim matches', () => {
  assert.deepEqual(toolCountDrift('标准编码能力 + 57 个 molbio_* 工具（…）。', 57), []);
  assert.deepEqual(toolCountDrift('the standard agent plus 57 tools', 57), []);
  // Counts attributed to something else must not be mistaken for the toolset.
  assert.deepEqual(toolCountDrift('90+ 限制酶、2–50 条序列、57 个 molbio_* 工具', 57), []);
  assert.deepEqual(toolCountDrift('no claim here at all', 57), []);
});

check('a stale tool count in the description is caught (v19: 52 while 57 shipped)', () => {
  const stale = toolCountDrift('标准编码能力 + 52 个 molbio_* 工具（…）。', 57);
  assert.equal(stale.length, 1, 'the stale claim is reported');
  assert.match(stale[0], /claims 52 tools but the plugin registers 57/, stale[0]);
  assert.match(toolCountDrift('the standard agent plus 52 tools', 57).join(' | '), /claims 52 tools but the plugin registers 57/);
});

check('a description with no tool count is not forced to carry one', () => {
  assert.deepEqual(toolCountDrift('分子生物学专属模式：标准编码能力 + molbio 工具集。', 57), []);
});

console.log('');
if (failed > 0) {
  console.error(`drift-probe FAILED: ${failed} check(s) — the preset drift guard is not doing its job`);
  process.exit(1);
}
console.log(`drift-probe passed: the guard is quiet on the shipped composition and catches all ${total - 1} mutations`);
