/**
 * dsh-molbio-tools/preset/install.mjs
 *
 * Check that this package's "Molecular Biology Lab" preset is installed — and
 * clean up the leftovers from the mechanism DSH removed.
 *
 * WHAT CHANGED (read this before wondering why the script stopped writing)
 * ----------------------------------------------------------------------
 * On dsh <= 0.1.6 a preset was a FILE the harness discovered: an
 * `agent.cordis.yml` under `<dshHome>/.agent-presets`, or under a directory
 * registered through the `agent-presets` row's `config.roots`. This script used
 * to append exactly that `roots:` entry to the profile's `cordis.patch.yml`.
 *
 * dsh 0.1.7-alpha.1 removed `@deepseek-ai/dsh-agent-presets` and its whole
 * discovery mechanism. The replacement (`@deepseek-ai/dsh-agent-preset-registry`)
 * "neither scans directories nor accepts preset paths": a preset is now a
 * `@deepseek-ai/dsh-agent-preset` ROW inside a bundle patch. This package ships
 * one (`preset/molbio-lab/preset.patch.yml`, declared as the second entry of
 * `dsh.bundle.patch`), so the BUNDLE installs the preset:
 *
 *     dsh plugin --profile <name> add D:\path\to\dsh-molbio-tools
 *
 * That is now the ONLY step. There is nothing to patch into the profile, and
 * the old `roots:` entry does real harm on the new harness — its target row no
 * longer exists, so every compose reports:
 *
 *     patch: entry "agent-presets" not found
 *
 * This script therefore no longer writes anything. It reports whether the
 * preset is actually reachable, and points at the two leftovers that a
 * pre-0.1.7 install leaves behind.
 *
 * Usage:
 *   node preset/install.mjs [--profile <name>] [--dsh-home <path>] [--check]
 *
 *   --profile <name>   profile to inspect (default: web)
 *   --dsh-home <path>  harness home (default: $DSH_HOME, else ~/.dsh)
 *   --check            exit non-zero when the preset is NOT reachable
 */
import { existsSync, readFileSync } from 'node:fs';
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
const checkOnly = flag('check') === true;
const dshHomeFlag = flag('dsh-home');
const dshHome = resolve(
  typeof dshHomeFlag === 'string'
    ? dshHomeFlag
    : (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')),
);

const profileDir = join(dshHome, 'profiles', profile);
const profilePatch = join(profileDir, 'cordis.patch.yml');
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const packageName = manifest.name;

/** Problems that make the preset unreachable, and notes that merely inform. */
const problems = [];
const notes = [];

if (!existsSync(profileDir)) {
  problems.push(`no profile directory at ${profileDir}`);
} else if (!existsSync(join(profileDir, 'package.json'))) {
  problems.push(`${profileDir} has no package.json — is "${profile}" a profile?`);
}

// ── 1. is this package a selected bundle of the profile? ────────────────────
let bundles = [];
if (existsSync(join(profileDir, 'package.json'))) {
  try {
    bundles = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))?.dsh?.profile?.bundles ?? [];
  } catch (error) {
    problems.push(`cannot read the profile manifest: ${String(error.message)}`);
  }
}
const selected = bundles.some((name) => name === packageName || name.startsWith(`${packageName}@`));
if (!selected && problems.length === 0) {
  problems.push(`"${packageName}" is not in dsh.profile.bundles of "${profile}" — the bundle patch that `
    + `declares the preset is not composed, so the mode cannot appear.\n`
    + `  fix: dsh plugin --profile ${profile} add ${manifest.name}`);
}

// ── 2. the shipped preset patch must exist and declare the row ──────────────
const patchPath = join(here, 'molbio-lab', 'preset.patch.yml');
const sourcePath = join(here, 'molbio-lab', 'agent.cordis.yml');
if (!existsSync(patchPath)) {
  problems.push(`the preset patch is missing: ${patchPath}\n  fix: node build/preset-patch.mjs`);
} else {
  const text = readFileSync(patchPath, 'utf8');
  if (!text.includes("name: '@deepseek-ai/dsh-agent-preset'")) {
    problems.push(`${patchPath} does not declare a @deepseek-ai/dsh-agent-preset row`);
  }
  if (!/^\s*id:\s*molbio-lab\s*$/m.test(text)) {
    problems.push(`${patchPath} does not declare the molbio-lab preset id`);
  }
  // The tool row MUST name the PACKAGE. A relative `./plugins/…` specifier does
  // not resolve inside a preset on 0.1.7-alpha.1: the preset mounts, but its tool
  // entry is never imported and the mode loads zero tools.
  const toolRow = /- id:\s*tool-molbio\s*\n\s*name:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (toolRow === undefined) {
    problems.push(`${patchPath} carries no tool-molbio row`);
  } else if (toolRow !== `'${packageName}'` && toolRow !== packageName) {
    problems.push(`the tool-molbio row names ${toolRow}, but a preset row must name the PACKAGE `
      + `(${packageName}). A relative "./plugins/…" specifier never resolves inside a preset on `
      + `dsh 0.1.7-alpha.1 — the mode mounts and loads zero tools.\n`
      + '  fix: edit preset/molbio-lab/agent.cordis.yml, then: node build/preset-patch.mjs');
  }
  if (existsSync(sourcePath)) {
    notes.push(`row list    : ${sourcePath}`);
  }
}

// ── 3. leftovers from the mechanism 0.1.7-alpha.1 removed ───────────────────
if (existsSync(profilePatch)) {
  const patch = readFileSync(profilePatch, 'utf8');
  // The dead registration this very script used to write.
  if (/^\s*- id:\s*agent-presets\s*$/m.test(patch)) {
    notes.push(`STALE PATCH: ${profilePatch} still carries a "- id: agent-presets" entry, whose target row `
      + `no longer exists in dsh 0.1.7-alpha.1. It is harmless but noisy — every compose logs:\n`
      + `    patch: entry "agent-presets" not found\n`
      + '  fix: delete that entry (keep the rest of the file) and restart the profile.');
  }
}
const copiedPreset = join(dshHome, '.agent-presets', 'molbio-lab');
if (existsSync(copiedPreset)) {
  notes.push(`DEAD COPY: ${copiedPreset} is a preset directory from the removed discovery mechanism. `
    + 'dsh 0.1.7-alpha.1 does not read it, so it is frozen at whatever release it was copied from.\n'
    + '  fix: reselect the bundle (see below) and delete this directory — the bundle carries the preset now.');
}

// ── report ─────────────────────────────────────────────────────────────────
console.log(`package : ${manifest.name}@${manifest.version}`);
console.log(`profile : ${profile} (${profileDir})`);
console.log(`preset  : ${patchPath}`);
console.log('');

for (const note of notes) console.log(`note: ${note}`);
if (notes.length > 0) console.log('');

if (problems.length === 0) {
  console.log('OK: the preset ships with the bundle — the mode is registered when the profile composes.');
  console.log(`    next: restart the profile and pick "Molecular Biology Lab" when creating a session.`);
  // Compose the tree for real when `dsh` is on PATH; a sandbox that refuses
  // piped child stdio is reported as "could not verify", never as a failure.
  if (!checkOnly) {
    try {
      const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
      const dump = execFileSync(dsh, ['--profile', profile, '--dump-config'], {
        cwd: dshHome,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      if (dump.includes('preset-molbio-lab')) {
        console.log('verified: the composed config carries the preset-molbio-lab row');
      } else {
        console.log('WARNING: the composed config does NOT carry preset-molbio-lab.');
        console.log('  the bundle is selected but its preset patch did not compose — reinstall the bundle');
        console.log(`  (dsh plugin --profile ${profile} update ${manifest.name}) and report this.`);
        process.exit(1);
      }
    } catch (error) {
      console.log(`could not verify by composing (${String(error.message).split('\n')[0]})`);
      console.log('  the preset may still be fine — check the picker after restarting the profile.');
    }
  }
  process.exit(0);
}

for (const problem of problems) console.error(`problem: ${problem}`);
process.exit(1);
