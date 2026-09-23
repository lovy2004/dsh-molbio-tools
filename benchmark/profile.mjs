/**
 * dsh-molbio-tools/benchmark/profile.mjs
 *
 * Build the headless DSH profile the benchmark runs on.
 *
 * ── Why a hand-built profile exists at all ──────────────────────────────────
 *
 * The model-facing way to get the 57 tools is the "Molecular Biology Lab" agent
 * preset, and the benchmark would obviously rather run THAT than a
 * reconstruction of it. It cannot: `dsh-headless` refuses a preset for a
 * structural reason, not a configuration one —
 *
 *     session "…" runs under agent preset "molbio-lab", which the one-shot
 *     runner does not compose
 *
 * (`dsh-headless/lib/index.js`, the adoption guard). Presets are an
 * agent-plane feature the Web surface composes; the one-shot runner drives
 * `agents.create()` directly and never joins one. So the tools have to be
 * mounted as HOST rows, which is the one shape this package otherwise refuses
 * to ship (`cordis.patch.yml` is deliberately empty — see the preset's header).
 *
 * ── What keeps the reconstruction honest ────────────────────────────────────
 *
 * `test/benchmark-profile.mjs` compares the rows below against the preset's own
 * row list, field by field, and fails on any difference it has not been told
 * about. Two lists therefore cannot drift silently: adding a tool row to the
 * preset without adding it here turns the test red, and so does changing a
 * row's config. The exemptions below are a closed, justified set.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { findHarnessRoot, loaderYaml } from './harness.mjs';
import { presetPlugins } from '../test/preset-rows.mjs';

/** The profile the benchmark boots. Lives under `$DSH_HOME/profiles`. */
export const PROFILE_NAME = 'molbio-bench';

/**
 * Rows the benchmark drops, with the reason each is safe to drop.
 *
 * Every entry is a CONSCIOUS omission, so a preset row that is added upstream
 * can never disappear quietly: it simply is not in this table, and the drift
 * check reports it.
 */
export const SKIPPED_ROWS = new Map([
  ['persona', 'the headless patch owns the host `system-prompt` row (`personaSuffix`/`personaPrefix`)'],
  ['agent-instructions', 'dsh-base already mounts the host row; a second registration is a duplicate'],
  ['skill-filesystem', 'not needed: these tasks are computation, and the row would scan the workspace for skills'],
  ['command-goal', 'a human slash command; no human is at the keyboard in a one-shot run'],
  ['tool-goal', 'a long-horizon goal loop; every task here is one turn'],
]);

/**
 * Evaluate the `!!js` expressions the PRESET dialect actually uses.
 *
 * `disabled:` in the preset is sometimes a boolean and sometimes a Loader
 * expression (`!!js process.platform === 'win32'`), which this module parses
 * into `{ __jsExpr: "…" }`. A plain truthiness test treats that node as truthy
 * and would therefore drop `tool-pwsh` on Windows — where it is the ONLY shell
 * tool — while keeping nothing in its place. The set of expressions is closed
 * and tiny, so it is enumerated here rather than evaluated as code: an
 * unrecognised expression is a hard error, which is what keeps a future
 * upstream expression from being silently mis-resolved.
 *
 * @param {unknown} value a parsed `disabled:` value.
 * @returns {boolean} whether the row is disabled in this composition.
 */
export function resolveDisabled(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && typeof value.__jsExpr === 'string') {
    const expression = value.__jsExpr.trim();
    if (expression === "process.platform === 'win32'") return process.platform === 'win32';
    if (expression === "process.platform !== 'win32'") return process.platform !== 'win32';
    throw new Error(
      `benchmark: unrecognised \`!!js\` expression in \`disabled\`: ${JSON.stringify(expression)} — ` +
        'add it to resolveDisabled rather than guessing',
    );
  }
  throw new Error(`benchmark: unreadable \`disabled\` value: ${JSON.stringify(value)}`);
}

/**
 * The rows the benchmark mounts, in the preset's own order.
 *
 * Derived, never hand-listed: `benchmarkProfileRows` walks the preset and keeps
 * every row that is a model-facing tool with no realm requirement. The
 * predicate is the policy — "a row this profile may host" — so a new preset row
 * is classified by the rule, not by someone remembering to edit this file.
 *
 * @param {object[]} rows the preset's child rows.
 * @returns {{kept: object[], skipped: {row: object, reason: string}[]}}
 */
export function benchmarkProfileRows(rows) {
  const kept = [];
  const skipped = [];
  for (const row of rows) {
    const id = row?.id ?? row?.name;
    if (row?.group === true || row?.name === 'cordis:group') {
      skipped.push({ row, reason: `realm group "${id}": a host row cannot join an entry-local isolate realm` });
      continue;
    }
    if (resolveDisabled(row?.disabled)) {
      const how = typeof row.disabled === 'object' ? `!!js ${row.disabled.__jsExpr}` : String(row.disabled);
      skipped.push({ row, reason: `disabled on this platform: ${how}` });
      continue;
    }
    if (SKIPPED_ROWS.has(id)) {
      skipped.push({ row, reason: SKIPPED_ROWS.get(id) });
      continue;
    }
    if (typeof row?.name !== 'string' || typeof id !== 'string') {
      skipped.push({ row, reason: `row has no usable id/name: ${JSON.stringify(row)}` });
      continue;
    }
    kept.push(row);
  }
  return { kept, skipped };
}

/**
 * Wrap host rows into the profile patch layer.
 *
 * Nothing is disabled: plan mode is INACTIVE by default (`/plan` turns it on),
 * so `dsh-base`'s `plan-mode` row is harmless here. That was verified rather
 * than assumed — an earlier revision carried a `{ id: 'plan-mode', disabled:
 * true }` entry, and `dsh --profile molbio-bench --dump-config` showed it was
 * dead (the row still printed from `dsh-base` with no `disabled:` marker, i.e.
 * the disable never landed). Trusting it would have meant documenting a
 * protection the composition did not have.
 *
 * @param {object[]} rows the kept host rows.
 * @returns {object[]} a profile patch layer.
 */
export function profilePatch(rows) {
  return [{ insert: rows }];
}

/** The `tool-molbio` row, pointing at this checkout by package name. */
function molbioRow(rows) {
  const row = rows.find((candidate) => candidate?.id === 'tool-molbio');
  if (row === undefined) {
    throw new Error('benchmark: the preset has no `tool-molbio` row — the drift check would pass on an empty mount');
  }
  return row;
}

/**
 * The full patch document for the profile, serialized in the Loader's dialect.
 *
 * @param {{presetPath: string, harnessRoot: string}} options
 * @returns {Promise<string>} the YAML text.
 */
export async function renderProfilePatch(options) {
  const { yaml, schema } = await loaderYaml(options.harnessRoot);
  const document = await yaml.load(await readFile(options.presetPath, 'utf8'), { schema });
  const rows = presetPlugins(document);
  if (rows.length === 0) {
    throw new Error(`benchmark: ${options.presetPath} declares no preset rows — refusing to generate an empty profile`);
  }
  molbioRow(rows);
  const { kept } = benchmarkProfileRows(rows);
  const header = [
    '# GENERATED by benchmark/profile.mjs — do not edit.',
    '#',
    '# The headless benchmark profile: the Molecular Biology Lab toolset mounted as',
    '# HOST rows, because `dsh-headless` refuses any session that runs under an agent',
    '# preset (`the one-shot runner does not compose`). Regenerate with:',
    '#',
    '#     node benchmark/profile.mjs',
    '#',
    '# `benchmark/profile.mjs` derives every row below from',
    '# preset/molbio-lab/agent.cordis.yml, and `test/benchmark-profile.mjs` fails if the',
    '# two lists drift. `plan-mode` is disabled on purpose: its section forbids the',
    '# tool execution and file mutation every task here requires.',
    '',
  ].join('\n');
  return `${header}${yaml.dump(profilePatch(kept), { schema, noRefs: true, lineWidth: -1 })}`;
}

/** The profile directory for a harness home. */
export function profileDir(dshHome, name = PROFILE_NAME) {
  return join(dshHome, 'profiles', name);
}

/**
 * Write the profile: manifest, plugin link, and patch layer.
 *
 * Idempotent, and it touches only its own profile directory. It does NOT run a
 * package manager: the only dependency is this checkout, reached by a
 * directory junction, because `dsh plugin add` (pnpm) cannot install the
 * `@deepseek-ai/dsh-*` packages here at all — the shipped `dsh-web-app`
 * manifest names unpublished packages (`@deepseek-ai/dsh-client-ui-question`
 * and friends), so any `pnpm install` in a profile fails with `404`.
 *
 * @param {{dshHome: string, repoRoot: string, harnessRoot: string, reset?: boolean}} options
 * @returns {Promise<{dir: string, patchPath: string, rows: number, skipped: object[]}>}
 */
export async function writeProfile(options) {
  const dir = profileDir(options.dshHome);
  const patchPath = join(dir, 'cordis.patch.yml');
  if (options.reset === true && existsSync(dir)) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const manifestPath = join(dir, 'package.json');
  const manifest = {
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: { 'dsh-molbio-tools': `link:${options.repoRoot.replace(/\\/g, '/')}` },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-molbio-tools'],
      },
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    join(dir, 'cordis.yml'),
    '# dsh profile root — an empty entry list; the tree is composed as patches.\n[]\n',
    'utf8',
  );

  // The bundle patch of `dsh-molbio-tools` inserts nothing, and the preset layer
  // is unreachable from headless, so the link is only what makes the package
  // RESOLVABLE (the profile bundle entry names it).
  const link = join(dir, 'node_modules', 'dsh-molbio-tools');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  if (!existsSync(link)) await symlink(options.repoRoot, link, 'junction');

  const patch = await renderProfilePatch({
    presetPath: join(options.repoRoot, 'preset', 'molbio-lab', 'agent.cordis.yml'),
    harnessRoot: options.harnessRoot,
  });
  await writeFile(patchPath, patch, 'utf8');

  const { yaml, schema } = await loaderYaml(options.harnessRoot);
  const document = yaml.load(
    await readFile(join(options.repoRoot, 'preset', 'molbio-lab', 'agent.cordis.yml'), 'utf8'),
    { schema },
  );
  const { kept, skipped } = benchmarkProfileRows(presetPlugins(document));
  return { dir, patchPath, rows: kept.length, skipped };
}

/** Is the on-disk patch already what the generator would write? */
export async function checkProfile(options) {
  const patchPath = join(profileDir(options.dshHome), 'cordis.patch.yml');
  if (!existsSync(patchPath)) return { ok: false, detail: `no profile patch at ${patchPath}` };
  const current = await readFile(patchPath, 'utf8');
  const wanted = await renderProfilePatch({
    presetPath: join(options.repoRoot, 'preset', 'molbio-lab', 'agent.cordis.yml'),
    harnessRoot: options.harnessRoot,
  });
  return current === wanted
    ? { ok: true, detail: `${patchPath} matches the preset` }
    : { ok: false, detail: `${patchPath} is stale — run \`node benchmark/profile.mjs\`` };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const repoRoot = join(import.meta.dirname, '..');
  const dshHome = flag('--dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'));
  const harnessRoot = findHarnessRoot(flag('--dsh', undefined));
  if (harnessRoot === undefined) {
    console.error('benchmark: could not locate an installed DSH harness (pass --dsh <root>)');
    process.exit(2);
  }
  if (argv.includes('--check')) {
    const result = await checkProfile({ dshHome, repoRoot, harnessRoot });
    console.log(result.ok ? `profile OK: ${result.detail}` : `profile STALE: ${result.detail}`);
    process.exit(result.ok ? 0 : 1);
  }
  const result = await writeProfile({ dshHome, repoRoot, harnessRoot, reset: argv.includes('--reset') });
  console.log(`profile ${PROFILE_NAME}: ${result.dir}`);
  console.log(`  patch : ${result.patchPath}`);
  console.log(`  rows  : ${result.rows} host rows mounted`);
  for (const skipped of result.skipped) console.log(`  skip  : ${skipped.row.id ?? skipped.row.name} — ${skipped.reason}`);
}

if (import.meta.main) await main();
