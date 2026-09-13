/**
 * dsh-molbio-tools/methylation.mjs
 *
 * Methylation-aware restriction analysis and double-digest planning (v17):
 *
 *   1. which enzymes a Dam/Dcm-methylated template actually blocks — the classic
 *      "my digest does not cut and the enzyme is fine" failure, where the DNA was
 *      prepared from a dam+/dcm+ E. coli host;
 *   2. a double digest with two enzymes, including whether the two share a
 *      reaction buffer.
 *
 * Both parts lean on the reference tables in lib.mjs (METHYLATION_SENSITIVITY,
 * ENZYME_BUFFERS). Those tables are a hand-transcribed quick reference — every
 * result carries that note, and the numbers must be confirmed against the
 * supplier's current table before an experiment depends on them.
 */

import {
  BUFFER_DATA_NOTE,
  BUFFERS,
  ENZYME_NAMES,
  METHYLATION_DATA_NOTE,
  METHYLATION_SENSITIVITY,
  MolbioInputError,
  doubleDigest,
  enzymeCuts,
  enzymePattern,
  enzymesMissingBufferData,
  methylationImpact,
  methylationSites,
  normalizeSequence,
  sharedBuffers,
} from './lib.mjs';

/**
 * The default enzyme selection: everything in the methylation table that the
 * digest table can actually cut with. The methylation literature names enzymes
 * the digest table does not carry (AvaII, MboI, EcoRII, PspGI, TaqI, HphI,
 * BstNI), and reporting those as "0 sites" would be a lie of omission — they are
 * simply out of scope until they are added to the digest table.
 */
export const METHYLATION_ENZYMES = Object.keys(METHYLATION_SENSITIVITY)
  .filter((name) => ENZYME_NAMES.includes(name))
  .sort();

/**
 * Resolve an enzyme selection: `undefined`/`null` means "the enzymes the
 * methylation table knows about" (the question this tool exists to answer),
 * `['common']` means every enzyme in the built-in digest table, and anything
 * else is validated against that table.
 */
export function resolveEnzymeSelection(enzymes) {
  if (enzymes === undefined || enzymes === null || (Array.isArray(enzymes) && enzymes.length === 0)) {
    return [...METHYLATION_ENZYMES];
  }
  if (!Array.isArray(enzymes)) throw new MolbioInputError('enzymes must be an array of enzyme names (or omit it for the methylation-aware set)');
  if (enzymes.length === 1 && enzymes[0] === 'common') return [...ENZYME_NAMES];
  if (enzymes.length > 60) throw new MolbioInputError(`enzymes has ${enzymes.length} entries; the limit is 60 per call (pass ["common"] for the whole table)`);
  for (const name of enzymes) {
    if (typeof name !== 'string' || enzymePattern(name) === undefined) {
      throw new MolbioInputError(`unknown enzyme ${JSON.stringify(name)}; available: ${ENZYME_NAMES.join(', ')}`);
    }
  }
  return [...new Set(enzymes)];
}

/**
 * Report the methylation marks in a sequence and what they do to a digest.
 *
 * @param {string} rawSequence template sequence.
 * @param {{enzymes?: string[], marks?: string[], circular?: boolean}} [rawOptions]
 */
export function analyzeMethylation(rawSequence, rawOptions = {}) {
  const sequence = normalizeSequence(rawSequence);
  const marks = rawOptions.marks ?? ['dam', 'dcm'];
  if (!Array.isArray(marks) || marks.length === 0) throw new MolbioInputError('marks must be a non-empty array containing "dam" and/or "dcm"');
  const enabled = resolveEnzymeSelection(rawOptions.enzymes);
  const circular = rawOptions.circular === true;

  const impact = methylationImpact(sequence, enabled, { marks });
  const sites = methylationSites(sequence, marks);
  const byMark = {};
  for (const mark of marks) byMark[mark] = sites.filter((site) => site.mark === mark).length;

  // Per-enzyme view: does it cut at all, and is any cut blocked/impaired?
  const blockedMap = new Map(impact.blocked.map((entry) => [entry.enzyme, entry.marks]));
  const impairedMap = new Map(impact.impaired.map((entry) => [entry.enzyme, entry.marks]));
  const perEnzyme = enabled.map((name) => {
    const cuts = enzymeCuts(sequence, name);
    const blocked = blockedMap.get(name);
    const impaired = impairedMap.get(name);
    const status = blocked !== undefined ? 'blocked' : impaired !== undefined ? 'impaired' : cuts.length === 0 ? 'no_site' : 'cuts';
    return {
      enzyme: name,
      site: enzymePattern(name).display,
      sites: cuts.length,
      cut_positions: cuts.map((cut) => cut.cut_position + 1),
      status,
      blocked_by: blocked ?? [],
      impaired_by: impaired ?? [],
      in_methylation_table: blocked !== undefined || impaired !== undefined || METHYLATION_ENZYMES.includes(name),
    };
  });
  perEnzyme.sort((a, b) => {
    const rank = { cuts: 0, impaired: 1, blocked: 2, no_site: 3 };
    return rank[a.status] - rank[b.status] || a.enzyme.localeCompare(b.enzyme);
  });

  // The practical question: which enzymes cut this template and are NOT blocked?
  const usable = perEnzyme.filter((entry) => entry.status === 'cuts').map((entry) => entry.enzyme);
  const risky = perEnzyme.filter((entry) => entry.status === 'blocked' || entry.status === 'impaired').map((entry) => entry.enzyme);
  const recommended = perEnzyme
    .filter((entry) => entry.status === 'cuts')
    .map((entry) => ({
      enzyme: entry.enzyme,
      cut_positions: entry.cut_positions,
      fragments: enzymeFragmentSizes(sequence, entry.enzyme, circular),
    }));

  const advice = [];
  const blockedCutting = perEnzyme.filter((entry) => entry.status === 'blocked' && entry.sites > 0);
  for (const entry of blockedCutting.slice(0, 8)) {
    advice.push(`${entry.enzyme} has ${entry.sites} site(s) but is BLOCKED by ${entry.blocked_by.join('/')} methylation — use a dam-/dcm- host, or choose ${usable.slice(0, 3).join(', ') || 'another enzyme'}`);
  }
  if (sites.length === 0) advice.push('no Dam/Dcm site was found in this sequence, so methylation-sensitive enzymes are not affected by these marks here');
  const perEnzymeBlockedWithoutSite = perEnzyme.filter((entry) => entry.status === 'blocked' && entry.sites === 0).length;
  if (perEnzymeBlockedWithoutSite > 0 && blockedCutting.length === 0) {
    advice.push(`no enzyme in the selection both cuts this template and is blocked by its methylation (${perEnzymeBlockedWithoutSite} methylation-sensitive enzyme(s) have no site here)`);
  }

  return {
    length: sequence.length,
    circular,
    marks_checked: marks,
    methylation_sites: sites,
    sites_by_mark: byMark,
    enzymes_checked: enabled.length,
    blocked: perEnzyme.filter((entry) => entry.status === 'blocked').map((entry) => ({ enzyme: entry.enzyme, by: entry.blocked_by, sites: entry.sites })),
    impaired: perEnzyme.filter((entry) => entry.status === 'impaired').map((entry) => ({ enzyme: entry.enzyme, by: entry.impaired_by, sites: entry.sites })),
    usable,
    risky,
    recommended,
    per_enzyme: perEnzyme,
    advice,
    notes: [
      METHYLATION_DATA_NOTE,
      'Dam (GATC) and Dcm (CCWGG) are the marks a standard E. coli cloning host adds; CpG methylation (mammalian DNA) is not modelled.',
      'A site count of 0 with status "no_site" means the enzyme cannot be used on this template at all, independent of methylation.',
    ],
  };
}

/** Fragment sizes for one enzyme's cut set (linear or circular topology). */
function enzymeFragmentSizes(sequence, name, circular) {
  const positions = [...new Set(enzymeCuts(sequence, name).map((cut) => cut.cut_position))].sort((a, b) => a - b);
  const length = sequence.length;
  if (positions.length === 0) return [length];
  if (circular) {
    if (positions.length === 1) return [length];
    const fragments = [];
    for (let i = 0; i < positions.length; i++) {
      const a = positions[i];
      const b = positions[(i + 1) % positions.length];
      fragments.push(i === positions.length - 1 ? length - a + b : b - a);
    }
    return fragments.sort((a, b) => b - a);
  }
  const fragments = [positions[0]];
  for (let i = 1; i < positions.length; i++) fragments.push(positions[i] - positions[i - 1]);
  fragments.push(length - positions[positions.length - 1]);
  return fragments.filter((size) => size > 0).sort((a, b) => b - a);
}

/** Buffer compatibility of a set of enzymes. */
export function bufferReport(enzymes, { includeMissingData = true } = {}) {
  const names = resolveEnzymeSelection(enzymes);
  const shared = sharedBuffers(names);
  const missing = enzymesMissingBufferData(names);
  const perEnzyme = names.map((name) => {
    const buffers = sharedBuffers([name]);
    return {
      enzyme: name,
      buffers: buffers.map((key) => BUFFERS[key].label),
      universal: buffers.length === Object.keys(BUFFERS).length,
      in_table: !missing.includes(name),
    };
  });
  const describe = (key) => ({ key, label: BUFFERS[key].label, nacl_mm: BUFFERS[key].nacl_mm, legacy: BUFFERS[key].legacy === true });
  return {
    enzymes: names,
    shared_buffers: shared.map(describe),
    // The current buffer set only: recommending a legacy buffer to someone who
    // has the colour-coded one on the shelf is noise.
    recommended_buffers: shared.filter((key) => BUFFERS[key].legacy !== true).map(describe),
    compatible: shared.length > 0,
    missing_data: includeMissingData ? missing : [],
    per_enzyme: perEnzyme,
    note: BUFFER_DATA_NOTE,
  };
}

/**
 * Plan a double digest: each enzyme alone, the combination, and whether the two
 * can share a buffer in one tube (or need a sequential digest / a compatible
 * buffer from another supplier).
 */
export function planDoubleDigest(rawSequence, first, second, { circular = false, enzymes } = {}) {
  const sequence = normalizeSequence(rawSequence);
  for (const name of [first, second]) {
    if (typeof name !== 'string' || enzymePattern(name) === undefined) {
      throw new MolbioInputError(`unknown enzyme ${JSON.stringify(name)}; available: ${ENZYME_NAMES.join(', ')}`);
    }
  }
  if (first === second) throw new MolbioInputError('a double digest needs two different enzymes; use molbio_restriction_sites for a single enzyme');
  const digest = doubleDigest(sequence, first, second, circular);
  const buffers = bufferReport(enzymes === undefined ? [first, second] : [...enzymes, first, second]);
  const together = buffers.recommended_buffers.length > 0 ? buffers.recommended_buffers : buffers.shared_buffers;
  const advice = [];
  if (together.length > 0) {
    advice.push(`${first} + ${second} can be digested together in ${together.map((buffer) => buffer.label).join(' or ')}`);
  } else {
    const firstBuffers = buffers.per_enzyme.find((entry) => entry.enzyme === first)?.buffers ?? [];
    const secondBuffers = buffers.per_enzyme.find((entry) => entry.enzyme === second)?.buffers ?? [];
    advice.push(`${first} (${firstBuffers.join(', ') || 'buffer data missing'}) and ${second} (${secondBuffers.join(', ') || 'buffer data missing'}) share no buffer in the reference table — run the digest sequentially (cut with one, purify, then the other) or use a manufacturer's double-digest buffer`);
  }
  if (digest.first.cut_positions.length === 0) {
    advice.push(`${first} has no site on this template — the "double" digest is really a single digest with ${second}`);
  }
  if (digest.second.cut_positions.length === 0) {
    advice.push(`${second} has no site on this template — the "double" digest is really a single digest with ${first}`);
  }
  if (digest.first.cut_positions.length > 0 && digest.second.cut_positions.length > 0 && digest.combined_cut_positions.length < digest.first.cut_positions.length + digest.second.cut_positions.length) {
    advice.push(`${first} and ${second} share at least one cut position on this template — check whether the double digest resolves the fragments you expect`);
  }
  return {
    first: digest.first,
    second: digest.second,
    combined_cut_positions: digest.combined_cut_positions,
    combined_fragments: digest.combined_fragments,
    buffers: together,
    all_shared_buffers: buffers.shared_buffers,
    sequential_required: together.length === 0,
    advice,
    notes: [BUFFER_DATA_NOTE],
  };
}
