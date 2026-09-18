/**
 * dsh-molbio-tools/pcr.mjs
 *
 * In-silico PCR: where does a primer pair actually amplify, and how big is the
 * product? This closes the loop on the primer-design tools — after designing
 * primers, the next bench question is always "what band will I see, and what
 * else will this pair hit".
 *
 * THE TWO PARAMETERS THAT DECIDE EVERYTHING
 * -----------------------------------------
 * `mismatches` and `three_prime_exact`. A primer with a mismatch in the middle
 * still anneals and extends; a primer with a mismatch at its 3' end generally
 * does not, because the polymerase needs a matched 3' terminus to start from.
 * Both are therefore explicit parameters, the 3' requirement defaults to 3
 * bases of exact match, and every reported site carries its mismatch count and
 * whether the 3' anchor held — so a hit is never just "found".
 *
 * STRAND CONVENTION
 * -----------------
 * Sites are reported on the TOP strand of the template, 1-based. A forward
 * primer binds the top strand and its site is the primer's own sequence; a
 * reverse primer binds the BOTTOM strand, so its site is the reverse
 * complement of the primer read on the top strand. The amplicon always spans
 * `forward_site.start` to `reverse_site.end`, and that slice of the top strand
 * is the product.
 *
 * CIRCULAR TEMPLATES
 * ------------------
 * With `circular: true` a product may cross the origin: the product is then
 * taken with a modular slice, and `wraps_origin` says so.
 */

import { MolbioInputError, normalizeSequence, reverseComplement } from './lib.mjs';
import { renderGel } from './plot.mjs';

export const PCR_DEFAULTS = {
  mismatches: 0,
  three_prime_exact: 3,
  min_size: 0,
  max_size: 100000,
  max_products: 200,
  /** Product sequences longer than this are not returned inline (size is). */
  max_returned_sequence: 5000,
};

/** IUPAC expansion, used for both the primer and the template base. */
const IUPAC = {
  A: 'A', C: 'C', G: 'G', T: 'T', U: 'T',
  R: 'AG', Y: 'CT', S: 'CG', W: 'AT', K: 'GT', M: 'AC',
  B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT',
};

/** Do an IUPAC primer base and a template base agree? */
function baseMatches(primerBase, templateBase) {
  const primerSet = IUPAC[primerBase];
  const templateSet = IUPAC[templateBase];
  if (primerSet === undefined || templateSet === undefined) return false;
  for (const base of primerSet) {
    if (templateSet.includes(base)) return true;
  }
  return false;
}

/** The product sequence of a template, taking the top strand with a modular slice. */
function sliceSequence(sequence, start, length) {
  if (length >= sequence.length) {
    // More than one full turn of a circular template: tile it.
    let out = '';
    while (out.length < length) out += sequence;
    return out.slice(start, start + length) || out;
  }
  if (start + length <= sequence.length) return sequence.slice(start, start + length);
  return sequence.slice(start) + sequence.slice(0, start + length - sequence.length);
}

/**
 * Every binding site of `primer` on `template`.
 *
 * @param {string} template normalised template (ACGTN…)
 * @param {string} primer primer sequence, 5'->3', as it would be ordered
 * @param {'forward'|'reverse'} strand which strand the primer reads
 * @param {{mismatches: number, three_prime_exact: number, circular: boolean}} options
 * @returns {Array<object>} sites, in ascending start order
 */
export function findBindingSites(template, primer, strand, options = {}) {
  const allowed = options.mismatches ?? PCR_DEFAULTS.mismatches;
  const anchor = options.three_prime_exact ?? PCR_DEFAULTS.three_prime_exact;
  const circular = options.circular === true;
  if (!Number.isInteger(allowed) || allowed < 0) throw new MolbioInputError('mismatches must be a non-negative integer');
  if (!Number.isInteger(anchor) || anchor < 0) throw new MolbioInputError('three_prime_exact must be a non-negative integer');
  if (primer.length === 0) throw new MolbioInputError('the primer sequence is empty');
  if (anchor > primer.length) throw new MolbioInputError(`three_prime_exact ${anchor} is longer than the primer (${primer.length} bases)`);
  // A reverse primer is matched as its reverse complement against the top strand.
  const probe = strand === 'reverse' ? reverseComplement(primer) : primer;
  const length = template.length;
  if (!circular && length < probe.length) return [];
  const limit = circular ? length : length - probe.length;
  const sites = [];
  for (let start = 0; start <= limit; start++) {
    let mismatches = 0;
    let mismatchPositions = [];
    let matched = true;
    for (let offset = 0; offset < probe.length; offset++) {
      const templateBase = template[(start + offset) % length];
      if (baseMatches(probe[offset], templateBase)) continue;
      mismatches++;
      mismatchPositions.push(offset + 1);
      if (mismatches > allowed) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // The 3' end of the primer as ORDERED: for a reverse primer the 3' end is
    // the last base of `primer`, which is the FIRST base of `probe`.
    const anchorRegion = strand === 'forward'
      ? probe.slice(probe.length - anchor)
      : probe.slice(0, anchor);
    const anchorStart = strand === 'forward' ? probe.length - anchor : 0;
    let anchorMismatches = 0;
    for (let offset = 0; offset < anchorRegion.length; offset++) {
      const templateBase = template[(start + anchorStart + offset) % length];
      if (!baseMatches(anchorRegion[offset], templateBase)) anchorMismatches++;
    }
    if (anchorMismatches > 0) continue;
    const ambiguous = [...probe].some((base) => base !== 'A' && base !== 'C' && base !== 'G' && base !== 'T');
    sites.push({
      strand,
      start: start + 1,
      end: ((start + probe.length - 1) % length) + 1,
      start_index: start,
      matches: probe.length - mismatches,
      mismatches,
      mismatch_positions: mismatchPositions,
      three_prime_anchor: anchor,
      anchor_mismatches: anchorMismatches,
      contains_ambiguous_bases: ambiguous,
      spans_origin: start + probe.length > length,
    });
  }
  return sites;
}

/**
 * Run one primer pair against a template.
 *
 * @returns {{name: string, forward: string, reverse: string, forward_sites: Array<object>,
 *   reverse_sites: Array<object>, amplicons: Array<object>, out_of_range: number,
 *   verdict: string, best_amplicon: object|undefined}}
 */
export function simulatePair(template, pair, options = {}) {
  const settings = { ...PCR_DEFAULTS, ...options };
  const circular = options.circular === true;
  const name = pair.name ?? 'pair';
  // Validate the raw input before normalising: `normalizeSequence('')` throws a
  // generic "no bases" error, which would hide WHICH primer of the pair is
  // missing.
  if (typeof pair.forward !== 'string' || pair.forward.trim() === '') throw new MolbioInputError(`primer pair ${name} has no forward primer`);
  if (typeof pair.reverse !== 'string' || pair.reverse.trim() === '') throw new MolbioInputError(`primer pair ${name} has no reverse primer`);
  const forward = normalizeSequence(pair.forward);
  const reverse = normalizeSequence(pair.reverse);
  if (forward === '') throw new MolbioInputError(`primer pair ${name} forward primer has no bases`);
  if (reverse === '') throw new MolbioInputError(`primer pair ${name} reverse primer has no bases`);
  const forwardSites = findBindingSites(template, forward, 'forward', { ...settings, circular });
  const reverseSites = findBindingSites(template, reverse, 'reverse', { ...settings, circular });
  const amplicons = [];
  let outOfRange = 0;
  for (const forwardSite of forwardSites) {
    for (const reverseSite of reverseSites) {
      // A product must run from the forward site's 3' end to the reverse
      // site's 5' end, i.e. the reverse site has to lie "after" it.
      const productStartIndex = forwardSite.start_index;
      const productEndIndex = reverseSite.start_index + reverse.length - 1;
      let size;
      let wraps = false;
      if (!circular) {
        size = productEndIndex - productStartIndex + 1;
        if (size < forward.length + reverse.length) continue;
      } else {
        size = productEndIndex - productStartIndex + 1;
        if (size <= 0) {
          size += template.length;
          wraps = true;
        }
        if (size < forward.length + reverse.length) continue;
      }
      const record = {
        size,
        forward_site: { start: forwardSite.start, end: forwardSite.end, mismatches: forwardSite.mismatches, mismatch_positions: forwardSite.mismatch_positions },
        reverse_site: { start: reverseSite.start, end: reverseSite.end, mismatches: reverseSite.mismatches, mismatch_positions: reverseSite.mismatch_positions },
        total_mismatches: forwardSite.mismatches + reverseSite.mismatches,
        wraps_origin: wraps || forwardSite.spans_origin || reverseSite.spans_origin,
        in_range: size >= settings.min_size && size <= settings.max_size,
        sequence: size <= settings.max_returned_sequence ? sliceSequence(template, productStartIndex, size) : '',
      };
      if (record.in_range) amplicons.push(record);
      else outOfRange++;
    }
  }
  amplicons.sort((a, b) => a.forward_site.start - b.forward_site.start || a.size - b.size);
  const capped = amplicons.slice(0, settings.max_products);
  const onTarget = capped.filter((amplicon) => amplicon.total_mismatches === 0);
  const verdict = capped.length === 0
    ? 'no_product'
    : capped.length === 1 ? (capped[0].total_mismatches === 0 ? 'specific' : 'specific_with_mismatches') : 'multiple_bands';
  // `best_amplicon` is OMITTED rather than set to undefined: an own key holding
  // `undefined` is not a JSON value, and the harness's lossless-value check
  // rejects it (correctly — such a key vanishes through JSON.stringify).
  const best = capped.length === 0
    ? undefined
    : capped.slice().sort((a, b) => a.total_mismatches - b.total_mismatches || a.size - b.size)[0];
  return {
    name,
    forward,
    reverse,
    forward_sites: forwardSites,
    reverse_sites: reverseSites,
    amplicons: capped,
    amplicon_count: capped.length,
    truncated: amplicons.length > capped.length,
    out_of_range: outOfRange,
    on_target_count: onTarget.length,
    off_target_count: capped.length - onTarget.length,
    verdict,
    ...best === undefined ? {} : { best_amplicon: best },
  };
}

/** Run every pair against the template, and optionally against extra templates. */
export function simulatePcr(template, pairs, options = {}) {
  const settings = { ...PCR_DEFAULTS, ...options };
  if (typeof template !== 'string' || template.trim() === '') throw new MolbioInputError('the template sequence is empty');
  const normalizedTemplate = normalizeSequence(template);
  if (Array.isArray(pairs) && pairs.length > 24) throw new MolbioInputError('at most 24 primer pairs per call');
  if (!Array.isArray(pairs) || pairs.length === 0) throw new MolbioInputError('provide at least one primer pair');
  if (pairs.length > 24) throw new MolbioInputError('at most 24 primer pairs per call');
  const results = pairs.map((pair) => simulatePair(normalizedTemplate, pair, settings));
  const screens = (settings.screen_templates ?? []).map((entry) => ({
    name: entry.name ?? 'screen',
    products: pairs.map((pair, index) => {
      const screenTemplate = normalizeSequence(entry.sequence ?? '');
      if (screenTemplate === '') throw new MolbioInputError(`screen template ${entry.name ?? index} is empty`);
      const outcome = simulatePair(screenTemplate, pair, { ...settings, circular: entry.circular === true });
      return {
        pair: outcome.name,
        amplicon_count: outcome.amplicon_count,
        sizes: outcome.amplicons.map((amplicon) => amplicon.size),
        verdict: outcome.verdict,
      };
    }),
  }));
  return {
    template_length: normalizedTemplate.length,
    circular: settings.circular === true,
    pairs: results,
    screens,
    settings: {
      mismatches: settings.mismatches,
      three_prime_exact: settings.three_prime_exact,
      min_size: settings.min_size,
      max_size: settings.max_size,
      circular: settings.circular === true,
    },
  };
}

/**
 * The gel a bench scientist would run: one lane per primer pair, sized bands
 * for every in-range product. Reuses the virtual-gel renderer so the picture
 * matches molbio_virtual_gel exactly.
 */
export function pcrGel(pairs, { title = 'In-silico PCR', ladder = '100bp' } = {}) {
  const lanes = pairs.map((pair) => ({
    label: pair.name.length > 10 ? pair.name.slice(0, 10) : pair.name,
    fragments: pair.amplicons.map((amplicon) => amplicon.size),
  }));
  return renderGel({ title, lanes, ladder, showLadder: true });
}
