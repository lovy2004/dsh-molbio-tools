/**
 * dsh-molbio-tools/build/client-bundle.mjs
 *
 * Build the browser half of this package: the molbio computation modules plus
 * the panel components, emitted as the lazy-CJS bundle format the DSH Web
 * client's module loader expects.
 *
 * The generator itself lives in `build/client-bundle-core.mjs` (so
 * `test/contract.mjs` can recompute the expected artifact in process and
 * compare it with the committed one — see that file's header). This CLI is the
 * I/O half: read each target's manifest, render its artifact, write it.
 *
 * Output format (fully specified by the loader):
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
 * Usage: node build/client-bundle.mjs
 *        node build/client-bundle.mjs --check   # report staleness, write nothing
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGenerator } from './client-bundle-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const checkOnly = process.argv.slice(2).includes('--check');

/**
 * The bundles to emit. The SAME browser half ships through two channels:
 *
 * - `dsh-molbio-tools` — the plugin package: one install gives the 52 tools
 *   plus the panel (its host half also registers the tools).
 * - `dsh-molbio-panel` — a panel-only package: installing it adds the tab to a
 *   profile WITHOUT dragging the tools into every session of that profile,
 *   which is what a shared Web profile wants.
 *
 * Both artifacts are built from the same sources in one run, so they cannot
 * drift; only the registration `id` (the package name the loader keys on) and
 * the output path differ.
 */
const TARGETS = [
  { packageRoot, label: 'tools + panel' },
  { packageRoot: join(packageRoot, 'packages', 'molbio-panel'), label: 'panel only' },
];

/** Entry module: the panel's apply/inject face. */
const ENTRY = join(here, 'client-entry.mjs');

// Module ids are relative to the PLUGIN package root for both targets, so the
// two artifacts differ only in the registration id.
const generator = await createGenerator({ entry: ENTRY, baseDir: packageRoot });

const written = [];
for (const target of TARGETS) {
  const manifest = JSON.parse(await readFile(join(target.packageRoot, 'package.json'), 'utf8'));
  const declaration = manifest.dsh?.client;
  if (declaration === undefined) {
    console.warn(`skipped ${manifest.name}: no dsh.client declaration (the row would never be scanned)`);
    continue;
  }
  const clientRel = typeof manifest.exports?.['./client'] === 'string'
    ? manifest.exports['./client']
    : manifest.exports?.['./client']?.default;
  if (typeof clientRel !== 'string') {
    console.warn(`skipped ${manifest.name}: no exports["./client"] string`);
    continue;
  }
  const output = join(target.packageRoot, clientRel);
  const { text, externalSpecifiers } = generator.renderBundle(manifest.name);
  const previous = existsSync(output) ? await readFile(output, 'utf8') : undefined;
  if (checkOnly) {
    // Compare CONTENT, not bytes. The generator emits LF; a checkout on Windows
    // with `core.autocrlf=true` materializes the artifact with CRLF, so a raw
    // `previous === text` reports a stale bundle for a file that is byte-for-byte
    // the same content — and the check that guards the panel against shipping
    // stale code then cries wolf on every Windows checkout, which is how a real
    // staleness signal gets ignored. Line endings are not what this guards.
    const normalize = (value) => (value === undefined ? undefined : value.replace(/\r\n/g, '\n'));
    const state = normalize(previous) === normalize(text) ? 'up to date' : previous === undefined ? 'MISSING' : 'STALE';
    if (state !== 'up to date') process.exitCode = 1;
    console.log(`client bundle ${state}: ${output.replace(packageRoot, '.')} (${(text.length / 1024).toFixed(1)} KB) — ${target.label}`);
    continue;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text, 'utf8');
  written.push({
    manifest,
    output,
    text,
    externalSpecifiers,
    label: target.label,
    changed: (previous ?? '').replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n'),
  });
}

if (checkOnly) {
  console.log(`modules    : ${generator.order.length} (${generator.ids.join(', ')})`);
  if (process.exitCode === 1) {
    console.error('client bundle --check FAILED: a committed artifact does not match its sources — run `node build/client-bundle.mjs`');
  }
} else {
  for (const { manifest, output, text, externalSpecifiers, label, changed } of written) {
    console.log(`client bundle written: ${output.replace(packageRoot, '.')} (${(text.length / 1024).toFixed(1)} KB) — ${label}${changed ? '' : ' [unchanged]'}`);
    console.log(`  package id : ${manifest.name}`);
    console.log(`  externals  : ${[...externalSpecifiers].join(', ') || '(none)'}`);
  }
  console.log(`modules    : ${generator.order.length} (${generator.ids.join(', ')})`);
}
