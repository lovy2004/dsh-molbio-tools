/**
 * dsh-molbio-tools/preset/install.mjs
 *
 * Register this package's agent preset with a DSH profile — without copying
 * the preset into `<dshHome>/.agent-presets`.
 *
 * WHAT THIS DOES
 * --------------
 * `dsh plugin add dsh-molbio-tools` installs the package into a profile and
 * makes its 46 tools load, but it cannot make the "Molecular Biology Lab"
 * preset appear in the picker: `dsh plugin` manages profile BUNDLES, and agent
 * presets are discovered only from the package's own `presets/` directory and
 * from `<dshHome>/.agent-presets` (see @deepseek-ai/dsh-agent-presets,
 * "可选的 preset 来自两处"). Discovery roots can also be configured, and that
 * is the seam this script uses:
 *
 *     - id: agent-presets            # the web-app's roster row
 *       config:
 *         default: standard          # patch replaces the WHOLE config, so restate it
 *         roots:
 *           - path: <this package>/preset
 *             trust: system
 *
 * Two consequences worth knowing before you run it:
 *
 * 1. The root points INTO the installed package, and that path is stable
 *    across versions (`node_modules/dsh-molbio-tools` is a symlink for `link:`
 *    installs and a real directory for npm/tarball installs). So upgrading is
 *    `dsh plugin --profile <p> update dsh-molbio-tools` and nothing else — no
 *    re-copy, no edit here. A copied preset, by contrast, is frozen where it
 *    was copied and must be re-copied (into a NEW version directory) on every
 *    release.
 * 2. `trust: system` keeps the preset read-only for this deployment: it cannot
 *    be edited or deleted from the presets UI, which is what you want for a
 *    directory owned by a package. Authoring your own presets still works as
 *    long as `includeUserRoot` stays at its default (true).
 *
 * The edit is idempotent: if this exact root is already registered, the script
 * reports it and writes nothing. The profile's patch file is backed up first.
 *
 * Usage:
 *   node preset/install.mjs [--profile <name>] [--dsh-home <path>] [--dry-run] [--check]
 *
 *   --profile <name>   profile to register with (default: web)
 *   --dsh-home <path>  harness home (default: $DSH_HOME, else ~/.dsh)
 *   --dry-run          print the entry that would be written, write nothing
 *   --check            report whether the root is registered; exit 1 when absent
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

/** Read `--flag value` / `--flag` from argv. */
function flag(name) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const profile = flag('profile') === undefined ? 'web' : String(flag('profile'));
const dryRun = flag('dry-run') === true;
const checkOnly = flag('check') === true;
const dshHomeFlag = flag('dsh-home');
const dshHome = resolve(
  typeof dshHomeFlag === 'string'
    ? dshHomeFlag
    : (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')),
);

const fail = (message) => {
  console.error(`install.mjs: ${message}`);
  process.exit(1);
};

// ── locate this package's preset root ───────────────────────────────────────
// The script lives at <package>/preset/install.mjs, so the preset root is its
// own directory. When the package was installed INTO the profile, prefer that
// copy: it is the one `dsh plugin update` refreshes, so pointing at it keeps
// upgrades automatic even when this script is run from a dev checkout.
const profileDir = join(dshHome, 'profiles', profile);
const profilePatch = join(profileDir, 'cordis.patch.yml');
const installedPreset = join(profileDir, 'node_modules', 'dsh-molbio-tools', 'preset');
const presetRoot = existsSync(installedPreset) ? installedPreset : here;
const composition = join(presetRoot, 'molbio-lab', 'agent.cordis.yml');

if (!existsSync(composition)) {
  fail(`no preset composition at ${composition}\n  run this from the package (preset/install.mjs) or install the package into the profile first`);
}
if (!existsSync(profileDir)) {
  fail(`no profile directory at ${profileDir}\n  create the profile first (e.g. \`dsh --profile ${profile} --from-default-profile web\`) and run \`dsh plugin --profile ${profile} add dsh-molbio-tools\``);
}
if (!existsSync(profilePatch)) {
  fail(`the profile has no cordis.patch.yml at ${profilePatch}`);
}

// Normalize to forward slashes: the path is written into YAML, and `\` is an
// escape character there. Windows accepts forward slashes and discovery
// resolves them, so one form works everywhere.
const rootPath = presetRoot.replace(/\\/g, '/');

// ── is the registration already there? ──────────────────────────────────────
const original = readFileSync(profilePatch, 'utf8');
const already = original.includes(rootPath) || original.includes(presetRoot);

if (checkOnly) {
  if (already) {
    console.log(`ok: ${rootPath} is already registered in ${profilePatch}`);
    process.exit(0);
  }
  console.error(`not registered: ${rootPath} does not appear in ${profilePatch}`);
  process.exit(1);
}

if (already && !dryRun) {
  console.log(`already registered — nothing to do`);
  console.log(`  preset root : ${rootPath}`);
  console.log(`  patch file  : ${profilePatch}`);
  process.exit(0);
}

// ── does this profile actually compose the roster row we patch? ─────────────
// A profile without @deepseek-ai/dsh-web-app (headless, sdk, a bare `dsh plugin`
// profile) has no `agent-presets` row, and the loader would reject an
// id-targeted patch naming an id it never saw. Detect it from the profile's own
// bundle list rather than by attempting the write.
let bundles = [];
try {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  bundles = manifest.dsh?.profile?.bundles ?? [];
} catch (error) {
  fail(`cannot read the profile manifest: ${String(error.message)}`);
}
const hasRoster = bundles.some((name) => name === '@deepseek-ai/dsh-web-app'
  || name.includes('web-app')
  || name.includes('agent-presets'));
if (!hasRoster) {
  fail(`profile "${profile}" does not compose the agent-preset roster\n`
    + `  its bundles are: ${bundles.join(', ') || '(none)'}\n`
    + `  patch a profile that includes @deepseek-ai/dsh-web-app (the shipped \`web\` template does), or copy the preset into ${join(dshHome, '.agent-presets')} instead`);
}

// ── append the patch entry ──────────────────────────────────────────────────
// A freshly initialized profile ships an EMPTY patch file whose whole content is
// the empty top-level array `[]` (plus a comment header). Appending after that
// `[]` produces a document with two top-level nodes — invalid YAML — so the
// placeholder is replaced rather than appended to. A file that already holds
// entries is appended to, never rewritten: it is the user's, may carry
// unrelated entries and comments, and is watched live by a `patchReload: live`
// profile.
const head = [
  '# Registered by dsh-molbio-tools/preset/install.mjs — makes the "Molecular Biology Lab"',
  '# preset visible to this profile from the installed package, so package upgrades carry the',
  '# preset with them (no copy step, no per-release edit). `config` replaces the row\'s whole',
  '# config, so `default` is restated. Re-running the installer is a no-op.',
].join('\n');
const entry = [
  head,
  '- id: agent-presets',
  '  config:',
  '    default: standard',
  '    roots:',
  `      - path: ${rootPath}`,
  '        trust: system',
].join('\n');

/** Whether the file holds nothing but comments and the empty-array placeholder. */
function isEmptyPatchList(text) {
  const code = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .trim();
  return code === '' || code === '[]';
}

const updated = isEmptyPatchList(original)
  // Drop the placeholder itself: stripping only trailing whitespace would leave
  // the `[]` in place, and a second top-level node after `[]` is exactly the
  // "end of the stream or a document separator is expected" parse error.
  ? `${original.replace(/^[ \t]*\[\][ \t]*\r?\n?/m, '').replace(/\s*$/, '')}\n${entry}\n`
  : `${original.replace(/\s*$/, '')}\n\n${entry}\n`;

if (dryRun) {
  console.log(already
    ? 'dry run — this root is ALREADY registered; a real run would change nothing'
    : 'dry run — the following entry would be appended to:');
  console.log(`  ${profilePatch}`);
  console.log(entry);
  process.exit(0);
}

const backup = `${profilePatch}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(profilePatch, backup);
writeFileSync(profilePatch, updated, 'utf8');
console.log(`patched  : ${profilePatch}`);
console.log(`backup   : ${backup}`);
console.log(`preset   : ${rootPath}/molbio-lab`);

// ── verify by asking the harness to compose the tree ────────────────────────
// `--dump-config` re-runs the real patch pipeline, so a malformed patch or a row
// the loader would reject shows up here rather than at session start. The two
// failure modes are NOT the same thing and must not be reported alike:
//
//   - the dump cannot be RUN (no `dsh` on PATH, a sandbox that refuses piped
//     child stdio) — say so, keep the patch, exit 0;
//   - the dump RUNS and is empty or missing the root — that means the patch
//     itself is bad; restore the backup and exit non-zero.
//
// An empty result from execFileSync carries its own reason on stderr, which is
// how a loader error is told apart from a launch failure.
const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
let dump = '';
let verifyRan = false;
try {
  dump = execFileSync(dsh, ['--profile', profile, '--dump-config'], {
    cwd: dshHome,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  verifyRan = true;
} catch (error) {
  const stderr = String(error.stderr ?? '');
  if (stderr.includes('parsePatchList') || stderr.includes('YAMLException')) {
    fail(`the patch was rejected by the loader at ${profilePatch}\n`
      + `  restore ${backup} and report this — the profile patch file was not valid YAML after the append\n`
      + `  loader stderr: ${stderr.split('\n')[0]}`);
  }
  console.error('warning: could not RUN the verification (`dsh --profile ' + profile + ' --dump-config`)');
  console.error(`  ${String(error.message).split('\n')[0]}`);
  console.error('  the patch was written; compose it manually or restart the profile and check the preset picker');
  process.exit(0);
}
if (!verifyRan || !dump.includes(rootPath)) {
  fail(`the patch was written but \`dsh --profile ${profile} --dump-config\` does not carry ${rootPath}\n`
    + `  restore ${backup} and report this — the profile may not have the roster row this patch targets`);
}

console.log('');
console.log('verified : the composed config carries the new root');
console.log('');
console.log('next steps');
console.log(`  1. restart the profile so the roster is composed with the new root`);
console.log(`     (a \`patchReload: live\` profile picks it up on the next start)`);
console.log(`  2. pick "Molecular Biology Lab" when creating a session`);
console.log(`  3. to upgrade later: dsh plugin --profile ${profile} update dsh-molbio-tools`);
console.log('     the root path above does not change, so nothing else needs re-running');
