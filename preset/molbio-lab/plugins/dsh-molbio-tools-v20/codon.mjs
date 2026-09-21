/**
 * dsh-molbio-tools/codon.mjs
 *
 * Codon usage analysis: is this coding sequence well adapted to the host, and
 * which codons are the problem? Answers with CAI, RSCU, Nc (effective number
 * of codons), GC3/GC123, a rare-codon list, CDS CpG content and a hidden-stop
 * scan.
 *
 * THE TABLES AND WHY THERE ARE TWO OF THEM
 * ---------------------------------------
 * `protein.mjs` already embeds `CODON_USAGE`: per host, the codons of each
 * amino acid in descending order of how often that host uses them. That is
 * exactly what a silent optimizer needs, and it is NOT enough for CAI/RSCU,
 * which need the actual fractions (the ordering alone cannot say whether the
 * best codon is used 80% or 30% of the time).
 *
 * So this module adds `CODON_FREQUENCIES`: per host, the usage fraction of all
 * 61 sense codons, as transcribed constants (published codon-usage tables).
 *
 * THE TWO TABLES ARE ALLOWED TO DISAGREE, AND HERE IS WHY
 * ------------------------------------------------------
 * `CODON_USAGE` encodes OPTIMIZATION preference (which codon a designer should
 * pick), and that is not the same as raw usage frequency — for 18 of the 60
 * host/amino-acid pairs the first choice is deliberately not the most frequent
 * codon in the genome. Forcing the two into agreement would mean falsifying one
 * of them, so `test/smoke.mjs` asserts the three things that CAN be checked:
 * the frequency table holds exactly the 61 sense codons, each amino-acid family
 * sums to 1, and every codon `CODON_USAGE` names exists here with the optimizer's
 * first choice not being a RARE codon (w below half the family maximum). A
 * transcription slip in either table therefore fails the suite rather than
 * producing a plausible-looking wrong CAI.
 *
 * REFERENCES AND CONVENTIONS (all stated in the tool output as well)
 * -----------------------------------------------------------------
 * - CAI: Sharp & Li 1987. w = f(codon) / f(reference codon of that amino acid),
 *   CAI = geometric mean of w over the CDS, excluding Met/Trp (single-codon
 *   families, where w is 1 by definition) and excluding stop codons.
 * - w = 0 is impossible to take a logarithm of; the universal convention is to
 *   substitute 0.5 / f_max, which is applied here AND reported in
 *   `zero_frequency_codons`.
 * - RSCU: observed count / expected count under uniform usage of the family.
 *   1.0 = no bias, > 1 = used more than expected.
 * - Nc (Wright 1990): effective number of codons from the homozygosity of each
 *   synonymous family, with the GC3-binned expectation for small families.
 *   20 = maximal bias, 61 = no bias.
 * - GC3 and GC123: GC at the third, and at each, codon position.
 */

import { CODON_TABLE_BY_NAME, MolbioInputError } from './lib.mjs';
import { CODON_HOSTS } from './protein.mjs';

/**
 * Usage fraction of every one of the 61 sense codons, per host. Within one
 * amino acid the fractions sum to 1 (asserted in the test suite). Sources are
 * the standard published codon-usage tables for each host — E. coli K-12,
 * S. cerevisiae and H. sapiens — transcribed constants, not downloaded data.
 * Stop codons are deliberately absent: they are not part of a sense-codon
 * usage profile, and their frequencies differ by host for reasons that have
 * nothing to do with translation efficiency.
 */
export const CODON_FREQUENCIES = {
  e_coli: {
    GCA: 0.21, GCC: 0.27, GCG: 0.36, GCT: 0.16,
    TGC: 0.55, TGT: 0.45, GAC: 0.37, GAT: 0.63,
    GAA: 0.69, GAG: 0.31, TTC: 0.43, TTT: 0.57,
    GGA: 0.11, GGC: 0.40, GGG: 0.15, GGT: 0.34,
    CAC: 0.43, CAT: 0.57, ATA: 0.07, ATC: 0.42,
    ATT: 0.51, AAA: 0.76, AAG: 0.24, CTA: 0.04,
    CTC: 0.10, CTG: 0.50, CTT: 0.10, TTA: 0.13,
    TTG: 0.13, ATG: 1.00, AAC: 0.50, AAT: 0.50,
    CCA: 0.19, CCC: 0.12, CCG: 0.53, CCT: 0.16,
    CAA: 0.34, CAG: 0.66, AGA: 0.04, AGG: 0.02,
    CGA: 0.06, CGC: 0.40, CGG: 0.10, CGT: 0.38,
    AGC: 0.28, AGT: 0.15, TCA: 0.12, TCC: 0.15,
    TCG: 0.15, TCT: 0.15, ACA: 0.13, ACC: 0.44,
    ACG: 0.26, ACT: 0.17, GTA: 0.15, GTC: 0.22,
    GTG: 0.37, GTT: 0.26, TGG: 1.00, TAC: 0.43,
    TAT: 0.57,
  },
  yeast: {
    GCA: 0.28, GCC: 0.16, GCG: 0.16, GCT: 0.40,
    TGC: 0.37, TGT: 0.63, GAC: 0.35, GAT: 0.65,
    GAA: 0.70, GAG: 0.30, TTC: 0.41, TTT: 0.59,
    GGA: 0.22, GGC: 0.13, GGG: 0.18, GGT: 0.47,
    CAC: 0.42, CAT: 0.58, ATA: 0.27, ATC: 0.27,
    ATT: 0.46, AAA: 0.58, AAG: 0.42, CTA: 0.14,
    CTC: 0.06, CTG: 0.11, CTT: 0.13, TTA: 0.28,
    TTG: 0.28, ATG: 1.00, AAC: 0.50, AAT: 0.50,
    CCA: 0.42, CCC: 0.15, CCG: 0.12, CCT: 0.31,
    CAA: 0.69, CAG: 0.31, AGA: 0.48, AGG: 0.21,
    CGA: 0.07, CGC: 0.06, CGG: 0.04, CGT: 0.14,
    AGC: 0.11, AGT: 0.16, TCA: 0.21, TCC: 0.16,
    TCG: 0.10, TCT: 0.26, ACA: 0.30, ACC: 0.23,
    ACG: 0.12, ACT: 0.35, GTA: 0.21, GTC: 0.21,
    GTG: 0.19, GTT: 0.39, TGG: 1.00, TAC: 0.44,
    TAT: 0.56,
  },
  human: {
    GCA: 0.23, GCC: 0.26, GCG: 0.08, GCT: 0.43,
    TGC: 0.55, TGT: 0.45, GAC: 0.54, GAT: 0.46,
    GAA: 0.42, GAG: 0.58, TTC: 0.55, TTT: 0.45,
    GGA: 0.25, GGC: 0.34, GGG: 0.25, GGT: 0.16,
    CAC: 0.59, CAT: 0.41, ATA: 0.16, ATC: 0.48,
    ATT: 0.36, AAA: 0.42, AAG: 0.58, CTA: 0.07,
    CTC: 0.20, CTG: 0.40, CTT: 0.13, TTA: 0.07,
    TTG: 0.13, ATG: 1.00, AAC: 0.50, AAT: 0.50,
    CCA: 0.28, CCC: 0.33, CCG: 0.11, CCT: 0.28,
    CAA: 0.25, CAG: 0.75, AGA: 0.21, AGG: 0.20,
    CGA: 0.11, CGC: 0.19, CGG: 0.20, CGT: 0.09,
    AGC: 0.24, AGT: 0.15, TCA: 0.15, TCC: 0.22,
    TCG: 0.06, TCT: 0.18, ACA: 0.28, ACC: 0.36,
    ACG: 0.12, ACT: 0.24, GTA: 0.11, GTC: 0.24,
    GTG: 0.47, GTT: 0.18, TGG: 1.00, TAC: 0.57,
    TAT: 0.43,
  },
};

/** The eight amino acids whose six codons make Nc's arithmetic meaningful. */
const SIX_CODON = new Set(['L', 'R', 'S']);
const FOUR_CODON = new Set(['A', 'P', 'T', 'V', 'G']);
const THREE_CODON = new Set(['I']);
const TWO_CODON = new Set(['F', 'Y', 'C', 'H', 'Q', 'N', 'K', 'D', 'E']);

/** The two-, three-, four- and six-codon families Nc's tables cover. */
const FAMILY_SIZE = new Map([...SIX_CODON].map((aminoAcid) => [aminoAcid, 6]));
for (const aminoAcid of FOUR_CODON) FAMILY_SIZE.set(aminoAcid, 4);
for (const aminoAcid of THREE_CODON) FAMILY_SIZE.set(aminoAcid, 3);
for (const aminoAcid of TWO_CODON) FAMILY_SIZE.set(aminoAcid, 2);

/** Amino acids whose family has more than one codon (bias is measurable). */
function isSingletonFamily(aminoAcid) {
  return !FAMILY_SIZE.has(aminoAcid) || FAMILY_SIZE.get(aminoAcid) === 1;
}

const STOP_CODONS = new Set(['TAA', 'TAG', 'TGA']);

/** Codon -> amino acid, taken from lib.mjs's standard code (single source). */
const STANDARD_CODE = CODON_TABLE_BY_NAME.standard;

/**
 * Every sense codon of `host`, grouped by amino acid, taken from the COMPLETE
 * frequency table. Deriving the families from the optimization ordering in
 * protein.mjs would silently shrink each family to the codons that optimizer
 * happens to list (E. coli alanine has four, the optimizer names three), and a
 * short family corrupts both RSCU (wrong codon count) and CAI (wrong maximum).
 * `test/smoke.mjs` pins the family sizes for exactly this reason.
 */
function familiesOf(host) {
  const families = new Map();
  for (const [codon, fraction] of Object.entries(CODON_FREQUENCIES[host])) {
    if (STOP_CODONS.has(codon)) continue;
    const aminoAcid = STANDARD_CODE[codon];
    if (aminoAcid === undefined || aminoAcid === '*') continue;
    if (!families.has(aminoAcid)) families.set(aminoAcid, []);
    families.get(aminoAcid).push([codon, fraction]);
  }
  for (const entries of families.values()) entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return families;
}

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Analyse one coding sequence.
 *
 * @param {string} raw CDS sequence (ACGT, IUPAC ambiguity tolerated and counted)
 * @param {{host?: string, region_window?: number}} [options]
 */
export function codonUsageAnalysis(raw, options = {}) {
  const host = options.host ?? 'e_coli';
  if (CODON_FREQUENCIES[host] === undefined) {
    throw new MolbioInputError(`unknown host ${JSON.stringify(host)}; available: ${CODON_HOSTS.join(', ')}`);
  }
  const sequence = String(raw).toUpperCase().replace(/[\s\d]+/g, '');
  if (sequence === '') throw new MolbioInputError('the coding sequence is empty');
  if (!/^[ACGTURYSWKMBDHVN]+$/.test(sequence)) {
    throw new MolbioInputError('the coding sequence contains characters that are not IUPAC nucleotides');
  }
  // U is accepted for RNA input but treated as T throughout (as elsewhere in
  // this package).
  const normalized = sequence.replace(/U/g, 'T');
  const warnings = [];
  if (normalized.length % 3 !== 0) {
    warnings.push(`length ${normalized.length} is not a multiple of 3; trailing ${normalized.length % 3} base(s) are ignored`);
  }
  const completeLength = normalized.length - (normalized.length % 3);
  const codons = [];
  for (let index = 0; index + 3 <= completeLength; index += 3) codons.push(normalized.slice(index, index + 3));
  if (codons.length === 0) throw new MolbioInputError('the coding sequence is shorter than one codon');

  const ambiguous = codons.filter((codon) => !/^[ACGT]{3}$/.test(codon));
  const definite = codons.filter((codon) => /^[ACGT]{3}$/.test(codon));
  if (ambiguous.length > 0) warnings.push(`${ambiguous.length} codon(s) contain ambiguous bases and are excluded from the frequency counts`);
  if (!normalized.startsWith('ATG')) warnings.push('the sequence does not start with ATG (no obvious start codon)');
  const internalStops = [];
  definite.forEach((codon, index) => {
    if (!STOP_CODONS.has(codon)) return;
    // A stop is only "internal" when it is not the final codon of the CDS —
    // a terminal stop is the normal end of a coding sequence.
    if (index === definite.length - 1) return;
    internalStops.push({ codon, position: index + 1 });
  });
  if (internalStops.length > 0) warnings.push(`${internalStops.length} internal stop codon(s) found`);
  const lastCodon = definite[definite.length - 1];
  const hasStop = lastCodon !== undefined && STOP_CODONS.has(lastCodon);

  // ── counts and fractions ──────────────────────────────────────────────────
  const counts = new Map();
  for (const codon of definite) {
    if (STOP_CODONS.has(codon)) continue;
    counts.set(codon, (counts.get(codon) ?? 0) + 1);
  }
  const totalCodons = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (totalCodons === 0) throw new MolbioInputError('no unambiguous sense codons to analyse');

  const families = familiesOf(host);
  const familySize = (entries) => entries.length;

  // ── RSCU ──────────────────────────────────────────────────────────────────
  const rscu = {};
  const familyObserved = new Map();
  for (const [aminoAcid, entries] of families) {
    let observed = 0;
    for (const [codon] of entries) observed += counts.get(codon) ?? 0;
    familyObserved.set(aminoAcid, observed);
    const codonCount = familySize(entries);
    for (const [codon] of entries) {
      const count = counts.get(codon) ?? 0;
      rscu[codon] = observed === 0 ? 0 : round((count / observed) * codonCount, 4);
    }
  }

  // ── CAI (Sharp & Li) ─────────────────────────────────────────────────────
  // Two passes: every codon of every multi-codon family gets a reported weight
  // (so the output shows what the alternatives would have scored), while only
  // the codons actually PRESENT in the sequence enter the geometric mean.
  const zeroFrequencyCodons = [];
  const weights = new Map();
  for (const [, entries] of families) {
    if (entries.length === 1) continue; // Met / Trp: w is 1 by definition
    const maxFrequency = Math.max(...entries.map(([, frequency]) => frequency));
    for (const [codon, frequency] of entries) {
      if (frequency === 0) {
        weights.set(codon, 0.5 / maxFrequency);
        zeroFrequencyCodons.push(codon);
      } else {
        weights.set(codon, frequency / maxFrequency);
      }
    }
  }
  let logSum = 0;
  let caiCodons = 0;
  const caiByCodon = {};
  const caiCounted = {};
  for (const [codon, weight] of [...weights].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    caiByCodon[codon] = round(weight, 4);
    const count = counts.get(codon) ?? 0;
    if (count === 0) continue;
    caiCounted[codon] = count;
    logSum += count * Math.log(weight);
    caiCodons += count;
  }
  const cai = caiCodons === 0 ? 0 : round(Math.exp(logSum / caiCodons), 4);
  // A CDS made only of Met/Trp has no synonymous choice at all, so a CAI of 0
  // would be a number with no meaning — say so instead of reporting it.
  if (caiCodons === 0) {
    throw new MolbioInputError('no codon with synonymous alternatives to score: CAI needs at least one codon from a multi-codon family (a sequence of only ATG/TGG has none)');
  }

  // ── Nc (Wright 1990) ─────────────────────────────────────────────────────
  const gc3Counts = { A: 0, C: 0, G: 0, T: 0 };
  const positionGc = [0, 0, 0];
  for (const codon of definite) {
    for (let position = 0; position < 3; position++) {
      if (codon[position] === 'G' || codon[position] === 'C') positionGc[position]++;
    }
  }
  for (const codon of definite) {
    const third = codon[2];
    if (gc3Counts[third] !== undefined) gc3Counts[third]++;
  }
  const gc3Total = Object.values(gc3Counts).reduce((sum, value) => sum + value, 0);
  const gc3 = gc3Total === 0 ? 0 : round(((gc3Counts.G + gc3Counts.C) / gc3Total) * 100, 2);
  const gc123 = positionGc.map((value) => (definite.length === 0 ? 0 : round((value / definite.length) * 100, 2)));

  let nc = 0;
  let ncUsableFamilies = 0;
  const ncDetail = [];
  for (const [aminoAcid, entries] of families) {
    const observed = familyObserved.get(aminoAcid) ?? 0;
    const codonCount = entries.length;
    if (observed === 0) continue;
    if (codonCount === 1) continue; // Met/Trp carry no information about bias
    let sumSquares = 0;
    for (const [codon] of entries) {
      const count = counts.get(codon) ?? 0;
      sumSquares += (count / observed) ** 2;
    }
    const homozygosity = (observed * sumSquares - 1) / (observed - 1);
    const expected = expectedHomozygosity(gc3, codonCount);
    if (expected === undefined) {
      nc += 1 / Math.max(homozygosity, 1e-9);
      ncUsableFamilies++;
      ncDetail.push({ amino_acid: aminoAcid, codons: codonCount, homozygosity: round(homozygosity, 4), expectation: 'observed' });
      continue;
    }
    nc += 1 / Math.max(expected, 1e-9);
    ncUsableFamilies++;
    ncDetail.push({ amino_acid: aminoAcid, codons: codonCount, homozygosity: round(homozygosity, 4), expectation: round(expected, 4) });
  }
  const ncValue = ncUsableFamilies === 0 ? 0 : round(nc, 2);

  // ── rare codons ──────────────────────────────────────────────────────────
  const rareCodons = [];
  definite.forEach((codon, index) => {
    if (STOP_CODONS.has(codon)) return;
    const aminoAcid = STANDARD_CODE[codon];
    if (isSingletonFamily(aminoAcid)) return;
    const entries = families.get(aminoAcid) ?? [];
    const maxFrequency = Math.max(...entries.map(([, frequency]) => frequency));
    const frequency = CODON_FREQUENCIES[host][codon] ?? 0;
    const weight = frequency === 0 ? 0.5 / maxFrequency : frequency / maxFrequency;
    if (weight >= 0.2) return;
    rareCodons.push({
      position: index + 1,
      codon,
      amino_acid: aminoAcid,
      host_frequency: round(frequency, 4),
      relative_adaptiveness: round(weight, 4),
    });
  });

  // ── CpG in the CDS ───────────────────────────────────────────────────────
  let cpg = 0;
  let cpgOpportunities = 0;
  const cpgText = codons.join('');
  for (let index = 0; index + 1 < cpgText.length; index++) {
    if (cpgText[index] === 'C' && cpgText[index + 1] === 'G') cpg++;
  }
  const cCount = [...cpgText].filter((base) => base === 'C').length;
  const gCount = [...cpgText].filter((base) => base === 'G').length;
  if (cpgText.length > 1) cpgOpportunities = ((cCount * gCount) / cpgText.length);
  const cpgRatio = cpgOpportunities === 0 ? 0 : round(cpg / cpgOpportunities, 3);
  if (cpgRatio < 0.5 && cpgText.length >= 100) {
    warnings.push(`CpG observed/expected is ${cpgRatio} (below 0.5), which is typical of vertebrate exons and can lower expression from a mammalian promoter`);
  }

  // ── sliding-window CAI (optional) ────────────────────────────────────────
  let caiProfile = [];
  const window = options.region_window ?? 0;
  if (Number.isInteger(window) && window > 0) {
    if (window < 3) throw new MolbioInputError('region_window must be at least 3 codons');
    const weights = [];
    for (const codon of definite) {
      const aminoAcid = STANDARD_CODE[codon];
      const entries = families.get(aminoAcid) ?? [];
      if (isSingletonFamily(aminoAcid) || STOP_CODONS.has(codon)) {
        weights.push(undefined);
        continue;
      }
      const maxFrequency = Math.max(...entries.map(([, frequency]) => frequency));
      const frequency = CODON_FREQUENCIES[host][codon] ?? 0;
      weights.push(frequency === 0 ? 0.5 / maxFrequency : frequency / maxFrequency);
    }
    for (let start = 0; start + window <= definite.length; start++) {
      const slice = weights.slice(start, start + window).filter((value) => value !== undefined);
      if (slice.length === 0) continue;
      const mean = Math.exp(slice.reduce((sum, value) => sum + Math.log(value), 0) / slice.length);
      caiProfile.push({ start_codon: start + 1, end_codon: start + window, cai: round(mean, 4) });
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const aminoAcidCounts = new Map();
  for (const codon of definite) {
    const aminoAcid = STANDARD_CODE[codon];
    if (aminoAcid === undefined || aminoAcid === '*') continue;
    aminoAcidCounts.set(aminoAcid, (aminoAcidCounts.get(aminoAcid) ?? 0) + 1);
  }
  if (cai < 0.5) {
    warnings.push(`CAI ${cai} is low: many codons are rare in ${host}, so expression may benefit from optimization`);
  }
  const caiInterpretation = cai >= 0.8
    ? 'well adapted to this host'
    : cai >= 0.6
      ? 'moderately adapted; a few rare codons'
      : 'poorly adapted; optimization is likely to help';

  return {
    host,
    length: normalized.length,
    analysed_codons: definite.length,
    ignored_trailing_bases: normalized.length - completeLength,
    cai,
    cai_interpretation: caiInterpretation,
    cai_codons: caiCodons,
    cai_by_codon: caiByCodon,
    cai_counted_codons: caiCounted,
    cai_profile: caiProfile,
    zero_frequency_codons: [...new Set(zeroFrequencyCodons)],
    n_codon: ncValue,
    n_codon_interpretation: ncValue === 0
      ? 'not computable for this sequence'
      : ncValue < 35
        ? 'strong codon bias'
        : ncValue < 50
          ? 'moderate codon bias'
          : 'little codon bias',
    gc3,
    gc123,
    gc3_distribution: { A: gc3Counts.A, C: gc3Counts.C, G: gc3Counts.G, T: gc3Counts.T },
    rscu,
    codon_counts: Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    amino_acid_counts: Object.fromEntries([...aminoAcidCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    rare_codons: rareCodons.slice(0, 200),
    rare_codon_count: rareCodons.length,
    cpg: {
      observed: cpg,
      expected: round(cpgOpportunities, 2),
      observed_expected: cpgRatio,
      interpretation: cpgText.length < 100 ? 'not interpreted for sequences under 100 nt' : (cpgRatio < 0.5 ? 'CpG-suppressed (typical of vertebrate exons)' : 'no CpG suppression detected'),
    },
    internal_stops: internalStops.slice(0, 50),
    internal_stop_count: internalStops.length,
    has_start_codon: normalized.startsWith('ATG'),
    has_stop_codon: hasStop,
    standard_code: 'standard',
    warnings,
  };
}

/**
 * Wright's expected homozygosity for a family of `codonCount` codons at the
 * sequence's GC3, from the published tables. Families of six are the average of
 * their two-codon and four-codon groups, which is what makes Nc respond to GC3
 * bias. Families of one (Met, Trp) carry no information and return undefined.
 */
function expectedHomozygosity(gc3, codonCount) {
  const p = Math.max(0, Math.min(1, gc3 / 100));
  if (codonCount === 2) return 0.5 + p / 2;
  if (codonCount === 3) return 2 / 3 + p / 3;
  if (codonCount === 4) return 0.75 + p / 4;
  if (codonCount === 6) return (2 / 6) * (0.5 + p / 2) + (4 / 6) * (0.75 + p / 4);
  return undefined;
}
