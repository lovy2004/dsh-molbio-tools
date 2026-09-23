/**
 * dsh-molbio-tools/test/benchmark-profile.mjs
 *
 * Guard the benchmark's headless profile against preset drift.
 *
 * ── What this protects ─────────────────────────────────────────────────────
 *
 * The Web surface gets the 57 tools from the "Molecular Biology Lab" agent
 * preset. The benchmark cannot: `dsh-headless` refuses a session that runs
 * under an agent preset ("the one-shot runner does not compose"), so
 * `benchmark/profile.mjs` reconstructs the toolset as HOST rows.
 *
 * A reconstruction is a second source of truth, and this repository has been
 * bitten by exactly that before (`preset.yml` advertised 52 tools through the
 * whole v19 cycle because nothing compared the claim to the registration). So
 * the reconstruction is checked rather than trusted:
 *
 *  1. **Row coverage.** Every preset row is either mounted by the benchmark or
 *     named in `SKIPPED_ROWS` with a reason. A row added upstream cannot
 *     disappear quietly — it fails here until someone classifies it.
 *  2. **Row fidelity.** A mounted row must equal the preset's row field for
 *     field (`id`, `name`, `config`, `disabled`), compared through the Loader's
 *     own YAML dialect so a `!!js` expression is the same node on both sides.
 *  3. **Tool completeness.** The `tool-molbio` row must be mounted, and the
 *     package's registered tool count must match what `preset.yml` advertises.
 *  4. **No self-contradiction.** Every row in `SKIPPED_ROWS` must still exist in
 *     the preset: a stale exemption is how a guard rots into a rubber stamp.
 *
 * It deliberately does NOT check the profile directory on disk: that is a
 * user-owned path built by a separate command. `benchmark/profile.mjs --check`
 * compares the written file, and `benchmark/run.mjs --offline` proves the values
 * still match the tools.
 *
 * Exit code non-zero = do not ship.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { benchmarkProfileRows, resolveDisabled, SKIPPED_ROWS } from '../benchmark/profile.mjs';
import { findHarnessRoot, readComposition } from '../benchmark/harness.mjs';
import { presetPlugins } from './preset-rows.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const PRESET = join(repoRoot, 'preset', 'molbio-lab', 'agent.cordis.yml');

const failures = [];
const notes = [];

/**
 * Compare two rows for equality, through their serialized form.
 *
 * The Loader's `!!js` tag parses to `{ __jsExpr }`, which is an object and so
 * compares unequal to the identical-looking string a hand-written expectation
 * would use. Comparing `JSON.stringify` output keeps the check in the same
 * dialect the Loader reads, without depending on key order in the source file.
 */
function sameRow(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The `tool-molbio` row's registered tool count, read from the plugin itself. */
async function registeredToolCount() {
  const registered = [];
  const plugin = await import('../index.mjs');
  plugin.apply({
    systemPrompt: { section() {} },
    get() {
      return undefined;
    },
    tools: {
      register(definition) {
        registered.push(definition);
      },
    },
  });
  return registered.length;
}

async function main() {
  const harnessRoot = findHarnessRoot(undefined);
  if (harnessRoot === undefined) {
    console.error('benchmark-profile: could not locate an installed DSH harness (set DSH_HARNESS_ROOT)');
    process.exit(2);
  }

  const document = await readComposition(PRESET, harnessRoot);
  const presetRows = presetPlugins(document);
  if (presetRows.length === 0) {
    console.error(`benchmark-profile FAILED: ${PRESET} declares no rows — the guard would pass vacuously`);
    process.exit(1);
  }

  const { kept, skipped } = benchmarkProfileRows(presetRows);
  const keptIds = new Set(kept.map((row) => row.id));
  const presetIds = new Set(presetRows.map((row) => row?.id ?? row?.name));

  // (1) coverage: every preset row is either mounted or explicitly skipped.
  for (const row of presetRows) {
    const id = row?.id ?? row?.name;
    if (keptIds.has(id)) continue;
    if (skipped.some((entry) => (entry.row?.id ?? entry.row?.name) === id)) continue;
    failures.push(`row "${String(id)}" is neither mounted by the benchmark profile nor named in SKIPPED_ROWS`);
  }

  // (4) no stale exemptions.
  for (const id of SKIPPED_ROWS.keys()) {
    if (!presetIds.has(id)) {
      failures.push(`SKIPPED_ROWS names "${id}", which the preset no longer declares — remove the exemption`);
    }
  }

  // (2) fidelity: the mounted rows ARE the preset's rows.
  for (const row of kept) {
    const original = presetRows.find((candidate) => (candidate?.id ?? candidate?.name) === row.id);
    if (original === undefined) {
      failures.push(`mounted row "${String(row.id)}" does not exist in the preset`);
      continue;
    }
    if (!sameRow(row, original)) {
      failures.push(`mounted row "${String(row.id)}" differs from the preset row: benchmark=${JSON.stringify(row)} preset=${JSON.stringify(original)}`);
    }
  }

  // (3) the toolset itself, and the claim made about it.
  const molbio = kept.find((row) => row.id === 'tool-molbio');
  if (molbio === undefined) {
    failures.push('the benchmark profile does not mount `tool-molbio` — the run would measure an empty toolset');
  } else if (molbio.name !== 'dsh-molbio-tools') {
    failures.push(`\`tool-molbio\` must name the package "dsh-molbio-tools" so Node resolves it from the profile (got ${JSON.stringify(molbio.name)})`);
  }

  const registered = await registeredToolCount();
  const presetYml = await readFile(join(dirname(PRESET), 'preset.yml'), 'utf8');
  const claimed = /(\d+)\s*个\s*molbio_|\b(\d+)\s+tools\b/.exec(presetYml);
  const claimedCount = claimed === null ? undefined : Number(claimed[1] ?? claimed[2]);
  if (claimedCount !== undefined && claimedCount !== registered) {
    failures.push(`preset.yml advertises ${claimedCount} molbio tools but the plugin registers ${registered}`);
  }
  notes.push(`tool-molbio registers ${registered} tools${claimedCount === undefined ? ' (preset.yml makes no count claim)' : ` and preset.yml claims ${claimedCount}`}`);

  // The disabled reasoning must stay resolvable: `resolveDisabled` enumerates
  // the `!!js` expressions it accepts, and an unrecognised one is an error, so
  // exercise every row's value here to surface it as a failure rather than as a
  // crash in the middle of a benchmark run.
  for (const row of presetRows) {
    try {
      resolveDisabled(row?.disabled);
    } catch (error) {
      failures.push(`row "${String(row?.id ?? row?.name)}": ${String(error)}`);
    }
  }

  notes.push(`mounted ${kept.length} of ${presetRows.length} preset rows; ${skipped.length} skipped with a reason`);
  for (const entry of skipped) notes.push(`  skip ${String(entry.row?.id ?? entry.row?.name)} — ${entry.reason}`);

  for (const note of notes) console.log(`  note  ${note}`);
  if (failures.length > 0) {
    console.error(`\nbenchmark-profile FAILED: ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nbenchmark-profile OK: the headless profile reconstructs the preset's toolset (${kept.length} rows, ${registered} tools)`);
}

if (import.meta.main) await main();
