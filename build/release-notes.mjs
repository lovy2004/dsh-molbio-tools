/**
 * dsh-molbio-tools/build/release-notes.mjs
 *
 * Turn the CHANGELOG section for a version into the body of a GitHub Release.
 *
 * WHY THIS IS DERIVED AND NOT WRITTEN BY HAND
 * ------------------------------------------
 * A GitHub Release whose notes were typed separately from the CHANGELOG is a
 * second description of the same change, and the two drift — this repository has
 * spent several releases cleaning up exactly that class of defect (the v19 tool
 * count, the "wording rule" that only the README still described). The notes are
 * therefore the CHANGELOG's own text, and the only things added are the facts
 * this script can read from the manifests: which versions went to npm.
 *
 * The section must exist. `build/release-preflight.mjs` already refuses to
 * release without it, so this script treats a missing section as an error rather
 * than quietly producing empty notes — a release published with no notes is
 * indistinguishable from one published by mistake.
 *
 * USAGE
 * -----
 *   node build/release-notes.mjs --tag v0.19.0 --out release-notes.md
 *   node build/release-notes.mjs --tag v0.19.0        # print to stdout
 *
 * The section extraction itself lives in `build/release-preflight.mjs`
 * (`changelogSection`) so the gate and the notes can never disagree about which
 * text belongs to a version.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLISHED_PACKAGES, changelogSection, tagVersion } from './release-preflight.mjs';

/**
 * The full release-notes body for one tag.
 *
 * @param {string} tag - the release tag (`v0.19.0`).
 * @param {{root?: string}} [options]
 * @returns {string} markdown
 */
export function releaseNotes(tag, { root = resolve(fileURLToPath(import.meta.url), '..', '..') } = {}) {
  const parsed = tagVersion(tag);
  if (parsed.error !== undefined) throw new Error(parsed.error);
  const { version } = parsed;

  const section = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!section.found) {
    throw new Error(`CHANGELOG.md has no "## ${version}" section, so this release has no notes (write one before tagging)`);
  }
  if (section.body.length < 40) {
    throw new Error(`the CHANGELOG section for ${version} is only ${section.body.length} characters; expand it before tagging`);
  }

  const published = PUBLISHED_PACKAGES.map((entry) => {
    const manifest = JSON.parse(readFileSync(join(root, entry.directory, 'package.json'), 'utf8'));
    return { name: entry.name, version: manifest.version, directory: entry.directory };
  });

  const lines = [
    section.body,
    '',
    '---',
    '',
    '**npm entries published by this release**',
    '',
    ...published.map(
      (entry) =>
        `- \`${entry.name}@${entry.version}\`${entry.directory === '.' ? '' : ' *(the panel package; its version line is independent of the root package)*'} — \`npm install -g ${entry.name}\``,
    ),
    '',
    '**Install in the harness** — `dsh plugin --profile <profile> add dsh-molbio-tools`; the tools load only in the **Molecular Biology Lab** mode. See [README.md](README.md) for the panel-only package and the manual install path.',
    '',
    `**Full entry** — [CHANGELOG.md](https://github.com/lovy2004/dsh-molbio-tools/blob/${tag}/CHANGELOG.md).`,
  ];
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const tagIndex = argv.indexOf('--tag');
  const outIndex = argv.indexOf('--out');
  const tag = tagIndex === -1 ? (process.env.GITHUB_REF_NAME ?? '') : argv[tagIndex + 1];
  if (tag === '') {
    console.error('release-notes: pass --tag v<version> (or set GITHUB_REF_NAME)');
    process.exit(1);
  }
  let notes;
  try {
    notes = releaseNotes(tag);
  } catch (error) {
    console.error(`release-notes FAILED: ${error.message}`);
    process.exit(1);
  }
  if (outIndex === -1) {
    console.log(notes);
    return;
  }
  writeFileSync(argv[outIndex + 1], `${notes}\n`, 'utf8');
  console.log(`release notes for ${tag} written to ${argv[outIndex + 1]}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
