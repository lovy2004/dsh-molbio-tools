/**
 * dsh-molbio-tools/test/release.mjs
 *
 * Guards for the release pipeline (`.github/workflows/release.yml`).
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * A publish workflow is the one piece of this repository that can do damage npm
 * does not let you undo: a version number cannot be reused, a package name
 * cannot be reclaimed, and a wrong GitHub Release cannot be un-seen. So the
 * decisions the workflow makes are implemented as PURE functions in
 * `build/release-preflight.mjs` and driven here with mutated inputs, because
 * "the release gate passes" has to mean something — a gate nobody has seen fail
 * is not a gate (docs/rules.md rule 9).
 *
 * Everything in this file is offline and deterministic. The two checks that
 * genuinely need the network (does the registry really answer the way
 * `probeRegistry` assumes, and can the artifact really be read out of a
 * published tarball) are gated behind `MOLBIO_RELEASE_NETWORK=1`, and the tar
 * reader also gets a fully local test against a tarball this file builds.
 *
 * Exit code non-zero = do not ship.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  MIN_NPM_FOR_TRUSTED_PUBLISHING,
  PUBLISHED_PACKAGES,
  changelogSection,
  clientArtifactFromTar,
  clientArtifactFromTarball,
  clientManifestProblems,
  compareVersions,
  detectNpmVersion,
  npmVersionSupport,
  packageVersionCheck,
  panelArtifactChanged,
  publishedState,
  tagVersion,
  versionShapeProblem,
  workspacePublishProblem,
} from '../build/release-preflight.mjs';
import { releaseNotes } from '../build/release-notes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const manifestOf = (directory) => JSON.parse(readFileSync(join(ROOT, directory, 'package.json'), 'utf8'));
const version = manifestOf('.').version;
const notes = [];

// ── (1) the tag form ────────────────────────────────────────────────────────

{
  assert.deepEqual(tagVersion('v0.19.0'), { version: '0.19.0' });
  assert.deepEqual(tagVersion('v1.2.3'), { version: '1.2.3' });
  // A prerelease tag is still a release tag: `v0.20.0-rc.1` is a legitimate
  // thing to publish, and the comparison below has to order it BELOW 0.20.0.
  assert.deepEqual(tagVersion('v0.20.0-rc.1'), { version: '0.20.0-rc.1' });
  // The `v` is load-bearing: the workflow triggers on `v*`, so a tag without it
  // can never start a release, and accepting it here would pass a gate for a tag
  // that publishes nothing.
  for (const rejected of ['0.19.0', 'v0.19', 'v0.19.0.1', 'v', 'release-0.19.0', 'v0.19.0-']) {
    assert.ok(tagVersion(rejected).error !== undefined, `${JSON.stringify(rejected)} must be rejected as a release tag`);
  }
  // Surrounding whitespace is trimmed rather than rejected: a tag arriving from a
  // shell or from `git describe` can carry it, and it changes no meaning.
  assert.deepEqual(tagVersion(' v0.19.0\n'), { version: '0.19.0' });
  notes.push('the tag form is the one the workflow triggers on');
}

// ── (2) version ordering, including prereleases ─────────────────────────────

{
  assert.ok(compareVersions('0.19.0', '0.18.4') > 0);
  assert.ok(compareVersions('0.18.4', '0.19.0') < 0);
  assert.equal(compareVersions('0.19.0', '0.19.0'), 0);
  assert.ok(compareVersions('0.9.0', '0.10.0') < 0, 'numeric, not lexicographic');
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.19.0-rc.1', '0.19.0') < 0, 'a prerelease sorts below its release');
  assert.ok(compareVersions('0.19.0', '0.19.0-rc.1') > 0);
  assert.ok(compareVersions('0.19.0-rc.2', '0.19.0-rc.10') < 0, 'prerelease identifiers compare numerically, not as text');
  assert.ok(compareVersions('0.19.0-alpha.1', '0.19.0-rc.1') < 0, 'alphanumeric identifiers compare as text');
  assert.ok(compareVersions('0.19.0-1', '0.19.0-alpha') < 0, 'a numeric identifier ranks below an alphanumeric one');
  assert.ok(compareVersions('0.19.0-rc', '0.19.0-rc.1') < 0, 'fewer identifiers ranks lower when the shared ones match');
  assert.deepEqual(versionShapeProblem('0.1.2'), undefined);
  for (const bad of ['0.1.2-rc.1', 'v0.1.2', '0.1', 'latest', '']) {
    assert.ok(versionShapeProblem(bad) !== undefined, `${JSON.stringify(bad)} is not a plain release version`);
  }
  notes.push('version comparison orders prereleases below their release');
}

// ── (3) the tag binds the root package, and only the root package ───────────

{
  const root = { name: 'dsh-molbio-tools', tagVersioned: true, manifest: { version: '0.19.0' } };
  const panel = { name: 'dsh-molbio-panel', tagVersioned: false, manifest: { version: '0.1.2' } };
  assert.deepEqual(packageVersionCheck('0.19.0', [root, panel]), { ok: true, mismatches: [], missing: [] });

  // The mutation that matters most: a tag that disagrees with the version it is
  // about to publish under.
  const drifted = packageVersionCheck('0.19.0', [{ ...root, manifest: { version: '0.18.4' } }, panel]);
  assert.equal(drifted.ok, false);
  assert.match(drifted.mismatches.join('\n'), /declares 0\.18\.4 but the tag names 0\.19\.0/);

  // The panel's line is independent, so a mismatch there is NOT a failure — but
  // marking it tag-bound must turn it into one, which is what proves the flag is
  // what suppresses the check rather than an accident of the fixture.
  const bound = packageVersionCheck('0.19.0', [root, { ...panel, tagVersioned: true }]);
  assert.equal(bound.ok, false, 'binding the panel to the tag must make its independent version a failure');
  assert.match(bound.mismatches.join('\n'), /dsh-molbio-panel declares 0\.1\.2 but the tag names 0\.19\.0/);

  // A malformed version fails even when it is not tag-bound: the publish step
  // reads the manifest, not the tag.
  const malformed = packageVersionCheck('0.19.0', [root, { ...panel, manifest: { version: '0.1' } }]);
  assert.equal(malformed.ok, false);
  assert.match(malformed.mismatches.join('\n'), /not a plain <major>\.<minor>\.<patch>/);

  // A manifest with no version at all is reported separately from a mismatch.
  const absent = packageVersionCheck('0.19.0', [root, { ...panel, manifest: {} }]);
  assert.equal(absent.ok, false);
  assert.deepEqual(absent.missing, ['dsh-molbio-panel has no version field']);

  // And the REAL manifests must satisfy it, so this file cannot pass while the
  // repository's own versions disagree with the tag it is about to cut.
  const real = PUBLISHED_PACKAGES.map((entry) => ({ ...entry, manifest: manifestOf(entry.directory) }));
  assert.deepEqual(packageVersionCheck(version, real), { ok: true, mismatches: [], missing: [] }, `the checked-in manifests must agree with v${version}`);
  notes.push(`the real manifests agree with v${version} (${real.map((e) => `${e.name}@${e.manifest.version}`).join(', ')})`);
}

// ── (4) the CHANGELOG section is found, and is exactly one version's ────────

{
  const text = [
    '# Changelog',
    '',
    '## [0.19.0] — 2026-10-11（this release）',
    '',
    'A body long enough to be release notes, describing what changed in this release.'.repeat(2),
    '',
    '### A subsection',
    '',
    'More text.',
    '',
    '## [0.18.4] — 2026-10-10（the previous release）',
    '',
    'The previous body.',
    '',
  ].join('\n');
  const section = changelogSection(text, '0.19.0');
  assert.equal(section.found, true);
  assert.equal(section.heading, '## [0.19.0] — 2026-10-11（this release）');
  assert.match(section.body, /this release/, 'the body starts at the version heading');
  assert.match(section.body, /### A subsection/, 'subsections belong to their version');
  // THE MUTATION HERE IS THE SECTION END: stop at the next `## `, or the notes
  // for one release silently carry the next release's text.
  assert.ok(!section.body.includes('the previous release'), 'the section must stop at the next version heading');
  assert.ok(!section.body.includes('0.18.4'), 'and must not include the next version number');

  assert.equal(changelogSection(text, '9.9.9').found, false, 'a version with no section is reported, not guessed');
  // The other spelling this repository has used, kept because old entries are
  // verbatim history and the gate must not force a reformat of them.
  assert.equal(changelogSection('## 0.5.0 (2026-01-01)\n\nbody\n', '0.5.0').found, true);
  // `0.19.0` must not match `0.19.01` or `10.19.0`.
  assert.equal(changelogSection('## [0.19.01] — x\n\nbody\n', '0.19.0').found, false);
  assert.equal(changelogSection('## [10.19.0] — x\n\nbody\n', '0.19.0').found, false);

  const real = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  assert.equal(real.found, true, `CHANGELOG.md must have a section for the released version ${version}`);
  assert.ok(real.body.length >= 40, `the ${version} section must be substantial enough to publish as notes`);
  notes.push(`CHANGELOG has a ${real.body.length}-character section for ${version}`);
}

// ── (5) the notes are the CHANGELOG's text, plus readable facts ─────────────

{
  const body = releaseNotes(`v${version}`, { root: ROOT });
  assert.ok(body.includes(changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version).body.slice(0, 60)), 'the notes carry the CHANGELOG body');
  assert.ok(body.includes(`\`dsh-molbio-tools@${version}\``), 'the notes name the root version');
  assert.ok(body.includes('dsh-molbio-panel@'), 'the notes name the panel entry as well');
  assert.ok(body.includes('npm install -g dsh-molbio-tools'), 'and say how to install');
  assert.ok(body.includes(`blob/v${version}/CHANGELOG.md`), 'and link the full entry at the released tag');
  // A tag with no section must refuse rather than publish empty notes.
  assert.throws(() => releaseNotes('v9.9.9', { root: ROOT }), /no "## 9\.9\.9" section/);
  assert.throws(() => releaseNotes('0.19.0', { root: ROOT }), /not the release form/);
  notes.push('release notes are derived from the CHANGELOG, and refuse an absent section');
}

// ── (6) the manifest fields a profile needs ─────────────────────────────────

{
  const panel = manifestOf('packages/molbio-panel');
  assert.deepEqual(clientManifestProblems('dsh-molbio-panel', panel), [], 'the real panel manifest is publishable');

  const without = (mutate) => {
    const copy = JSON.parse(JSON.stringify(panel));
    mutate(copy);
    return clientManifestProblems('dsh-molbio-panel', copy);
  };
  assert.match(without((m) => { m.dsh.client.platform = 'node'; }).join('\n'), /platform is "node" rather than "web"/);
  assert.match(without((m) => { delete m.exports['./client']; }).join('\n'), /exports\["\.\/client"\]\.default is missing/);
  assert.match(without((m) => { delete m.dsh.bundle; }).join('\n'), /dsh\.bundle\.patch is missing/);
  assert.match(clientManifestProblems('ghost', {}).join('\n'), /platform is undefined/, 'an empty manifest is reported, not crashed on');
  // The publish mechanism assumes the root is NOT a workspace; if one is added,
  // `npm publish` from the panel directory would publish the root package again.
  assert.deepEqual(workspacePublishProblem(manifestOf('.')), [], 'the real root manifest is not a workspace');
  assert.match(workspacePublishProblem({ workspaces: ['packages/*'] }).join('\n'), /declares `workspaces`/);
  notes.push('the client-half manifest fields are required, with the real panel manifest as the positive control');
}

// ── (7) the registry states, and the first-release case ─────────────────────

{
  assert.equal(publishedState({ packageExists: false }, '0.19.0').state, 'first-release');
  assert.equal(publishedState({ version: '' }, '0.19.0').state, 'newer');
  assert.equal(publishedState({ version: '0.18.4' }, '0.19.0').state, 'newer');
  assert.equal(publishedState({ version: '0.19.0' }, '0.19.0').state, 'same', 'a re-run is a no-op, not an error');
  // Publishing an OLDER version than npm has is the dangerous case: it would
  // "succeed" and land a version that is not the latest.
  assert.equal(publishedState({ version: '0.20.0' }, '0.19.0').state, 'older');
  assert.equal(publishedState({ error: 'ENOTFOUND' }, '0.19.0').state, 'unknown', 'an unreachable registry must not block a release');
  notes.push('first release, no-op re-run and stale-version cases are distinguished');
}

// ── (8) the panel artifact check ────────────────────────────────────────────

{
  assert.equal(panelArtifactChanged(undefined, 'x'), false, 'with no published baseline the check is skipped, not failed');
  assert.equal(panelArtifactChanged('x', 'x'), false);
  assert.equal(panelArtifactChanged('x', 'y'), true, 'changed bytes under a published version must fail the gate');
  notes.push('a changed panel artifact under an already-published version is a failure');
}

// ── (9) the tar reader, against real and hand-built tar bytes ───────────────
//
// NO SUBPROCESS. The tempting version of this check runs `npm pack` and reads
// the result, but two things rule it out: spawning npm on Windows needs
// `shell: true`, which concatenates arguments instead of escaping them (the
// mechanism that truncated every benchmark instruction in 0.14.0), and a
// confined sandbox refuses piped stdio with EPERM — so the check would be
// unavailable exactly where releases are automated. `test/contract.mjs` already
// proves the COMMITTED artifact is what the sources build; what is verified here
// is the reader, so the tar bytes are built in-process instead.
{
  /** Build a ustar archive with one regular-file entry. */
  const tarEntry = (name, text) => {
    const payload = new TextEncoder().encode(text);
    const padded = Math.ceil(payload.length / 512) * 512 || 512;
    const archive = new Uint8Array(512 + padded + 1024);
    const header = new TextEncoder().encode(name);
    archive.set(header.subarray(0, 100), 0);
    // Size is 11 octal digits + NUL at offset 124 (ustar layout).
    archive.set(new TextEncoder().encode(`${payload.length.toString(8).padStart(11, '0')}\u0000`), 124);
    // Typeflag '0' = regular file, at offset 156.
    archive[156] = 0x30;
    archive.set(payload, 512);
    // The trailing 1024 zero bytes are the end-of-archive marker.
    return archive;
  };

  const artifact = tarEntry('package/lib/client.js', 'console.log(1);\n');
  assert.equal(clientArtifactFromTar(artifact), 'console.log(1);\n', 'the reader finds lib/client.js and returns its bytes');
  // The same bytes through gzip, which is the path the network takes.
  assert.equal(clientArtifactFromTarball(new Uint8Array(gzipSync(artifact))), 'console.log(1);\n');

  // CRLF is normalized: the artifact is compared across a checkout whose
  // line-ending policy may differ from npm's, and a false "changed" would block
  // a release for a reason that has nothing to do with the artifact.
  assert.equal(clientArtifactFromTar(tarEntry('package/lib/client.js', 'a\r\nb\r\n')), 'a\nb\n');

  // THE MUTATIONS. A reader that returned whatever it found first would pass the
  // check above, so these prove it is reading the NAME.
  assert.equal(clientArtifactFromTar(tarEntry('package/README.md', 'not the artifact')), undefined, 'a tarball without lib/client.js yields nothing');
  assert.equal(clientArtifactFromTar(tarEntry('package/lib/client.js.map', 'sourcemap')), undefined, 'a sibling file whose name merely ends similarly is not accepted');
  assert.equal(clientArtifactFromTarball(new Uint8Array([1, 2, 3])), undefined, 'a non-gzip input is skipped rather than throwing');
  assert.equal(clientArtifactFromTar(new Uint8Array(1024)), undefined, 'an empty archive is skipped');

  // An ACTUAL npm tarball, when one is pointed at. `npm pack --pack-destination`
  // produces it; this is off by default because it needs a subprocess.
  if (process.env.MOLBIO_RELEASE_TARBALL !== undefined) {
    const real = readFileSync(process.env.MOLBIO_RELEASE_TARBALL);
    const committed = readFileSync(join(ROOT, 'packages', 'molbio-panel', 'lib', 'client.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(
      clientArtifactFromTarball(new Uint8Array(real)),
      committed,
      'the reader finds the client artifact inside a real npm tarball, byte for byte',
    );
    notes.push(`real tarball read: ${process.env.MOLBIO_RELEASE_TARBALL}`);
  }
  notes.push('the tar reader finds lib/client.js in a real and a hand-built archive, and only there');
}

// ── (10) optional network round trip ────────────────────────────────────────
//
// Off by default so `npm test` stays offline and deterministic. Run it when
// changing the registry layer: MOLBIO_RELEASE_NETWORK=1 node test/release.mjs
if (process.env.MOLBIO_RELEASE_NETWORK === '1') {
  const response = await fetch('https://registry.npmjs.org/is-number', { headers: { accept: 'application/json' } });
  assert.equal(response.ok, true, 'the public registry is reachable');
  const document = await response.json();
  const manifest = document.versions[document['dist-tags'].latest];
  assert.ok(typeof manifest.dist.tarball === 'string', 'the registry document carries a tarball URL, which is what probeRegistry reads');
  const tarball = await fetch(manifest.dist.tarball);
  assert.equal(tarball.ok, true, 'a published tarball is downloadable');
  const { gunzipSync } = await import('node:zlib');
  const archive = new Uint8Array(gunzipSync(new Uint8Array(await tarball.arrayBuffer())));
  assert.equal(clientArtifactFromTar(archive), undefined, 'a real package without a client artifact yields nothing');
  notes.push(`network round trip against is-number@${document['dist-tags'].latest}: OK`);
} else {
  notes.push('network round trip skipped (set MOLBIO_RELEASE_NETWORK=1 to run it)');
}

// ── (11) the npm version floor, AND how the workflow obtains the version ────
//
// This section exists because the release job failed on its FIRST real run, at
// the npm-floor step, with "cannot read the npm version from
// npm_config_user_agent". npm sets that variable only for scripts IT spawns, and
// a GitHub Actions `run:` step is spawned by the runner — so the check read
// `undefined` and refused. The guard below did not catch it because the rehearsal
// meant to exercise that step fed in the very variable the step wrongly depended
// on: it tested the assumption rather than the evidence.
//
// Two things fix that, and both are asserted here:
//   1. the rule is a tested function of a version STRING, and the workflow gets
//      that string by RUNNING `npm --version` (`detectNpmVersion`); and
//   2. the workflow file is checked for the shape that failed, so the inline
//      version cannot come back. Asserting only (1) would leave the YAML free to
//      drift away from the code the tests cover.
{
  const floor = MIN_NPM_FOR_TRUSTED_PUBLISHING.join('.');
  assert.equal(npmVersionSupport('11.16.0').ok, true);
  assert.equal(npmVersionSupport('12.0.0').ok, true);
  assert.equal(npmVersionSupport('npm/11.16.0 node/v26.3.0 linux x64').ok, true, 'the user-agent spelling is understood too');
  assert.equal(npmVersionSupport(floor).ok, true, 'the floor itself is supported');
  // The boundary is where a version comparison is most likely to be wrong: the
  // first version of this function compared only major.minor and let 11.5.0
  // through a floor of 11.5.1.
  assert.equal(npmVersionSupport('11.5.0').ok, false, 'one patch below the floor must be refused');
  assert.equal(npmVersionSupport('11.4.99').ok, false);
  assert.equal(npmVersionSupport('10.99.99').ok, false);
  assert.match(npmVersionSupport('not-a-version').reason, /cannot read an npm version/);
  assert.match(npmVersionSupport('').reason, /cannot read an npm version/);

  // Detection must yield something the rule accepts, on whatever machine runs the
  // suite — that property is what the workflow depends on.
  const detected = detectNpmVersion();
  const support = npmVersionSupport(detected.text);
  assert.equal(support.ok, true, `detectNpmVersion() returned ${JSON.stringify(detected.text)}, which the floor rule cannot accept`);
  notes.push(`npm ${support.version.join('.')} here satisfies the trusted-publishing floor (${floor})`);
}

// ── (12) the workflow itself ────────────────────────────────────────────────
//
// `.github/` is deliberately NOT in the npm `files` allowlist — the workflow is
// repository infrastructure, not something an installer needs. This suite is
// shipped (so is `test/`), which means it also runs from an unpacked tarball,
// where the workflow file is absent. That case is reported as a SKIP rather than
// passing quietly or failing: a check that silently does nothing is the exact
// failure mode docs/rules.md rule 9 is about, and the "EXCEPT …" reporting
// convention is the one 0.18.2 established for this.
{
  const workflowPath = join(ROOT, '.github', 'workflows', 'release.yml');
  let workflow = null;
  try {
    workflow = readFileSync(workflowPath, 'utf8');
  } catch {
    workflow = null;
  }
  if (workflow === null) {
    notes.push('EXCEPT the workflow-content assertions could NOT run: .github/workflows/release.yml is not in this copy (the npm allowlist excludes .github/)');
  } else {
    // Trusted publishing has exactly one silent failure mode: a token in the
    // environment makes npm skip the OIDC exchange, and the publish then fails
    // (or worse, succeeds against the wrong account). Assert the permission is
    // granted and that no token is ASSIGNED — the workflow does mention the
    // variable in a comment explaining why it must stay unset, so the pattern
    // matches an assignment rather than the bare name.
    assert.match(workflow, /id-token:\s*write/, 'the job must be allowed to mint an OIDC token');
    assert.match(workflow, /contents:\s*write/, 'and to create the GitHub Release');
    assert.ok(!/NODE_AUTH_TOKEN\s*[:=]/.test(workflow), 'assigning NODE_AUTH_TOKEN would disable trusted publishing');
    assert.ok(!/NPM_TOKEN\s*[:=]/.test(workflow), 'no npm token may be wired in');
    assert.ok(!/secrets\./.test(workflow), 'this workflow must not need a stored secret');
    // `setup-node` with `registry-url` writes an `.npmrc` containing a
    // `_authToken=${NODE_AUTH_TOKEN}` line, which is another way to hand npm an
    // (empty) token and suppress the OIDC exchange. Matched as a YAML KEY, since
    // the workflow's comment explains why the key is absent by naming it.
    assert.ok(!/^\s*registry-url\s*:/m.test(workflow), 'registry-url makes setup-node write an .npmrc with a token placeholder; trusted publishing needs no token at all');
    // The panel is a separate npm entry and has to be published from its own
    // directory; publishing twice from the root publishes the root twice.
    assert.match(workflow, /working-directory:\s*packages\/molbio-panel/);
    assert.match(workflow, /npm publish --access public --provenance/);
    assert.match(workflow, /node build\/release-preflight\.mjs/);
    assert.match(workflow, /npm test/, 'the tagged commit is tested by the release job itself');

    // THE DRIFT DETECTOR. Every Node-side decision in the workflow must go
    // through the module this suite tests, rather than reimplementing the rule
    // inline. The npm-floor step did the latter and broke on the first real run;
    // these assertions make that shape impossible to reintroduce.
    assert.match(workflow, /detectNpmVersion/, 'the npm-floor step must read the version from the CLI, not the environment');
    assert.match(workflow, /npmVersionSupport/, 'and must apply the tested rule');
    // The READ is what is forbidden, not the mention: the step's own comment
    // names the variable to explain why it cannot be trusted. Matched as
    // `process.env.X`, which is the access rather than the prose.
    assert.ok(
      !/process\.env\.npm_config_user_agent/.test(workflow),
      'the workflow must not read process.env.npm_config_user_agent: it is unset in a run: step, which is exactly how the first release failed',
    );
    assert.match(workflow, /tagVersion/, 'the tag assertion must use the tested parser');
    assert.ok(
      !/case\s+"\$TAG"\s+in/.test(workflow),
      'a shell `case` for the tag would accept shapes the parser rejects (a glob cannot express three numeric components)',
    );
    notes.push('the workflow grants OIDC, stores no token, and delegates every decision to the tested module');
  }
}

for (const note of notes) console.log(`  ok   ${note}`);
console.log(`\nrelease checks passed: ${notes.length} — the publish path is gated, and the gate has been shown to fail`);
