/**
 * One-off audit helper (0.16.0): dump REBASE's per-enzyme methylation-sensitivity
 * records for the enzymes the plugin's table names, so a human can compare them
 * with `METHYLATION_SENSITIVITY` in lib.mjs.
 *
 * ── What this tool does and does NOT do ────────────────────────────────────
 * It **dumps evidence**; it does not settle verdicts. That distinction matters
 * and was learned the hard way while correcting the table in 0.16.0: a REBASE
 * enzyme page carries MANY records per enzyme (different methylases, different
 * substrates, hemi- vs fully-methylated DNA, old papers vs recent ones), and
 * they legitimately disagree. ClaI is a clean example — the page carries both a
 * "cut" record and several "not cut" records for `m6`, and the correct summary
 * ("blocked through an overlapping dam site, which the site itself does not
 * contain") is a judgement about the enzyme, not a max() over a column.
 *
 * So this script prints every `m6` (Dam) and `m4` (Dcm) record with its verdict
 * and flags the entries where the plugin's claim is not directly supported, and
 * `build/rebase-audit.json` keeps the raw records. **Read the records before
 * changing a line** — in particular, "not listed" here means REBASE has no
 * Dam/Dcm record *at all* (so a claim for that enzyme is unsupported, which is
 * how several false positives were found), while "not cut" often means "blocked
 * only through a flanking site".
 *
 * Not part of the test suite and not a runtime dependency.
 *
 *   node build/rebase-audit.mjs            # audit the enzymes in lib.mjs
 *   node build/rebase-audit.mjs EcoRI      # audit specific enzymes
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHYLATION_SENSITIVITY, METHYLATION_SITES, enzymePattern } from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'http://rebase.neb.com/cgi-bin/msget?';

const VERDICT_BY_COLOUR = {
  '#008000': 'cut',
  '#DD7700': 'impaired',
  '#C90000': 'not cut',
};

/**
 * Every site block on the page with its colour and plain text.
 *
 * NOTE on the nesting: the site itself is wrapped in its own `<font color=…>`
 * INSIDE the block that carries the block's colour, and a row's block can also
 * contain `(N% cleaved)`. A non-greedy `<font>(.*?)</font>` therefore mis-pairs
 * colours with text. Anchoring on `<pre>` (which wraps the site lines) and
 * taking the colour of the enclosing `<font>` is what actually works.
 */
function blocks(html) {
  const out = [];
  const pattern = /<font\s+color\s*=\s*"?([#0-9A-Fa-f]+)"?\s*>([\s\S]*?)<\/pre>/gi;
  for (const match of html.matchAll(pattern)) {
    const colour = match[1].toUpperCase();
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    out.push({ colour, text });
  }
  return out;
}

/**
 * Reduce the coloured blocks of one page to per-modification RECORD LISTS.
 *
 * Deliberately does not collapse a page to one verdict. A block's code is the
 * first short non-IUPAC token (`m6`/`m4`/`m5`/`h`/`dG`/`VA`…), and its verdict
 * comes from the colour (green = cut, orange = impaired/partially cleaved, red =
 * not cut). Multiple records per code are the norm, so both the raw list and a
 * count per verdict are returned.
 */
function reduce(html) {
  const rows = [];
  for (const { colour, text } of blocks(html)) {
    const verdict = VERDICT_BY_COLOUR[colour] ?? (/\(\s*\d+\s*%\s*cleaved\s*\)/i.test(text) ? 'impaired' : 'unstated');
    const tokens = text.split(' ');
    const code = tokens.find((token) => /^[a-z][a-z0-9]{1,3}$/i.test(token) && !/^[ACGTWURYacgtwury]{2,}$/.test(token));
    if (code === undefined) continue;
    rows.push({ code, verdict, colour });
  }
  const pick = (wanted) => {
    const hits = rows.filter((row) => row.code.toLowerCase() === wanted);
    const counts = {};
    for (const hit of hits) counts[hit.verdict] = (counts[hit.verdict] ?? 0) + 1;
    return { rows: hits.length, counts, detail: hits.map((hit) => `${hit.verdict}`) };
  };
  return { dam: pick('m6'), dcm: pick('m4') };
}

async function fetchPage(enzyme) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await fetch(`${ENDPOINT}${enzyme}`, { signal: AbortSignal.timeout(25000) });
      const html = await response.text();
      if (/DB-Library|OS level error|Net-Library/i.test(html)) continue; // flaky server-side
      if (!/Methylation Sensitivity Data for/i.test(html)) return undefined; // no record
      return html;
    } catch {
      /* retry */
    }
  }
  return null; // exhausted
}

const requested = process.argv.slice(2);
const enzymes = requested.length > 0 ? requested : Object.keys(METHYLATION_SENSITIVITY).sort();
const report = {};
const unsupported = [];
for (const enzyme of enzymes) {
  const claim = METHYLATION_SENSITIVITY[enzyme];
  const site = enzymePattern(enzyme)?.pattern;
  const html = await fetchPage(enzyme);
  if (html === undefined || html === null) {
    report[enzyme] = { claim, recognitionSite: site, error: html === null ? 'unreachable after 8 attempts' : 'no REBASE record' };
    console.log(`${enzyme.padEnd(9)} ${html === null ? 'UNREACHABLE' : 'NO RECORD'}`);
    continue;
  }
  const dam = reduce(html).dam;
  const dcm = reduce(html).dcm;
  const claimed = (mark) => (claim?.blocked?.includes(mark) ? 'blocked' : claim?.sensitive?.includes(mark) ? 'impaired' : 'not sensitive');
  const claimDam = claimed('dam');
  const claimDcm = claimed('dcm');
  // A claim is "unsupported" only when REBASE has NO record of that modification
  // at all — a page full of disagreeing records needs a human, not a verdict.
  if (claimDam !== 'not sensitive' && dam.rows === 0) unsupported.push(`${enzyme} (dam claim: ${claimDam}, no m6 record)`);
  if (claimDcm !== 'not sensitive' && dcm.rows === 0) unsupported.push(`${enzyme} (dcm claim: ${claimDcm}, no m4 record)`);
  report[enzyme] = { claim, claimVerdict: { dam: claimDam, dcm: claimDcm }, recognitionSite: site, rebase: { dam, dcm } };
  const fmt = (entry) => (entry.rows === 0 ? 'no record' : `${entry.rows} rec: ${entry.detail.join(', ')}`);
  console.log(`${enzyme.padEnd(9)} ${String(site ?? '?').padEnd(8)} dam=${claimDam.padEnd(13)} ${fmt(dam)}`);
  console.log(`${''.padEnd(9)} ${''.padEnd(8)} dcm=${claimDcm.padEnd(13)} ${fmt(dcm)}`);
}
report._sites = METHYLATION_SITES;
report._unsupported = unsupported;
await writeFile(join(HERE, 'rebase-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `\n${unsupported.length} claim(s) have NO corresponding REBASE record (the strongest signal here):`
  + (unsupported.length === 0 ? ' none' : `\n  - ${unsupported.join('\n  - ')}`),
);
console.log(
  '\nRead the records before editing lib.mjs: a "not cut" record often means "blocked only through a\n'
  + 'flanking site", and multiple disagreeing records are normal (different methylases/substrates).\n'
  + `raw records written to ${join(HERE, 'rebase-audit.json')}`,
);
