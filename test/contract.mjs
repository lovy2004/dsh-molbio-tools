/**
 * dsh-molbio-tools/test/contract.mjs
 *
 * The panel's contract with the HOST framework and its client packages.
 *
 * The other client tests cover what this repository controls: the artifact
 * format (`client.mjs`), the data path, the components (`panel-render.mjs`),
 * and the boot-graph mount (`client-mount.mjs`). None of them notices when DSH
 * changes something the panel RELIES on — and that is exactly how the preset
 * broke on 0.1.5-alpha.2 (a plugin's Config contract moved and the composition
 * stopped loading, with every test still green).
 *
 * This file pins the runtime contract by reading the INSTALLED harness:
 *
 *   1. the hook-prop naming rule (`standardHookPropName`) in the shell bundle,
 *      which is what turns the root hook `sessions` into the `useSessions` prop
 *      the panel body destructures;
 *   2. the tab-body props and services the shipped packages already use for the
 *      same seats — `sessionId`, `useSessions`, `ctx.remote.workspaceFiles`;
 *   3. the `workspaceFiles` methods the panel calls, in BOTH the host Remote and
 *      the client-side call sites;
 *   4. this package's own bundle: the exact registrations and calls it makes.
 *
 * A failure here means "DSH moved something the panel depends on", and the fix
 * is a panel change — not a test change. Assertions therefore look for the
 * CONTRACT (a rule, a call, a service name), never for incidental formatting.
 *
 * Usage: node test/contract.mjs [--dsh <harness root>]
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const argv = process.argv.slice(2);
const dshFlag = argv.indexOf('--dsh');
const harnessRoot = dshFlag === -1
  ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  : argv[dshFlag + 1];
const packagesDir = join(harnessRoot, 'node_modules', '@deepseek-ai');

assert.ok(existsSync(packagesDir), `the harness packages must be installed at ${packagesDir}`);
console.log(`harness : ${harnessRoot}`);

/**
 * Locate an installed @deepseek-ai package. The harness keeps some packages in
 * its own nested `node_modules` and others one level up, so ask both.
 */
function packageDir(pkg) {
  for (const base of [join(harnessRoot, 'node_modules'), dirname(harnessRoot)]) {
    const candidate = join(base, ...pkg.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return join(harnessRoot, 'node_modules', ...pkg.split('/'));
}

/** Read one installed client bundle, or undefined when the package is absent. */
function clientBundle(pkg) {
  const path = join(packageDir(pkg), 'lib', 'client.js');
  return existsSync(path) ? { path, text: readFileSync(path, 'utf8') } : undefined;
}

/** Read one installed host half, or undefined. */
function hostHalf(pkg) {
  const path = join(packageDir(pkg), 'lib', 'index.js');
  return existsSync(path) ? { path, text: readFileSync(path, 'utf8') } : undefined;
}

/** Every file under a directory, bounded (the shell bundle ships under dist/). */
function filesUnder(dir, limit = 400) {
  const out = [];
  const walk = (current) => {
    if (out.length >= limit) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

// ── 1. the hook-prop naming rule ────────────────────────────────────────────

check('the shell derives hook props as use<Capitalised(Source)>', () => {
  const shellDir = join(packagesDir, 'dsh-web-frontend', 'dist');
  assert.ok(existsSync(shellDir), 'the web shell bundle is installed (the rule lives in it, not in a package)');
  let found = false;
  for (const path of filesUnder(shellDir)) {
    if (!path.endsWith('.js')) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes('standardHookPropName')) continue;
    // The rule itself, in the shell's minified shape: `use${x[0]?.toUpperCase()??""}${x.slice(1)}`.
    const rule = /function \w+\((\w)\)\{return`use\$\{\1\[0\]\?\.toUpperCase\(\)\?\?""\}\$\{\1\.slice\(1\)\}`\}/.exec(text);
    assert.ok(rule !== null, `the use<Name> rule is still implemented in ${path}`);
    assert.ok(text.includes('standardHookPropName'), 'the rule is still exported under its stable name');
    found = true;
    break;
  }
  assert.ok(found, 'standardHookPropName was found in the installed shell bundle');
});

// ── 2. the props and services the shipped packages use for these seats ──────

check('a session-scope tab body receives sessionId + useSessions (official precedent)', () => {
  const files = clientBundle('@deepseek-ai/dsh-client-ui-sidebar-files');
  assert.ok(files !== undefined, 'ui-sidebar-files is installed');
  assert.ok(files.text.includes('function FilesBody({ useTabInfo, sessionId'), 'the official tab body destructures sessionId from its props');
  assert.ok(files.text.includes('useSessions((sessions) => sessions.byId[sessionId]?.cwd)'), 'and reads the workspace root exactly as the panel does');
  assert.ok(files.text.includes('"slots"') && files.text.includes('"sidebarRightTabs"'), 'and injects the same registries');
});

check('the sessions root hook is provided by the session client package', () => {
  const session = clientBundle('@deepseek-ai/dsh-client-ui-session');
  assert.ok(session !== undefined, 'ui-session is installed');
  assert.ok(session.text.includes('ctx.slots.provideRoot({ hooks: {'), 'it contributes root hooks');
  assert.ok(/provideRoot\(\{\s*hooks:\s*\{\s*sessions:/.test(session.text), 'the root hook source is named `sessions`');
  // `sessions` -> `useSessions` under the rule asserted above.
  assert.ok(session.text.includes('installScope("session"'), 'and installs the session scope those props belong to');
});

// ── 3. the workspaceFiles methods the panel calls ───────────────────────────

check('workspaceFiles exposes list / readAll / read on the host Remote', () => {
  const host = hostHalf('@deepseek-ai/dsh-api-workspace-files');
  assert.ok(host !== undefined, 'api-workspace-files is installed');
  for (const method of ['async list(', 'async readAll(', 'async read(']) {
    assert.ok(host.text.includes(method), `the host Remote implements ${method.trim()}`);
  }
  assert.ok(host.text.includes('workspace-file/not-found'), 'the wire still carries the not-found code the empty-library state keys on');
  assert.ok(host.text.includes('toString("base64")'), 'readAll still answers base64 bytes (the panel decodes exactly that)');
});

check('official client packages call the same workspaceFiles methods', () => {
  const files = clientBundle('@deepseek-ai/dsh-client-ui-sidebar-files');
  assert.ok(files.text.includes('remote.workspaceFiles.list(sessionId, path, signal)'), 'ui-sidebar-files calls list(sessionId, path, signal)');
  const docPreview = clientBundle('@deepseek-ai/dsh-client-ui-sidebar-documentpreview');
  if (docPreview !== undefined) {
    const usesRead = /workspaceFiles\.read(All|Bytes)?\(/.exec(docPreview.text);
    assert.ok(usesRead !== null, 'ui-sidebar-documentpreview reads through the same namespace');
  }
});

// ── 4. this package's own side of the contract ──────────────────────────────

check('the built bundle registers the seats and services the framework expects', () => {
  const bundlePath = join(packageRoot, 'lib', 'client.js');
  assert.ok(existsSync(bundlePath), 'the client artifact exists (run npm run build:client)');
  const bundle = readFileSync(bundlePath, 'utf8');

  // Registries: the same three the official tab packages inject. The bundle
  // exports the list as identifiers (`exports.inject = inject`), so match the
  // declaration itself rather than quoted JSON.
  const declaration = /const inject = \[([^\]]*)\]/.exec(bundle);
  assert.ok(declaration !== null, 'the bundle declares its inject list');
  const declared = declaration[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
  assert.deepEqual(declared, ['slots', 'sidebarRightTabs', 'remote'], 'and injects the same three services ui-sidebar-files does');

  // Seats: both page types register a body and a title in the keyed seats.
  // The bundle is generated from sources that spell seats with single quotes.
  for (const seat of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    assert.ok(bundle.includes(seat), `the bundle registers into ${seat}`);
  }
  assert.ok(bundle.includes('sidebarRightTabs.register'), 'the bundle registers its tab types');

  // The panel's own reads, with the argument order the host Remote declares.
  assert.ok(/workspaceFiles\.readAll\(scope, path, signal\)/.test(bundle), 'the panel calls readAll(scope, path, signal)');
  assert.ok(/workspaceFiles\.read\(\{ sessionId \}, path, undefined, signal\)/.test(bundle), 'the panel calls read({sessionId}, path, …)');
  assert.ok(/workspaceFiles\.list\(\{ sessionId \}, path, signal\)/.test(bundle), 'the panel calls list({sessionId}, path, signal)');

  // The props the body reads must be the ones the rule produces.
  assert.ok(/function MolbioPanel\(\{ sessionId, remote, useSessions \}\)/.test(bundle), 'the body destructures sessionId / remote / useSessions');
  assert.ok(/function PapersPanel\(\{ sessionId, remote, useSessions \}\)/.test(bundle), 'the papers body does too');
  assert.ok(bundle.includes('useSessions((sessions) => sessions.byId[sessionId]?.cwd)'), 'and reads the workspace root from useSessions');
  // The inject factory must hand over exactly the services the framework does
  // NOT provide, so it can never shadow sessionId or a synthesised hook.
  assert.ok(/inject: \(\) => \(\{ remote \}\)/.test(bundle), 'the body injects only the Remote face');
});

check('the package manifest keeps the client declaration the scan keys on', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.client.platform, 'web', 'dsh.client.platform is web');
  const clientRel = typeof manifest.exports['./client'] === 'string' ? manifest.exports['./client'] : manifest.exports['./client'].default;
  assert.equal(clientRel, './lib/client.js', 'exports["./client"] points at the artifact');
  assert.ok(existsSync(join(packageRoot, clientRel)), 'the artifact exists');

  // An injected client package must be a boot-graph row — either mounted with
  // its own bundle on disk, or seeded into the shell (sidebar-right and slots
  // ship inside the Web frontend, so they have no `lib/client.js` to find here).
  const shellDir = join(packagesDir, 'dsh-web-frontend', 'dist');
  const shellText = existsSync(shellDir)
    ? filesUnder(shellDir).filter((path) => path.endsWith('.js')).map((path) => readFileSync(path, 'utf8')).join('\n')
    : '';
  for (const dependency of manifest.dsh.client.inject) {
    const dir = packageDir(dependency);
    const mounted = existsSync(join(dir, 'lib', 'client.js'));
    const seeded = shellText.includes(`require("${dependency}")`) || shellText.includes(`require('${dependency}')`);
    assert.ok(mounted || seeded, `${dependency} is either a mounted client package or seeded into the shell`);
    assert.ok(existsSync(join(dir, 'package.json')) || seeded, `${dependency} resolves as a package or comes from the shell`);
  }

  // The panel-only package must carry the same declaration: it is the channel a
  // shared profile installs.
  const panelManifestPath = join(packageRoot, 'packages', 'molbio-panel', 'package.json');
  if (existsSync(panelManifestPath)) {
    const panel = JSON.parse(readFileSync(panelManifestPath, 'utf8'));
    assert.equal(panel.dsh.client.platform, 'web', 'the panel-only package declares the same platform');
    assert.deepEqual(panel.dsh.client.inject, manifest.dsh.client.inject, 'and injects the same client packages');
    const panelClient = join(packageRoot, 'packages', 'molbio-panel', typeof panel.exports['./client'] === 'string' ? panel.exports['./client'] : panel.exports['./client'].default);
    assert.ok(existsSync(panelClient), 'its artifact exists');
    assert.ok(statSync(panelClient).size > 1000, 'and is a real bundle, not a stub');
  }
});

check('the published tarball would carry the client half and the panel package', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const files = manifest.files ?? [];
  assert.ok(Array.isArray(files) && files.length > 0, 'the manifest declares a files allowlist (npm would otherwise ship everything)');

  // npm ships exactly the allowlist, so a missing entry is a package that
  // installs WITHOUT the thing it declares. `dsh plugin add` resolves the client
  // bundle from the installed package, so a missing lib/ or packages/ makes the
  // panel silently absent for every npm user — and no other test would notice.
  for (const entry of ['index.mjs', 'lib', 'build', 'packages', 'preset', 'cordis.patch.yml']) {
    assert.ok(files.includes(entry), `the files allowlist carries ${entry}`);
    assert.ok(existsSync(join(packageRoot, entry)), `and ${entry} exists on disk`);
  }
  assert.ok(existsSync(join(packageRoot, 'lib', 'client.js')), 'the client artifact is inside an allowlisted directory');
  const panelRoot = join(packageRoot, 'packages', 'molbio-panel');
  if (existsSync(panelRoot)) {
    for (const entry of ['package.json', 'index.mjs', 'cordis.patch.yml', 'lib/client.js']) {
      assert.ok(existsSync(join(panelRoot, entry)), `packages/molbio-panel/${entry} exists`);
    }
  }
});

check('the toolview card contract still holds (meta path + keyed seat)', () => {
  // The card reads the tool-result block's `meta`, which the tool layer fills
  // from a tool's `output.presentationMeta` — for a ROOT call only.
  const tools = hostHalf('@deepseek-ai/dsh-tools');
  assert.ok(tools !== undefined, 'dsh-tools is installed');
  assert.ok(/output\.presentationMeta\s*!==\s*void 0/.test(tools.text), 'the tool layer still consults output.presentationMeta');
  assert.ok(tools.text.includes('exec.parent === void 0'), 'and calls it for root calls');
  assert.ok(tools.text.includes('snapshotProjection(tool.name, "presentationMeta"'), 'and records the projection on the result');
  assert.ok(/output \{ schema, render, presentationMeta\? \}/.test(tools.text), 'register() accepts presentationMeta on a raw output');

  // The browser side: the seat exists and is keyed by tool name.
  const toolUi = clientBundle('@deepseek-ai/dsh-client-ui-tool');
  assert.ok(toolUi !== undefined, 'ui-tool is installed');
  assert.ok(toolUi.text.includes('tool.call.toolview'), 'the toolview seat is still declared');
  const card = clientBundle('@deepseek-ai/dsh-client-ui-deliverables');
  assert.ok(card !== undefined && card.text.includes('tool.call.toolview'), 'a shipped package still registers a toolview');
  assert.ok(/key:\s*"present"/.test(card.text), 'keyed by the tool name');

  // This package's own side: the projection exists on both map tools, and the
  // bundle claims both keys (through the loop over MAP_TOOL_KEYS, so assert the
  // key list and the seat, not a literal registration).
  const source = readFileSync(join(packageRoot, 'index.mjs'), 'utf8');
  assert.equal((source.match(/presentationMeta\(_args, value\)/g) ?? []).length, 2, 'both map tools declare the projection');
  assert.ok(source.includes('mapCardMeta'), 'and build it through the shared projection');
  const bundle = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
  const keys = /const MAP_TOOL_KEYS = \[([^\]]*)\]/.exec(bundle);
  assert.ok(keys !== null, 'the bundle declares the tool keys whose cards it draws');
  const claimed = keys[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter((entry) => entry !== '');
  for (const key of ['molbio_plasmid_map', 'molbio_plasmid_map_file']) {
    assert.ok(claimed.includes(key), `${key} is among the claimed card keys`);
    // The host half registers a tool under that exact name.
    assert.ok(source.includes(`name: '${key}'`), `and the host registers the tool ${key}`);
  }
  assert.ok(bundle.includes('tool.call.toolview'), 'through the toolview seat');
});

check('every seat claim waits for the declaration (slots.inject, not a bare register)', () => {
  // The shell's SlotCore refuses `register()` for a seat no entry has DECLARED
  // yet — "a parent entry's children table must declare it" — and that refusal
  // thrown inside apply() fails the plugin's LOADER entry. v0.7.1 shipped a
  // bare register for `tool.call.toolview`, whose seat is a CHILD of ui-tool's
  // `conversation.chat.node` entry, so the Web GUI refused to boot.
  const shellDir = join(packagesDir, 'dsh-web-frontend', 'dist');
  let guard = false;
  for (const path of filesUnder(shellDir)) {
    if (!path.endsWith('.js')) continue;
    if (readFileSync(path, 'utf8').includes("is not declared (a parent entry's children table must declare it)")) guard = true;
  }
  assert.ok(guard, 'the shell still refuses a registration for an undeclared seat');

  const renderer = clientBundle('@deepseek-ai/dsh-client-ui-renderer');
  assert.ok(renderer !== undefined, 'ui-renderer is installed (it owns the client slots service)');
  assert.ok(renderer.text.includes('inject(key, callback)'), 'the slots service still exposes inject(key, callback)');
  assert.ok(renderer.text.includes('this._core.specDynamic(key)'), 'and runs the callback only once the seat is declared');

  // The shipped packages claim our very seats this way.
  const toolUi = clientBundle('@deepseek-ai/dsh-client-ui-tool');
  assert.ok(/slots\.inject\(\s*"tool\.call\.toolview"/.test(toolUi.text), 'ui-tool waits for tool.call.toolview');
  const preview = clientBundle('@deepseek-ai/dsh-client-ui-sidebar-documentpreview');
  if (preview !== undefined) {
    assert.ok(/slots\.inject\(\s*"sidebar\.right\.pane\.tab"/.test(preview.text), 'the document preview waits for the tab seat');
  }

  // Our artifact: every `register` must sit inside a wait for that same seat.
  const bundle = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
  const waited = [...bundle.matchAll(/slots\.inject\('([^']+)', \(\) => (?:ctx\.)?slots\.register\(\{\s*name: '([^']+)'/g)];
  assert.ok(waited.length > 0, 'the bundle claims its seats through slots.inject');
  for (const [, seat, name] of waited) assert.equal(seat, name, `the claim of ${name} waits for the seat it registers into`);
  const registers = (bundle.match(/(?:ctx\.)?slots\.register\(/g) ?? []).length;
  assert.equal(registers, waited.length, 'and no registration exists outside such a wait');
});

check('the committed client artifact is what the current sources build (no stale bundle)', async () => {
  // The trap this closes: edit build/*.mjs, forget `npm run build:client`, and
  // every test that runs against the artifact passes while users keep loading
  // the OLD behaviour — or, worse, a source fix that never reached the bundle.
  // The bundle is deterministic, so rebuild-and-compare IS the check.
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const artifacts = ['lib/client.js', join('packages', 'molbio-panel', 'lib', 'client.js')]
    .filter((rel) => existsSync(join(packageRoot, rel)));
  assert.ok(artifacts.length > 0, 'at least one client artifact exists');
  const hashOf = (rel) => createHash('sha256').update(readFileSync(join(packageRoot, rel))).digest('hex');
  const before = new Map(artifacts.map((rel) => [rel, hashOf(rel)]));

  const build = spawnSync(process.execPath, [join(packageRoot, 'build', 'client-bundle.mjs')], { cwd: packageRoot, encoding: 'utf8' });
  // A null status with an error means the spawn itself never ran the child (a
  // confined sandbox refuses piped stdio: EPERM). The generic "the bundler runs
  // cleanly" message is misleading there — say what actually happened, and how
  // to verify freshness by hand.
  if (build.status === null && build.error != null) {
    assert.fail(`could not spawn the bundler (${build.error.message.split('\n')[0]}); verify freshness by hand: \`node build/client-bundle.mjs && git diff --stat lib packages\``);
  }
  assert.equal(build.status, 0, `the bundler runs cleanly (stderr: ${String(build.stderr ?? '').split('\n')[0]})`);

  for (const rel of artifacts) {
    assert.equal(
      hashOf(rel),
      before.get(rel),
      `${rel} is stale: the sources build a different artifact than the committed one — run \`npm run build:client\` and commit the result`,
    );
  }
});

// ── run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${String(error?.message ?? error).split('\n')[0]}`);
  }
}
console.log('');
if (failed > 0) {
  console.error(`contract checks FAILED: ${failed}/${checks.length} — DSH moved something the panel depends on`);
  process.exit(1);
}
console.log(`contract checks passed: ${checks.length} — the panel's host contract is intact`);
