/**
 * dsh-molbio-tools/build/release-preflight.mjs
 *
 * The release gate for continuous delivery: everything a tag-triggered publish
 * must be true BEFORE anything is sent to npm.
 *
 * WHY THIS IS NOT PART OF `npm test`
 * ----------------------------------
 * `test/contract.mjs` already proves the committed client artifact is what the
 * sources build and that every published path is in `files` — this script does
 * NOT repeat any of that. What it adds is what only exists at release time:
 *
 *  - the TAG and the two package versions agree and improve on what npm has;
 *  - the CHANGELOG has a real section for the version being released;
 *  - the packages this repository publishes are the ones npm will receive;
 *  - and a FIRST release is reported as such instead of being handed to
 *    `npm publish`, where OIDC trusted publishing does not exist yet and the
 *    failure is an opaque 404.
 *
 * USAGE
 * -----
 *   node build/release-preflight.mjs --tag v0.19.0        # full gate (network)
 *   node build/release-preflight.mjs --tag v0.19.0 --offline   # no registry calls
 *
 * Exit code 0 means "safe to publish". Every failure prints what is wrong and
 * what to do about it, because this runs in CI where the log is the only
 * evidence a maintainer sees.
 *
 * The decision functions below are PURE and exported so `test/release.mjs` can
 * drive each one with a mutated input and prove the guard actually fails. A gate
 * nobody has seen fail is not a gate (docs/rules.md rule 9).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * The two npm entries this repository publishes, in publish order.
 *
 * THEY DO NOT SHARE A VERSION LINE, and that is deliberate rather than an
 * oversight to be "fixed" here. The root package carries the 58 tools and moves
 * with every toolset release; `dsh-molbio-panel` carries only the browser panel
 * and moves when the panel's own artifact moves. The tag names the ROOT version
 * (`v0.19.0`), and each entry is checked against its own declared version —
 * forcing them equal would either bump the panel for changes it did not receive,
 * or block a root release on a panel that has nothing new. The v20 plan records
 * the panel line independently (`0.1.1 → 0.1.2`).
 */
export const PUBLISHED_PACKAGES = [
  { name: 'dsh-molbio-tools', directory: '.', tagVersioned: true },
  { name: 'dsh-molbio-panel', directory: 'packages/molbio-panel', tagVersioned: false },
];

/**
 * Is a declared version a plain three-part release version?
 *
 * A panel version that is not `x.y.z` cannot be reasoned about by
 * `compareVersions`, and a prerelease panel published as a dependency of a
 * released root package is a trap for users. Released versions here are final.
 *
 * @param {string} version
 * @returns {string|undefined} a problem message, or undefined when acceptable.
 */
export function versionShapeProblem(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version))
    ? undefined
    : `version ${JSON.stringify(version)} is not a plain <major>.<minor>.<patch> release version`;
}

/**
 * Was the panel's browser artifact changed by this release?
 *
 * The panel and the root package share ONE client source (`build/`), so a change
 * to `svgio.mjs`, `font-metrics.mjs`, `logo.mjs`, `plasmid.mjs` or anything else
 * in the browser half changes `packages/molbio-panel/lib/client.js` too. When it
 * changes, the panel's version MUST move as well, or the second npm entry ships
 * different bytes under a version users already installed — and npm refuses a
 * re-publish of the same version, so the release would fail at the last step
 * with an error that names the symptom rather than the cause.
 *
 * @param {string|undefined} previous - the published artifact, or undefined when
 *   this is the panel's first release (no baseline to compare against).
 * @param {string} current
 * @returns {boolean}
 */
export function panelArtifactChanged(previous, current) {
  if (previous === undefined) return false;
  return previous !== current;
}

/**
 * A release tag is `v` + a three-part semver, and the `v` is required.
 *
 * Requiring the prefix is not pedantry: the workflow triggers on `v*`, so a tag
 * without it never starts a release, and one silently accepted here would mean
 * the gate passes for a tag that can never publish.
 *
 * @param {string} tag
 * @returns {{version: string}|{error: string}}
 */
export function tagVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag).trim());
  if (match === null) {
    return { error: `tag ${JSON.stringify(tag)} is not the release form "v<major>.<minor>.<patch>" (e.g. v0.19.0)` };
  }
  return { version: match[1] };
}

/**
 * Compare two prerelease strings the way semver does.
 *
 * `rc.2 < rc.10`, and that is not a detail: comparing the strings as text gives
 * `rc.10 < rc.2`, so a release of `rc.2` after `rc.10` would look like a
 * DOWNGRADE and the gate would refuse a legitimate publish (or, in the other
 * direction, wave through a stale one). This repository does cut prereleases
 * (the harness baseline itself is `0.1.7-rc.1`), so the rule is implemented
 * rather than approximated.
 *
 * Semver's rule: split on dots; numeric identifiers compare numerically and rank
 * below alphanumeric ones; otherwise compare as text.
 *
 * @returns {number} negative, zero or positive.
 */
export function comparePrerelease(left, right) {
  if (left === right) return 0;
  // A release outranks any prerelease of the same version.
  if (left === '') return 1;
  if (right === '') return -1;
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a[index];
    const y = b[index];
    // A shorter set of identifiers is smaller when all the shared ones match.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two dotted versions.
 *
 * Deliberately narrower than full semver — build metadata is ignored and only
 * `x.y.z` plus an optional prerelease is understood — but the ORDERING rules it
 * does implement are semver's, because the only question asked here is "is the
 * new one bigger than what npm has".
 *
 * @returns {number} negative, zero or positive.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [core, ...rest] = String(value).split('-');
    return { numbers: core.split('.').map((part) => Number(part)), pre: rest.join('-') };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return comparePrerelease(a.pre, b.pre);
}

/**
 * The version each package would publish, and whether the tag agrees with the
 * one that is bound to it.
 *
 * Only the entry marked `tagVersioned` is bound to the tag. A tag that disagrees
 * with its own package version publishes a version nobody asked for under a name
 * that claims another — the single most damaging release mistake, and the
 * cheapest to catch. Every entry must still declare a well-formed release
 * version, because the publish step reads that number, not the tag.
 *
 * @param {string} version - the version the tag names.
 * @param {Array<{name: string, tagVersioned: boolean, manifest: object}>} packages
 * @returns {{ok: boolean, mismatches: string[], missing: string[]}}
 */
export function packageVersionCheck(version, packages) {
  const mismatches = [];
  const missing = [];
  for (const entry of packages) {
    const declared = entry?.manifest?.version;
    if (declared === undefined) {
      missing.push(`${entry?.name ?? '(unnamed)'} has no version field`);
      continue;
    }
    const shape = versionShapeProblem(declared);
    if (shape !== undefined) mismatches.push(`${entry.name}: ${shape}`);
    if (entry.tagVersioned === true && declared !== version) {
      mismatches.push(`${entry.name} declares ${declared} but the tag names ${version}`);
    }
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}

/**
 * The body of the CHANGELOG section for one version.
 *
 * `CHANGELOG.md` is the source of the GitHub release notes, so its heading has
 * to be findable BY VERSION — a release whose notes cannot be located is a
 * release nobody can read afterwards. Both heading spellings this repository has
 * used are accepted (`## [0.19.0] — date` and `## 0.19.0 (date)`) because the
 * format changed historically and old entries are kept verbatim.
 *
 * @param {string} text - the CHANGELOG contents.
 * @param {string} version
 * @returns {{found: boolean, heading: string, body: string}}
 */
export function changelogSection(text, version) {
  const lines = String(text).split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?\\b`);
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    if (heading.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start === -1) return { found: false, heading: '', body: '' };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return {
    found: true,
    heading: lines[start].trim(),
    body: lines.slice(start + 1, end).join('\n').trim(),
  };
}

/**
 * Is this version already on the registry?
 *
 * `npm view <name>@<version> version` answers `404` for a missing version and a
 * non-zero exit for a missing PACKAGE, so the two are told apart by asking for
 * the whole package as well. The distinction is the whole point: an unpublished
 * version is a mistake to stop on, while an unpublished PACKAGE is the first
 * release and needs a documented manual step (OIDC has nothing to authenticate
 * against until the name exists).
 *
 * @param {{version?: string, packageExists?: boolean, error?: string}} probe
 * @param {string} version
 * @returns {{state: 'same'|'newer'|'older'|'first-release'|'unknown', message: string}}
 */
export function publishedState(probe, version) {
  if (probe?.error !== undefined) {
    return { state: 'unknown', message: `could not read the registry for this package: ${probe.error}` };
  }
  if (probe?.packageExists === false) {
    return {
      state: 'first-release',
      message: 'the package does not exist on npm yet — the FIRST publish must be done by hand (see docs/workflow.md section 4)',
    };
  }
  if (probe?.version === undefined || probe.version === '') {
    return { state: 'newer', message: 'the package exists but this version has not been published' };
  }
  const order = compareVersions(version, probe.version);
  if (order === 0) return { state: 'same', message: `npm already has ${version} — nothing to publish (a re-run is a no-op, not an error)` };
  if (order < 0) return { state: 'older', message: `npm already has ${probe.version}, which is NEWER than ${version}` };
  return { state: 'newer', message: `npm has ${probe.version}; ${version} is newer` };
}

/**
 * Is the repository root a workspace?
 *
 * IF IT EVER BECOMES ONE, THE PANEL PUBLISH BREAKS IN A CONFUSING WAY. npm
 * resolves the workspace root by walking UP from the current directory, and from
 * `packages/molbio-panel` that search finds the repository root's
 * `package.json` — so `npm publish` in the panel directory would publish the
 * ROOT package instead, which is the same trap `docs/workflow.md` records for
 * running publish twice from the root. The workflow publishes the panel with
 * `working-directory: packages/molbio-panel`, so this configuration would
 * silently publish `dsh-molbio-tools` twice.
 *
 * The check is a refusal, not a warning: whoever adds `workspaces` needs to know
 * that the publish mechanism has to change with it (an explicit `--workspace`
 * invocation, or separate npm invocations per directory).
 *
 * @param {object} manifest - the repository root manifest.
 * @returns {string[]}
 */
export function workspacePublishProblem(manifest) {
  if (manifest?.workspaces === undefined) return [];
  return [
    'the root package.json declares `workspaces`, which changes how npm resolves the package to publish from packages/molbio-panel (it would publish the ROOT package a second time) — revisit .github/workflows/release.yml before releasing',
  ];
}

/**
 * Does the manifest declare the client half a profile will look for?
 *
 * `dsh plugin add` reads `dsh.client.platform` and `exports["./client"]`, and a
 * package published without them installs cleanly and then shows no panel — the
 * "installed but does nothing" failure this repository has already hit once
 * (0.15.2). Checking the manifest here means the release stops before npm
 * carries a package that cannot work.
 *
 * @param {string} name
 * @param {object} manifest
 * @returns {string[]} problems, empty when the manifest is publishable.
 */
export function clientManifestProblems(name, manifest) {
  const problems = [];
  if (manifest?.dsh?.client?.platform !== 'web') {
    problems.push(`${name}: dsh.client.platform is ${JSON.stringify(manifest?.dsh?.client?.platform)} rather than "web"`);
  }
  if (manifest?.exports?.['./client']?.default === undefined) {
    problems.push(`${name}: exports["./client"].default is missing, so the panel cannot be loaded`);
  }
  if (manifest?.dsh?.bundle?.patch === undefined) {
    problems.push(`${name}: dsh.bundle.patch is missing, so the bundle contributes no composition row`);
  }
  return problems;
}

// ── the runnable gate ───────────────────────────────────────────────────────

/** Read and parse one JSON file, or throw with the path in the message. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

/**
 * Ask the registry about one package.
 *
 * THE REGISTRY IS QUERIED OVER HTTP, NOT THROUGH `npm view`. Spawning npm means
 * `shell: true` on Windows (npm is a `.cmd`), and that concatenates arguments
 * instead of escaping them — the exact mechanism that truncated every benchmark
 * instruction to its first word in 0.14.0. Nothing here takes user input, but
 * the pattern is the one this repository has already been burned by, and the
 * HTTP API is also simpler: one request tells "package missing" and "version
 * missing" apart, where `npm view` needs two and reports both as E404.
 *
 * A failure to reach the registry returns `{ error }` and the caller treats it
 * as "unknown" rather than blocking, because a flaky lookup must not be able to
 * stop a release that the publish step itself will verify.
 *
 * @param {string} name
 * @param {string} version
 * @returns {Promise<{packageExists?: boolean, version?: string, artifact?: string, error?: string}>}
 */
async function probeRegistry(name, version) {
  const base = process.env.npm_config_registry ?? 'https://registry.npmjs.org';
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (response.status === 404) return { packageExists: false };
    if (!response.ok) return { error: `registry answered HTTP ${response.status}` };
    const document = await response.json();
    const published = document?.versions?.[version];
    if (published === undefined) return { version: '' };
    const tarball = published?.dist?.tarball;
    return { version, artifact: typeof tarball === 'string' ? tarball : undefined };
  } catch (error) {
    return { error: `${error?.cause?.code ?? error?.code ?? error.message}`.toString().trim() };
  }
}

/**
 * The `lib/client.js` inside one published tarball, or undefined.
 *
 * There is no tar library here (the package is zero-dependency and this script
 * ships with it), so the reader is the minimum that can find one regular-file
 * entry: a POSIX ustar header is 512 bytes, the name is the first 100 bytes, the
 * size is octal at offset 124, and entries are padded to 512-byte boundaries.
 *
 * Anything unexpected returns undefined and the caller SKIPS the check rather
 * than guessing. That direction matters: a false "the artifact changed, bump the
 * panel" blocks a release for no reason, while a missed change falls through to
 * npm's own refusal to re-publish. Exported so `test/release.mjs` can drive it
 * with a real tarball and with mutated bytes.
 *
 * @param {Uint8Array} gzipped - the `.tgz` contents.
 * @returns {string|undefined}
 */
export function clientArtifactFromTarball(gzipped) {
  try {
    return clientArtifactFromTar(gunzipSync(gzipped));
  } catch {
    return undefined;
  }
}

/**
 * The same reader over an ALREADY-DECOMPRESSED tar, split out because the
 * decompression step is the one part that cannot run twice on the same input
 * (a gzip member is consumed by reading it), and because a unit test wants to
 * hand it a hand-built header.
 *
 * @param {Uint8Array} archive
 * @returns {string|undefined}
 */
export function clientArtifactFromTar(archive) {
  const decode = new TextDecoder();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    // Two zero blocks end the archive.
    if (header.every((byte) => byte === 0)) break;
    // A ustar header pads every string field with NULs.
    const readField = (start, length) => decode.decode(header.subarray(start, start + length)).split('\u0000')[0].trim();
    const size = Number.parseInt(readField(124, 12) || '0', 8);
    if (!Number.isFinite(size) || size < 0) return undefined;
    const body = offset + 512;
    // npm normalizes tarball paths to `package/…`, and a `.` prefix is legal.
    if (readField(0, 100).replace(/^\.\//, '').endsWith('lib/client.js')) {
      return decode.decode(archive.subarray(body, body + size)).replace(/\r\n/g, '\n');
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * Fetch one published tarball and read its client artifact.
 *
 * @returns {Promise<string|undefined>}
 */
async function fetchPublishedArtifact(url) {
  if (url === undefined) return undefined;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return clientArtifactFromTarball(new Uint8Array(await response.arrayBuffer()));
  } catch {
    return undefined;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const tagIndex = argv.indexOf('--tag');
  const rootIndex = argv.indexOf('--root');
  const root = resolve(rootIndex === -1 ? join(fileURLToPath(import.meta.url), '..', '..') : argv[rootIndex + 1]);
  const rawTag = tagIndex === -1 ? (process.env.GITHUB_REF_NAME ?? '') : argv[tagIndex + 1];

  const failures = [];
  const notes = [];

  if (rawTag === '') {
    failures.push('no tag given: pass --tag v<version> (the workflow uses the tag that triggered it)');
  }
  const parsed = tagVersion(rawTag);
  if (parsed.error !== undefined) failures.push(parsed.error);
  const version = parsed.version;

  const packages = PUBLISHED_PACKAGES.map((entry) => ({
    ...entry,
    manifest: readJson(join(root, entry.directory, 'package.json')),
  }));
  const tagBound = packages.find((entry) => entry.tagVersioned === true);

  if (version !== undefined) {
    const versions = packageVersionCheck(version, packages);
    failures.push(...versions.mismatches, ...versions.missing);
    if (versions.ok) {
      const each = packages.map((entry) => `${entry.name}@${entry.manifest.version}`).join(', ');
      notes.push(`versions declared: ${each} (the tag binds ${tagBound?.name ?? 'nothing'})`);
    }

    const changelog = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
    if (!changelog.found) {
      failures.push(`CHANGELOG.md has no "## ${version}" section, so there are no release notes for this version`);
    } else if (changelog.body.length < 40) {
      failures.push(`the CHANGELOG section for ${version} is ${changelog.body.length} characters — too short to be release notes`);
    } else {
      notes.push(`CHANGELOG section found: ${changelog.heading}`);
    }
  }

  for (const entry of packages) failures.push(...clientManifestProblems(entry.name, entry.manifest));
  failures.push(...workspacePublishProblem(packages.find((entry) => entry.directory === '.')?.manifest));
  if (failures.length === 0) notes.push('both manifests declare the client half a profile looks for, and the root is not an npm workspace');

  if (version !== undefined && !offline) {
    let firstRelease = false;
    for (const entry of packages) {
      const declared = entry.manifest.version;
      const probe = await probeRegistry(entry.name, declared);
      const state = publishedState(probe, declared);
      if (state.state === 'unknown') {
        // A flaky lookup must not block a release the publish step will verify.
        notes.push(`${entry.name}: ${state.message}`);
        continue;
      }
      if (state.state === 'first-release') {
        firstRelease = true;
        notes.push(`${entry.name}: ${state.message}`);
        continue;
      }
      if (state.state === 'older') {
        failures.push(`${entry.name}: ${state.message}`);
        continue;
      }
      notes.push(`${entry.name}: ${state.message}`);

      // A version npm ALREADY HAS is only harmless if it carries the same
      // artifact. For the panel that is the whole question: its version line is
      // independent, so "not bumped" and "nothing changed" have to be told
      // apart, and npm's own refusal to re-publish is the symptom rather than
      // the diagnosis.
      if (state.state === 'same' && entry.directory !== '.') {
        const published = await fetchPublishedArtifact(probe.artifact);
        const current = readFileSync(join(root, entry.directory, 'lib', 'client.js'), 'utf8').replace(/\r\n/g, '\n');
        if (published === undefined) {
          notes.push(`${entry.name}: could not read the published artifact, so the "was it changed?" check was skipped`);
        } else if (panelArtifactChanged(published, current)) {
          failures.push(
            `${entry.name}@${declared} is already on npm but its lib/client.js DIFFERS from the one in this tree — bump the panel version (its line is independent of the root package's)`,
          );
        } else {
          notes.push(`${entry.name}@${declared} is already published with identical bytes — the publish step will be a no-op`);
        }
      }
    }
    if (firstRelease) {
      notes.push('FIRST RELEASE: publish each package by hand once, then configure a trusted publisher for it (docs/workflow.md section 4)');
    }
  } else if (offline) {
    notes.push('--offline: registry state not checked');
  }

  for (const note of notes) console.log(`  note  ${note}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL  ${failure}`);
    console.error(`\nrelease-preflight FAILED: ${failures.length} problem(s) — nothing was published`);
    process.exit(1);
  }
  console.log(`\nrelease preflight OK: v${version} is ready to publish (${packages.length} package(s): ${packages.map((entry) => `${entry.name}@${entry.manifest.version}`).join(', ')})`);
}

// Only run when invoked, not when imported by the test suite.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`release-preflight FAILED: ${error.message}`);
    process.exit(1);
  });
}
