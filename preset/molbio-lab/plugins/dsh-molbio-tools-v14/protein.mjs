/**
 * dsh-molbio-tools/protein.mjs
 *
 * Protein tools: physicochemical properties (MW, pI, extinction coefficient,
 * GRAVY, aliphatic index), in silico protease digestion for mass spectrometry,
 * and host-aware codon optimization. All values are ESTIMATES computed with
 * published parameters (Bjellqvist 1993 pK values, Kyte-Doolittle
 * hydropathy, Ikai 1980 aliphatic index, monoisotopic residue masses).
 */

import { MolbioInputError } from './lib.mjs';

const AA_SET = new Set('ACDEFGHIKLMNPQRSTVWY');

export function normalizeProtein(raw, label = 'protein') {
  if (typeof raw !== 'string') throw new MolbioInputError(`${label} must be a string`);
  const seq = raw.toUpperCase().replace(/[\s\d*._-]/g, '');
  if (seq.length === 0) throw new MolbioInputError(`${label} contains no amino acids`);
  for (const aa of seq) {
    if (!AA_SET.has(aa)) throw new MolbioInputError(`${label} contains invalid character ${JSON.stringify(aa)}; expected one-letter amino acid codes`);
  }
  return seq;
}

// ── physicochemical properties ──────────────────────────────────────────────

const RESIDUE_MASS = {
  A: 71.08, R: 156.19, N: 114.10, D: 115.09, C: 103.14, E: 129.12,
  Q: 128.13, G: 57.05, H: 137.14, I: 113.16, L: 113.16, K: 128.17,
  M: 131.19, F: 147.18, P: 97.12, S: 87.08, T: 101.10, W: 186.21,
  Y: 163.18, V: 99.13,
};
const WATER = 18.015;

// Bjellqvist 1993 pK values (EMBOSS-style)
const PK = {
  Nterm: 8.6, Cterm: 3.6, C: 9.0, D: 4.05, E: 4.45, H: 6.04,
  K: 10.8, R: 12.0, Y: 10.3,
};

const HYDROPATHY = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5,
  G: -0.4, H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8,
  P: -1.6, S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2,
};

function countAminoAcids(seq) {
  const counts = {};
  for (const aa of seq) counts[aa] = (counts[aa] ?? 0) + 1;
  return counts;
}

function chargeAt(seq, counts, pH) {
  let charge = 0;
  const pos = (pKa) => 1 / (1 + Math.pow(10, pH - pKa));
  const neg = (pKa) => 1 / (1 + Math.pow(10, pKa - pH));
  charge += pos(PK.Nterm);
  for (const [aa, pKa] of [['K', PK.K], ['R', PK.R], ['H', PK.H]]) {
    if (counts[aa] !== undefined) charge += counts[aa] * pos(pKa);
  }
  charge -= neg(PK.Cterm);
  for (const [aa, pKa] of [['D', PK.D], ['E', PK.E], ['C', PK.C], ['Y', PK.Y]]) {
    if (counts[aa] !== undefined) charge -= counts[aa] * neg(pKa);
  }
  return charge;
}

/** Isoelectric point by bisection over the net-charge function. */
export function isoelectricPoint(seq, counts) {
  let lo = 0;
  let hi = 14;
  let chargeLo = chargeAt(seq, counts, lo);
  let chargeHi = chargeAt(seq, counts, hi);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const chargeMid = chargeAt(seq, counts, mid);
    if (Math.abs(chargeMid) < 1e-4) return Math.round(mid * 100) / 100;
    if (Math.sign(chargeMid) === Math.sign(chargeLo)) {
      lo = mid;
      chargeLo = chargeMid;
    } else {
      hi = mid;
      chargeHi = chargeMid;
    }
  }
  return Math.round(((lo + hi) / 2) * 100) / 100;
}

/** Protein physicochemical properties (estimates). */
export function proteinProperties(raw) {
  const seq = normalizeProtein(raw);
  const counts = countAminoAcids(seq);
  let mw = WATER;
  for (const aa of seq) mw += RESIDUE_MASS[aa];
  const pi = isoelectricPoint(seq, counts);
  const w = counts.W ?? 0;
  const y = counts.Y ?? 0;
  const c = counts.C ?? 0;
  const extReduced = 5500 * w + 1490 * y;
  const extOxidized = extReduced + 125 * Math.floor(c / 2);
  let gravy = 0;
  for (const aa of seq) gravy += HYDROPATHY[aa];
  gravy = seq.length === 0 ? 0 : gravy / seq.length;
  const aliphatic = 100 * ((counts.A ?? 0) + 2.9 * (counts.V ?? 0) + 3.9 * (counts.I ?? 0) + 3.9 * (counts.L ?? 0)) / seq.length;
  const round4 = (v) => Math.round(v * 10000) / 10000;
  const round2 = (v) => Math.round(v * 100) / 100;
  return {
    length: seq.length,
    mw_da: round2(mw),
    pi: pi,
    extinction_reduced_m1cm1: extReduced,
    extinction_oxidized_m1cm1: extOxidized,
    absorbance_0_1_percent: round4((extReduced / mw) * 10),
    gravy: round4(gravy),
    aliphatic_index: round2(aliphatic),
  };
}

// ── peptide digestion ───────────────────────────────────────────────────────

const MONO_MASS = {
  A: 71.03711, R: 156.10111, N: 114.04293, D: 115.02694, C: 103.00919,
  E: 129.04259, Q: 128.05858, G: 57.02146, H: 137.05891, I: 113.08406,
  L: 113.08406, K: 128.09496, M: 131.04049, F: 147.06841, P: 97.05276,
  S: 87.03203, T: 101.04768, W: 186.07931, Y: 163.06333, V: 99.06841,
};
const AVG_MASS = {
  A: 71.0788, R: 156.1875, N: 114.1038, D: 115.0886, C: 103.1388,
  E: 129.1155, Q: 128.1307, G: 57.0519, H: 137.1411, I: 113.1594,
  L: 113.1594, K: 128.1741, M: 131.1926, F: 147.1766, P: 97.1167,
  S: 87.0782, T: 101.1051, W: 186.2132, Y: 163.1760, V: 99.1326,
};
const H_PLUS = 1.00728;
const H2O_MASS = 18.01056;

const PROTEASES = {
  trypsin: { after: new Set(['K', 'R']), label: 'trypsin (after K/R, not before P)' },
  chymotrypsin: { after: new Set(['F', 'Y', 'W']), label: 'chymotrypsin (after F/Y/W, not before P)' },
  lysc: { after: new Set(['K']), label: 'LysC (after K, not before P)' },
  gluc: { after: new Set(['E']), label: 'GluC (after E)' },
};

/** In silico protease digestion with missed cleavages and [M+H]+ masses. */
export function peptideDigest(raw, { enzyme = 'trypsin', missed = 0, massType = 'monoisotopic', minMass, maxMass } = {}) {
  const seq = normalizeProtein(raw);
  const protease = PROTEASES[enzyme];
  if (protease === undefined) throw new MolbioInputError(`unknown protease ${JSON.stringify(enzyme)}; available: ${Object.keys(PROTEASES).join(', ')}`);
  if (!Number.isInteger(missed) || missed < 0 || missed > 3) throw new MolbioInputError('missed must be an integer between 0 and 3');
  const masses = massType === 'monoisotopic' ? MONO_MASS : massType === 'average' ? AVG_MASS : undefined;
  if (masses === undefined) throw new MolbioInputError('mass_type must be "monoisotopic" or "average"');

  // cut positions: index after which the bond breaks (0-based index of the
  // residue the protease cuts after); no cut when the next residue is P.
  const cuts = [];
  for (let i = 0; i < seq.length; i++) {
    if (!protease.after.has(seq[i])) continue;
    if (i + 1 < seq.length && seq[i + 1] === 'P') continue;
    cuts.push(i);
  }

  // base peptides (0 missed cleavages): bounds are the 0-based indices of the
  // last residue of each peptide; a cut after the final residue adds nothing.
  const bounds = [-1, ...cuts];
  if (bounds[bounds.length - 1] !== seq.length - 1) bounds.push(seq.length - 1);
  const bases = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i] + 1;
    const end = bounds[i + 1];
    if (start > end) continue;
    bases.push({ start: start + 1, end: end + 1, sequence: seq.slice(start, end + 1), missed: 0 });
  }

  const mhMass = (peptide) => {
    let sum = H2O_MASS + H_PLUS;
    for (const aa of peptide) sum += masses[aa];
    return Math.round(sum * 10000) / 10000;
  };

  const peptides = [];
  const seen = new Set();
  const push = (start, end, sequence, m) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mass = mhMass(sequence);
    if (minMass !== undefined && mass < minMass) return;
    if (maxMass !== undefined && mass > maxMass) return;
    peptides.push({
      start,
      end,
      sequence,
      length: sequence.length,
      mh_mass: mass,
      missed: m,
    });
  };

  for (const base of bases) push(base.start, base.end, base.sequence, 0);
  for (let m = 1; m <= missed; m++) {
    for (let i = 0; i + m < bases.length; i++) {
      const merged = bases.slice(i, i + m + 1);
      push(
        merged[0].start,
        merged[merged.length - 1].end,
        seq.slice(merged[0].start - 1, merged[merged.length - 1].end),
        m,
      );
    }
  }
  peptides.sort((a, b) => a.start - b.start || a.end - b.end);
  return { enzyme, missed_cleavages: missed, mass_type: massType, peptides };
}

// ── codon optimization ──────────────────────────────────────────────────────

/** Preferred codons per host (published high-frequency tables; heuristic). */
const CODON_USAGE = {
  e_coli: {
    A: ['GCG', 'GCT', 'GCC'], R: ['CGT', 'CGC', 'CGG'], N: ['AAC', 'AAT'],
    D: ['GAC', 'GAT'], C: ['TGC', 'TGT'], Q: ['CAG', 'CAA'], E: ['GAA', 'GAG'],
    G: ['GGC', 'GGT', 'GGG'], H: ['CAC', 'CAT'], I: ['ATC', 'ATT'],
    L: ['CTG', 'CTC', 'CTT'], K: ['AAA', 'AAG'], M: ['ATG'],
    F: ['TTC', 'TTT'], P: ['CCG', 'CCT', 'CCC'], S: ['AGC', 'TCT', 'TCC'],
    T: ['ACC', 'ACT', 'ACG'], W: ['TGG'], Y: ['TAC', 'TAT'], V: ['GTG', 'GTT', 'GTC'],
  },
  yeast: {
    A: ['GCT', 'GCC'], R: ['AGA', 'CGT'], N: ['AAC', 'AAT'],
    D: ['GAC', 'GAT'], C: ['TGT', 'TGC'], Q: ['CAA', 'CAG'], E: ['GAA', 'GAG'],
    G: ['GGT', 'GGC'], H: ['CAC', 'CAT'], I: ['ATC', 'ATT'],
    L: ['TTG', 'TTA', 'CTG'], K: ['AAG', 'AAA'], M: ['ATG'],
    F: ['TTC', 'TTT'], P: ['CCA', 'CCT'], S: ['TCT', 'TCC', 'AGC'],
    T: ['ACT', 'ACC', 'ACA'], W: ['TGG'], Y: ['TAC', 'TAT'], V: ['GTT', 'GTC', 'GTG'],
  },
  human: {
    A: ['GCC', 'GCT'], R: ['CGG', 'CGC', 'AGG'], N: ['AAC', 'AAT'],
    D: ['GAC', 'GAT'], C: ['TGC', 'TGT'], Q: ['CAG', 'CAA'], E: ['GAG', 'GAA'],
    G: ['GGC', 'GGA', 'GGT'], H: ['CAC', 'CAT'], I: ['ATC', 'ATT'],
    L: ['CTG', 'CTC', 'CTT'], K: ['AAG', 'AAA'], M: ['ATG'],
    F: ['TTC', 'TTT'], P: ['CCC', 'CCT', 'CCA'], S: ['AGC', 'TCC', 'TCT'],
    T: ['ACC', 'ACA', 'ACT'], W: ['TGG'], Y: ['TAC', 'TAT'], V: ['GTG', 'GTC', 'GTT'],
  },
};

export const CODON_HOSTS = Object.keys(CODON_USAGE);

/**
 * Codon-optimize a protein for a host. Deterministic: the first choice per
 * amino acid is the preferred codon; synonymous swaps are used only to remove
 * avoided restriction sites (bounded, deterministic).
 */
export function codonOptimize(raw, { host = 'e_coli', avoidEnzymes = [] } = {}) {
  const seq = normalizeProtein(raw);
  const usage = CODON_USAGE[host];
  if (usage === undefined) throw new MolbioInputError(`unknown host ${JSON.stringify(host)}; available: ${CODON_HOSTS.join(', ')}`);
  if (!Array.isArray(avoidEnzymes) || avoidEnzymes.length > 20) throw new MolbioInputError('avoid_enzymes must be an array of at most 20 enzyme names');

  const dna = seq.split('').map((aa) => usage[aa][0]).join('');
  const avoidedSites = [];
  for (const name of avoidEnzymes) {
    const site = avoidSitePattern(name);
    for (const start of findSitePositions(dna, site)) {
      avoidedSites.push({ enzyme: name, start: start + 1, sequence: dna.slice(start, start + site.length) });
    }
  }

  // Synonym swap away from avoided sites: replace the overlapping codons with
  // the next alternative and re-scan, bounded passes.
  let working = dna;
  const notes = [];
  if (avoidedSites.length > 0) {
    let changed = true;
    let guard = 0;
    while (changed && guard < 10) {
      guard++;
      changed = false;
      for (const name of avoidEnzymes) {
        const site = avoidSitePattern(name);
        for (const start of findSitePositions(working, site)) {
          const codonStart = Math.floor(start / 3) * 3;
          const aaIndex = codonStart / 3;
          const aa = seq[aaIndex];
          const alternatives = usage[aa];
          const current = working.slice(codonStart, codonStart + 3);
          const next = alternatives[(alternatives.indexOf(current) + 1) % alternatives.length];
          if (next !== undefined && next !== current) {
            working = working.slice(0, codonStart) + next + working.slice(codonStart + 3);
            changed = true;
            notes.push(`${name} site removed by swapping codon ${aaIndex + 1} (${aa}) from ${current} to ${next}`);
            break;
          }
        }
        if (changed) break;
      }
    }
  }

  let remaining = 0;
  for (const name of avoidEnzymes) {
    remaining += findSitePositions(working, avoidSitePattern(name)).length;
  }

  const { gc, at } = (() => {
    let g = 0;
    let a = 0;
    for (const base of working) {
      if (base === 'G' || base === 'C') g++;
      else a++;
    }
    return { gc: g, at: a };
  })();

  return {
    host,
    dna_sequence: working,
    length: working.length,
    gc_percent: Math.round((gc / (gc + at)) * 1000) / 10,
    avoided_sites_remaining: remaining,
    notes,
  };
}

function avoidSitePattern(name) {
  // Avoid-site checks use the built-in enzyme table; unknown names error.
  const sites = {
    EcoRI: 'GAATTC', HindIII: 'AAGCTT', BamHI: 'GGATCC', XhoI: 'CTCGAG',
    XbaI: 'TCTAGA', NotI: 'GCGGCCGC', NcoI: 'CCATGG', NdeI: 'CATATG',
    PstI: 'CTGCAG', SacI: 'GAGCTC', SalI: 'GTCGAC', SpeI: 'ACTAGT',
    SphI: 'GCATGC', KpnI: 'GGTACC', SmaI: 'CCCGGG', XmaI: 'CCCGGG',
    BglII: 'AGATCT', EcoRV: 'GATATC', PvuII: 'CAGCTG', ClaI: 'ATCGAT',
    ApaI: 'GGGCCC', NheI: 'GCTAGC', MfeI: 'CAATTG', NsiI: 'ATGCAT',
    PacI: 'TTAATTAA', SbfI: 'CCTGCAGG', AscI: 'GGCGCGCC', FseI: 'GGCCGGCC',
    AgeI: 'ACCGGT', AvrII: 'CCTAGG', BclI: 'TGATCA', BstEII: 'GGTNACC',
    Bsu36I: 'CCTNAGG', DraI: 'TTTAAA', EagI: 'CGGCCG', HpaI: 'GTTAAC',
    MluI: 'ACGCGT', NruI: 'TCGCGA', PmeI: 'GTTTAAAC', PmlI: 'CACGTG',
    PspOMI: 'GGGCCC', RsrII: 'CGGWCCG', SacII: 'CCGCGG', ScaI: 'AGTACT',
    SexAI: 'ACCWGGT', StuI: 'AGGCCT', XmnI: 'GAANNNNTTC',
    AatII: 'GACGTC', Acc65I: 'GGTACC', AflII: 'CTTAAG', AseI: 'ATTAAT',
    BsrGI: 'TGTACA', BssHII: 'GCGCGC', KasI: 'GGCGCC', MscI: 'TGGCCA',
    NaeI: 'GCCGGC', NarI: 'GGCGCC', NgoMIV: 'GCCGGC', PciI: 'ACATGT',
    PvuI: 'CGATCG', SnaBI: 'TACGTA', SspI: 'AATATT', SrfI: 'GCCCGGGC',
    ZraI: 'GACGTC', HincII: 'GTYRAC', PpuMI: 'RGGWCCY', BsaAI: 'YACGTR',
    BsaI: 'GGTCTC', BsmBI: 'CGTCTC', Esp3I: 'CGTCTC', BbsI: 'GAAGAC',
    BspQI: 'GCTCTTC', SapI: 'GCTCTTC', LguI: 'GCTCTTC', PaqCI: 'CACCTGC',
    AarI: 'CACCTGC', BfuAI: 'ACCTGC', BveI: 'ACCTGC', BtgZI: 'GCGATG',
    BsmFI: 'GGGAC', FokI: 'GGATG',
  };
  if (!Object.hasOwn(sites, name)) {
    throw new MolbioInputError(`avoid_enzymes contains an unknown enzyme ${JSON.stringify(name)}; use names from the built-in table (e.g. EcoRI, HindIII, NotI)`);
  }
  return sites[name];
}

const AMBIGUITY = {
  R: 'AG', Y: 'CT', S: 'CG', K: 'GT', M: 'AC', W: 'AT',
  B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT',
};

function findSitePositions(seq, pattern) {
  const out = [];
  for (let start = 0; start + pattern.length <= seq.length; start++) {
    let match = true;
    for (let i = 0; i < pattern.length; i++) {
      const allowed = AMBIGUITY[pattern[i]] ?? pattern[i];
      if (!allowed.includes(seq[start + i])) {
        match = false;
        break;
      }
    }
    if (match) out.push(start);
  }
  return out;
}
