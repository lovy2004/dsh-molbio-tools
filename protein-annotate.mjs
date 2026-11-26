/**
 * dsh-molbio-tools/protein-annotate.mjs
 *
 * Protein annotation that the property tools do not answer: post-translational-
 * modification motifs, low complexity, instability, signal-peptide cleavage and
 * antigenic propensity.
 *
 * Every number here is an ESTIMATE from a published, transcribed table. None of
 * it is a trained predictor: TMHMM / SignalP / NetNGlyc / BepiPred are models;
 * these are documented heuristics, and every tool text says so.
 *
 * Parameter tables (values transcribed here, never downloaded at runtime):
 *   - Guruprasad 1990 DIWV instability table (20x20): Biopython 1.88
 *     Bio/SeqUtils/ProtParamData.py (BSD-3), the reference implementation of the
 *     published table.
 *   - Kolaskar & Tongaonkar 1990 A(p) (20 values): EMBOSS 6.6.0
 *     data/Eantigenic.dat.
 *   - von Heijne 1986 signal-peptide counts (eukaryote 161 sequences,
 *     prokaryote 36): EMBOSS 6.6.0 data/Esig.euk and data/Esig.pro. Position
 *     weights are log(count/expected), exactly as EMBOSS sigcleave builds them.
 *   - Parker 1986 hydrophilicity, Emini 1997 accessibility and Vihinen 1994
 *     flexibility (20 values each): Biopython 1.88 ProtParamData.py.
 */

import { MolbioInputError } from './lib.mjs';
import { normalizeProtein } from './protein.mjs';
import { HYDROPATHY_DEFAULTS, hydropathyProfile } from './protein-structure.mjs';
import { circle, line, polyline, round, svgDocument, textRun } from './svgio.mjs';

const AA20 = [...'ACDEFGHIKLMNPQRSTVWY'];
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Shared input ceiling for the annotation tools (same as the hydropathy plot). */
export const PROTEIN_ANNOTATE_LIMITS = { maxSequenceLength: 20000 };

// ── transcribed parameter tables ────────────────────────────────────────────

/** Kolaskar & Tongaonkar 1990 antigenic propensity A(p) (EMBOSS Eantigenic.dat). */
export const ANTIGENIC_PROPENSITY = {
  A: 1.064, C: 1.412, D: 0.866, E: 0.851, F: 1.091, G: 0.874, H: 1.105, I: 1.152, K: 0.93, L: 1.25, M: 0.826, N: 0.776, P: 1.064, Q: 1.015, R: 0.873, S: 1.012, T: 0.909, V: 1.383, W: 0.893, Y: 1.161
};

/** Parker 1986 hydrophilicity (higher = more hydrophilic). */
export const PARKER_HYDROPHILICITY = {
  A: 2.1, R: 4.2, N: 7, D: 10, C: 1.4, Q: 6, E: 7.8, G: 5.7, H: 2.1, I: -8, L: -9.2, K: 5.7, M: -4.2, F: -9.2, P: 2.1, S: 6.5, T: 5.2, W: -10, Y: -1.9, V: -3.7
};

/** Emini surface fractional probability (higher = more accessible; as transcribed
 * by Biopython, which attributes the table to Vergoten & Theophanides 1997). */
export const EMINI_ACCESSIBILITY = {
  A: 0.815, R: 1.475, N: 1.296, D: 1.283, C: 0.394, Q: 1.348, E: 1.445, G: 0.714, H: 1.18, I: 0.603, L: 0.603, K: 1.545, M: 0.714, F: 0.695, P: 1.236, S: 1.115, T: 1.184, W: 0.808, Y: 1.089, V: 0.606
};

/** Vihinen 1994 normalized flexibility (higher = more flexible). */
export const VIHINEN_FLEXIBILITY = {
  A: 0.984, C: 0.906, E: 1.094, D: 1.068, G: 1.031, F: 0.915, I: 0.927, H: 0.95, K: 1.102, M: 0.952, L: 0.935, N: 1.048, Q: 1.037, P: 1.049, S: 1.046, R: 1.008, T: 0.997, W: 0.904, V: 0.931, Y: 0.929
};

/** Guruprasad 1990 dipeptide instability weights (row = first residue). */
const DIWV = {
  A: { A: 1, C: 44.94, E: 1, D: -7.49, G: 1, F: 1, I: 1, H: -7.49, K: 1, M: 1, L: 1, N: 1, Q: 1, P: 20.26, S: 1, R: 1, T: 1, W: 1, V: 1, Y: 1 },
  C: { A: 1, C: 1, E: 1, D: 20.26, G: 1, F: 1, I: 1, H: 33.6, K: 1, M: 33.6, L: 20.26, N: 1, Q: -6.54, P: 20.26, S: 1, R: 1, T: 33.6, W: 24.68, V: -6.54, Y: 1 },
  E: { A: 1, C: 44.94, E: 33.6, D: 20.26, G: 1, F: 1, I: 20.26, H: -6.54, K: 1, M: 1, L: 1, N: 1, Q: 20.26, P: 20.26, S: 20.26, R: 1, T: 1, W: -14.03, V: 1, Y: 1 },
  D: { A: 1, C: 1, E: 1, D: 1, G: 1, F: -6.54, I: 1, H: 1, K: -7.49, M: 1, L: 1, N: 1, Q: 1, P: 1, S: 20.26, R: -6.54, T: -14.03, W: 1, V: 1, Y: 1 },
  G: { A: -7.49, C: 1, E: -6.54, D: 1, G: 13.34, F: 1, I: -7.49, H: 1, K: -7.49, M: 1, L: 1, N: -7.49, Q: 1, P: 1, S: 1, R: 1, T: -7.49, W: 13.34, V: 1, Y: -7.49 },
  F: { A: 1, C: 1, E: 1, D: 13.34, G: 1, F: 1, I: 1, H: 1, K: -14.03, M: 1, L: 1, N: 1, Q: 1, P: 20.26, S: 1, R: 1, T: 1, W: 1, V: 1, Y: 33.601 },
  I: { A: 1, C: 1, E: 44.94, D: 1, G: 1, F: 1, I: 1, H: 13.34, K: -7.49, M: 1, L: 20.26, N: 1, Q: 1, P: -1.88, S: 1, R: 1, T: 1, W: 1, V: -7.49, Y: 1 },
  H: { A: 1, C: 1, E: 1, D: 1, G: -9.37, F: -9.37, I: 44.94, H: 1, K: 24.68, M: 1, L: 1, N: 24.68, Q: 1, P: -1.88, S: 1, R: 1, T: -6.54, W: -1.88, V: 1, Y: 44.94 },
  K: { A: 1, C: 1, E: 1, D: 1, G: -7.49, F: 1, I: -7.49, H: 1, K: 1, M: 33.6, L: -7.49, N: 1, Q: 24.64, P: -6.54, S: 1, R: 33.6, T: 1, W: 1, V: -7.49, Y: 1 },
  M: { A: 13.34, C: 1, E: 1, D: 1, G: 1, F: 1, I: 1, H: 58.28, K: 1, M: -1.88, L: 1, N: 1, Q: -6.54, P: 44.94, S: 44.94, R: -6.54, T: -1.88, W: 1, V: 1, Y: 24.68 },
  L: { A: 1, C: 1, E: 1, D: 1, G: 1, F: 1, I: 1, H: 1, K: -7.49, M: 1, L: 1, N: 1, Q: 33.6, P: 20.26, S: 1, R: 20.26, T: 1, W: 24.68, V: 1, Y: 1 },
  N: { A: 1, C: -1.88, E: 1, D: 1, G: -14.03, F: -14.03, I: 44.94, H: 1, K: 24.68, M: 1, L: 1, N: 1, Q: -6.54, P: -1.88, S: 1, R: 1, T: -7.49, W: -9.37, V: 1, Y: 1 },
  Q: { A: 1, C: -6.54, E: 20.26, D: 20.26, G: 1, F: -6.54, I: 1, H: 1, K: 1, M: 1, L: 1, N: 1, Q: 20.26, P: 20.26, S: 44.94, R: 1, T: 1, W: 1, V: -6.54, Y: -6.54 },
  P: { A: 20.26, C: -6.54, E: 18.38, D: -6.54, G: 1, F: 20.26, I: 1, H: 1, K: 1, M: -6.54, L: 1, N: 1, Q: 20.26, P: 20.26, S: 20.26, R: -6.54, T: 1, W: -1.88, V: 20.26, Y: 1 },
  S: { A: 1, C: 33.6, E: 20.26, D: 1, G: 1, F: 1, I: 1, H: 1, K: 1, M: 1, L: 1, N: 1, Q: 20.26, P: 44.94, S: 20.26, R: 20.26, T: 1, W: 1, V: 1, Y: 1 },
  R: { A: 1, C: 1, E: 1, D: 1, G: -7.49, F: 1, I: 1, H: 20.26, K: 1, M: 1, L: 1, N: 13.34, Q: 20.26, P: 20.26, S: 44.94, R: 58.28, T: 1, W: 58.28, V: 1, Y: -6.54 },
  T: { A: 1, C: 1, E: 20.26, D: 1, G: -7.49, F: 13.34, I: 1, H: 1, K: 1, M: 1, L: 1, N: -14.03, Q: -6.54, P: 1, S: 1, R: 1, T: 1, W: -14.03, V: 1, Y: 1 },
  W: { A: -14.03, C: 1, E: 1, D: 1, G: -9.37, F: 1, I: 1, H: 24.68, K: 1, M: 24.68, L: 13.34, N: 13.34, Q: 1, P: 1, S: 1, R: 1, T: -14.03, W: 1, V: -7.49, Y: 1 },
  V: { A: 1, C: 1, E: 1, D: -14.03, G: -7.49, F: 1, I: 1, H: 1, K: -1.88, M: 1, L: 1, N: 1, Q: 1, P: 20.26, S: 1, R: 1, T: -7.49, W: 1, V: 1, Y: -6.54 },
  Y: { A: 24.68, C: 1, E: -6.54, D: 24.68, G: -7.49, F: 1, I: 1, H: 13.34, K: 1, M: 44.94, L: 1, N: 1, Q: 1, P: 13.34, S: 1, R: -15.91, T: -7.49, W: -9.37, V: 1, Y: 13.34 },
};

/** von Heijne 1986 aligned counts: 15 positions (-13..-1, +1, +2) plus Expect. */
export const SIGNAL_PEPTIDE_COUNTS = {
  eukaryote: {
    A: [16, 13, 14, 15, 20, 18, 18, 17, 25, 15, 47, 6, 80, 18, 6, 14.5],
    C: [3, 6, 9, 7, 9, 14, 6, 8, 5, 6, 19, 3, 9, 8, 3, 4.5],
    D: [0, 0, 0, 0, 0, 0, 0, 0, 5, 3, 0, 5, 0, 10, 11, 8.9],
    E: [0, 0, 0, 1, 0, 0, 0, 0, 3, 7, 0, 7, 0, 13, 14, 10],
    F: [13, 9, 11, 11, 6, 7, 18, 13, 4, 5, 0, 13, 0, 6, 4, 5.6],
    G: [4, 4, 3, 6, 3, 13, 3, 2, 19, 34, 5, 7, 39, 10, 7, 12.1],
    H: [0, 0, 0, 0, 0, 1, 1, 0, 5, 0, 0, 6, 0, 4, 2, 3.4],
    I: [15, 15, 8, 6, 11, 5, 4, 8, 5, 1, 10, 5, 0, 8, 7, 7.4],
    K: [0, 0, 0, 1, 0, 0, 1, 0, 0, 4, 0, 2, 0, 11, 9, 11.3],
    L: [71, 68, 72, 79, 78, 45, 64, 49, 10, 23, 8, 20, 1, 8, 4, 12.1],
    M: [0, 3, 7, 4, 1, 6, 2, 2, 0, 0, 0, 1, 0, 1, 2, 2.7],
    N: [0, 1, 0, 1, 1, 0, 0, 0, 3, 3, 0, 10, 0, 4, 7, 7.1],
    P: [2, 0, 2, 0, 0, 4, 1, 8, 20, 14, 0, 1, 3, 0, 22, 7.4],
    Q: [0, 0, 0, 1, 0, 6, 1, 0, 10, 8, 0, 18, 3, 19, 10, 6.3],
    R: [2, 0, 0, 0, 0, 1, 0, 0, 7, 4, 0, 15, 0, 12, 9, 7.6],
    S: [9, 3, 8, 6, 13, 10, 15, 16, 26, 11, 23, 17, 20, 15, 10, 11.4],
    T: [2, 10, 5, 4, 5, 13, 7, 7, 12, 6, 17, 8, 6, 3, 10, 9.7],
    V: [20, 25, 15, 18, 13, 15, 11, 27, 0, 12, 32, 3, 0, 8, 17, 11.1],
    W: [4, 3, 3, 1, 1, 2, 6, 3, 1, 3, 0, 9, 0, 2, 0, 1.8],
    Y: [0, 1, 4, 0, 0, 1, 3, 1, 1, 2, 0, 5, 0, 1, 7, 5.6],
  },
  gram_negative: {
    A: [10, 8, 8, 9, 6, 7, 5, 6, 7, 7, 24, 2, 31, 18, 4, 3.2],
    C: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1],
    D: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 8, 2],
    E: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 4, 8, 2.2],
    F: [2, 4, 3, 4, 1, 1, 8, 0, 4, 1, 0, 7, 0, 1, 0, 1.3],
    G: [4, 2, 2, 2, 3, 5, 2, 4, 2, 2, 0, 2, 2, 1, 0, 2.7],
    H: [0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 7, 0, 1, 0, 0.8],
    I: [3, 1, 5, 1, 5, 0, 1, 3, 0, 0, 0, 0, 0, 0, 2, 1.7],
    K: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 3, 0, 2.5],
    L: [8, 11, 9, 8, 9, 13, 1, 0, 2, 2, 1, 2, 0, 0, 1, 2.7],
    M: [0, 2, 1, 1, 3, 2, 3, 0, 1, 2, 0, 4, 0, 0, 1, 0.6],
    N: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 3, 0, 1, 4, 1.6],
    P: [0, 1, 1, 1, 1, 1, 2, 3, 5, 2, 0, 0, 0, 0, 5, 1.7],
    Q: [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 3, 0, 0, 1, 1.4],
    R: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1.7],
    S: [1, 0, 1, 4, 4, 1, 5, 15, 5, 8, 5, 2, 2, 0, 0, 2.6],
    T: [2, 0, 4, 2, 2, 2, 2, 2, 5, 1, 3, 0, 1, 1, 2, 2.2],
    V: [5, 7, 1, 3, 1, 4, 7, 0, 0, 4, 3, 0, 0, 2, 0, 2.5],
    W: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0.4],
    Y: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 1, 0, 0, 0, 1.3],
  },
};

const SIGNAL_POSITIONS = [-13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2];

/**
 * Position weights exactly as EMBOSS sigcleave derives them: log(count/expected),
 * with a zero count replaced by 1.0 except at the -3 and -1 columns, where
 * EMBOSS substitutes 1e-10 (those two columns define the cleavage site).
 */
function buildSignalWeights(counts) {
  const weights = {};
  for (const aa of AA20) {
    const row = counts[aa];
    if (!Array.isArray(row) || row.length !== 16) throw new Error(`signal-peptide table row ${aa} must hold 16 numbers`);
    const expected = row[15];
    if (!(expected > 0)) throw new Error(`signal-peptide table row ${aa} has a non-positive expectation`);
    weights[aa] = row.slice(0, 15).map((count, col) => {
      const value = count === 0 ? (col === 10 || col === 12 ? 1e-10 : 1) : count;
      return Math.log(value / expected);
    });
  }
  return weights;
}

const SIGNAL_WEIGHTS = {
  eukaryote: buildSignalWeights(SIGNAL_PEPTIDE_COUNTS.eukaryote),
  gram_negative: buildSignalWeights(SIGNAL_PEPTIDE_COUNTS.gram_negative),
};

// ── post-translational-modification motifs (#13) ────────────────────────────

const PTM_MOTIFS = [
  { type: 'N-glycosylation', motif: 'N-{P}-[S/T]', pattern: /N[^P][ST]/g, siteOffset: 0 },
  { type: 'C-mannosylation', motif: 'W-x-x-W', pattern: /W..W/g, siteOffset: 0 },
  { type: 'N-myristoylation', motif: 'N-terminal G-{EDRKHPFYW}-x-x-[STAGCN]-{P}', pattern: /^G[EDRKHPFYW]..[STAGCN][^P]/, siteOffset: 0, anchored: true },
  { type: 'SUMOylation', motif: '[LIVFM]-K-x-E', pattern: /[LIVFM]K.E/g, siteOffset: 1 },
  { type: 'PKA phosphorylation', motif: 'R-R-x-[S/T]', pattern: /RR.[ST]/g, siteOffset: 2 },
  { type: 'CK2 phosphorylation', motif: '[S/T]-x-x-[D/E]', pattern: /[ST]..[DE]/g, siteOffset: 0 },
  { type: 'proline-directed phosphorylation', motif: '[S/T]-P', pattern: /[ST]P/g, siteOffset: 0 },
];

function contextOf(sequence, index) {
  const left = sequence.slice(Math.max(0, index - 3), index);
  const right = sequence.slice(index + 1, index + 4);
  return `${left}[${sequence[index]}]${right}`;
}

/** Shannon entropy (bits) of the residues in one window. */
function windowEntropy(window) {
  const counts = new Map();
  for (const aa of window) counts.set(aa, (counts.get(aa) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / window.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Guruprasad 1990 instability index; values above 40 indicate instability. */
function instabilityIndex(sequence) {
  let total = 0;
  for (let i = 0; i < sequence.length - 1; i++) total += DIWV[sequence[i]][sequence[i + 1]];
  return (10 / sequence.length) * total;
}

/**
 * PTM motifs, SEG-style low-complexity regions and composition flags.
 *
 * The motifs are documented linear consensus patterns (ELM/Expasy), scanned
 * against the one-letter sequence; low complexity is an entropy-window
 * approximation of SEG, not SEG itself.
 */
export function scanProteinFeatures(rawSequence, options = {}) {
  const sequence = normalizeProtein(rawSequence);
  if (sequence.length > PROTEIN_ANNOTATE_LIMITS.maxSequenceLength) {
    throw new MolbioInputError(`the protein is ${sequence.length} residues; the limit is ${PROTEIN_ANNOTATE_LIMITS.maxSequenceLength} per scan`);
  }
  const window = options.window ?? 12;
  if (!Number.isInteger(window) || window < 4 || window > 50) throw new MolbioInputError('window must be an integer between 4 and 50 (12 is the SEG-style default)');
  const entropyThreshold = options.entropyThreshold ?? 2.2;
  if (!(typeof entropyThreshold === 'number') || entropyThreshold < 0 || entropyThreshold > 4.5) throw new MolbioInputError('entropy_threshold must be a number between 0 and 4.5 bits (2.2 is the SEG-style default)');
  const maxSites = options.maxSites ?? 200;
  if (!Number.isInteger(maxSites) || maxSites < 1 || maxSites > 2000) throw new MolbioInputError('max_sites must be an integer between 1 and 2000');

  const sites = [];
  const seen = new Set();
  for (const motif of PTM_MOTIFS) {
    if (motif.anchored) {
      const match = motif.pattern.exec(sequence);
      if (match === null) continue;
      const index = match.index + motif.siteOffset;
      const key = `${motif.type}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ type: motif.type, motif: motif.motif, position: index + 1, context: contextOf(sequence, index) });
      continue;
    }
    const pattern = new RegExp(motif.pattern.source, motif.pattern.flags);
    let match;
    while ((match = pattern.exec(sequence)) !== null) {
      const index = match.index + motif.siteOffset;
      const key = `${motif.type}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ type: motif.type, motif: motif.motif, position: index + 1, context: contextOf(sequence, index) });
      if (pattern.lastIndex === match.index) pattern.lastIndex++;
    }
  }
  sites.sort((a, b) => a.position - b.position || a.type.localeCompare(b.type));
  const truncated = sites.length > maxSites;
  const kept = truncated ? sites.slice(0, maxSites) : sites;

  const regions = [];
  if (sequence.length >= window) {
    let current = null;
    let minWindowEntropy = Infinity;
    for (let start = 0; start + window <= sequence.length; start++) {
      const entropy = windowEntropy(sequence.slice(start, start + window));
      if (entropy < entropyThreshold) {
        if (current === null) {
          current = { start: start + 1, end: start + window };
          minWindowEntropy = entropy;
        } else {
          current.end = start + window;
          minWindowEntropy = Math.min(minWindowEntropy, entropy);
        }
      } else if (current !== null) {
        regions.push({ ...current, min_window_entropy: round3(minWindowEntropy), entropy: round3(windowEntropy(sequence.slice(current.start - 1, current.end))) });
        current = null;
        minWindowEntropy = Infinity;
      }
    }
    if (current !== null) regions.push({ ...current, min_window_entropy: round3(minWindowEntropy), entropy: round3(windowEntropy(sequence.slice(current.start - 1, current.end))) });
  }
  const regionsTruncated = regions.length > 100;
  const keptRegions = (regionsTruncated ? regions.slice(0, 100) : regions).map((region) => ({ ...region, length: region.end - region.start + 1 }));

  let aromatic = 0;
  for (const aa of sequence) if (aa === 'F' || aa === 'W' || aa === 'Y') aromatic++;
  const index = instabilityIndex(sequence);

  const notes = [
    'PTM motifs are linear consensus patterns; a motif match does not prove the site is modified in vivo.',
    'Low complexity is an entropy-window approximation of SEG (not SEG); regions are where a window drops below the threshold.',
    'Instability index follows Guruprasad 1990 (DIWV table): above 40 is conventionally read as unstable.',
  ];
  if (sequence.length < window) notes.push(`the protein is shorter than the low-complexity window (${window}), so no low-complexity region was scanned`);
  if (truncated) notes.push(`more than ${maxSites} PTM sites were found; the list is truncated at ${maxSites}`);

  return {
    length: sequence.length,
    ptm_sites: kept,
    low_complexity_regions: keptRegions,
    composition: {
      aromaticity: round3(aromatic / sequence.length),
      instability_index: round2(index),
      instability_class: index > 40 ? 'unstable' : 'stable',
    },
    window,
    entropy_threshold: entropyThreshold,
    truncated: truncated || regionsTruncated,
    notes,
  };
}

// ── signal peptide + transmembrane segments (#21) ───────────────────────────

export const SIGNAL_PEPTIDE_DEFAULTS = {
  organism: 'eukaryote',
  threshold: 3.5,
  tmWindow: 19,
  tmThreshold: HYDROPATHY_DEFAULTS.threshold,
  maxCleavage: 50,
  maxCandidates: 10,
};

/** Score one candidate cleavage position (0-based index of the +1 residue). */
function signalScore(sequence, cleavage, weights) {
  let score = 0;
  for (let col = 0; col < SIGNAL_POSITIONS.length; col++) {
    score += weights[sequence[cleavage - 13 + col]][col];
  }
  return score;
}

/**
 * von Heijne 1986 signal-peptide cleavage score plus Kyte-Doolittle candidate
 * transmembrane segments.
 *
 * A candidate cleavage after residue k uses the fixed -13..+2 window; the
 * score is the sum of the position weights. The TM segments are the SAME runs
 * `molbio_hydropathy_plot` reports as peaks, with the same window and threshold
 * defaults, so the two tools cannot disagree.
 */
export function signalPeptideAnalysis(rawSequence, options = {}) {
  const sequence = normalizeProtein(rawSequence);
  if (sequence.length > PROTEIN_ANNOTATE_LIMITS.maxSequenceLength) {
    throw new MolbioInputError(`the protein is ${sequence.length} residues; the limit is ${PROTEIN_ANNOTATE_LIMITS.maxSequenceLength} per scan`);
  }
  if (sequence.length < 15) throw new MolbioInputError('a signal-peptide score needs at least 15 residues (the -13..+2 window)');
  const organism = options.organism ?? SIGNAL_PEPTIDE_DEFAULTS.organism;
  if (!(organism in SIGNAL_WEIGHTS)) throw new MolbioInputError('organism must be eukaryote or gram_negative');
  const maxCleavage = options.maxCleavage ?? SIGNAL_PEPTIDE_DEFAULTS.maxCleavage;
  if (!Number.isInteger(maxCleavage) || maxCleavage < 15 || maxCleavage > 200) throw new MolbioInputError('max_cleavage must be an integer between 15 and 200 (signal peptides are N-terminal; the default scans the first 50 residues)');
  const threshold = options.threshold ?? SIGNAL_PEPTIDE_DEFAULTS.threshold;
  if (!(typeof threshold === 'number') || threshold < -20 || threshold > 20) throw new MolbioInputError('threshold must be a number between -20 and 20 (the default 3.5 is the EMBOSS sigcleave minweight)');
  const tmWindow = options.tmWindow ?? SIGNAL_PEPTIDE_DEFAULTS.tmWindow;
  if (!Number.isInteger(tmWindow) || tmWindow < 3 || tmWindow > 51) throw new MolbioInputError('tm_window must be an integer between 3 and 51 (19 centres a transmembrane window)');
  const tmThreshold = options.tmThreshold ?? SIGNAL_PEPTIDE_DEFAULTS.tmThreshold;
  if (!(typeof tmThreshold === 'number') || tmThreshold < -4.5 || tmThreshold > 4.5) throw new MolbioInputError('tm_threshold must be a number between -4.5 and 4.5 (the Kyte-Doolittle range)');

  const weights = SIGNAL_WEIGHTS[organism];
  const profile = [];
  const lastCleavage = Math.min(sequence.length - 2, maxCleavage);
  for (let cleavage = 13; cleavage <= lastCleavage; cleavage++) {
    profile.push({ cleavage_after: cleavage, score: round3(signalScore(sequence, cleavage, weights)) });
  }
  let best = null;
  for (const point of profile) if (best === null || point.score > best.score) best = point;
  const cleavable = best !== null && best.score > threshold;
  const candidates = profile
    .filter((point) => point.score > threshold)
    .sort((a, b) => b.score - a.score || a.cleavage_after - b.cleavage_after)
    .slice(0, SIGNAL_PEPTIDE_DEFAULTS.maxCandidates)
    .map((point) => ({ cleavage_after: point.cleavage_after, score: point.score }));

  const hydropathy = hydropathyProfile(sequence, { window: tmWindow, threshold: tmThreshold });
  const transmembrane = hydropathy.peaks.map((peak) => ({
    start: peak.start,
    end: peak.end,
    length: peak.length,
    mean_hydropathy: peak.maximum,
    peak_position: peak.maximum_position,
  }));

  const notes = [
    'Signal-peptide scores are von Heijne 1986 position weights (EMBOSS sigcleave table); a score above the threshold is a candidate, not a SignalP prediction.',
    'Transmembrane segments are the same Kyte-Doolittle runs molbio_hydropathy_plot reports as peaks (same window and threshold); topology and orientation are NOT predicted.',
  ];
  if (transmembrane.some((segment) => cleavable && segment.start <= best.cleavage_after)) {
    notes.push('a candidate transmembrane segment overlaps the candidate signal peptide; a signal peptide is also hydrophobic, so this alone does not mean two features');
  }

  return {
    length: sequence.length,
    organism,
    threshold,
    cleavable,
    best_score: best === null ? 0 : best.score,
    cleavage_after: cleavable ? best.cleavage_after : 0,
    scanned_to: lastCleavage,
    window_start: cleavable ? best.cleavage_after - 12 : 0,
    window_end: cleavable ? best.cleavage_after + 2 : 0,
    signal_peptide: cleavable ? sequence.slice(0, best.cleavage_after) : '',
    mature_sequence: cleavable ? sequence.slice(best.cleavage_after) : sequence,
    candidates,
    transmembrane_segments: transmembrane,
    tm_window: tmWindow,
    tm_threshold: tmThreshold,
    notes,
    profile,
  };
}

/** Draw the signal-peptide score profile as a standalone SVG. */
export function renderSignalPeptideProfile(analysis, { title } = {}) {
  const width = 820;
  const height = 280;
  const margin = { top: 52, right: 24, bottom: 44, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = analysis.profile;
  const scores = points.map((p) => p.score);
  const maxScore = Math.max(analysis.threshold, ...scores);
  const minScore = Math.min(0, ...scores);
  const xOf = (cleavage) => margin.left + ((cleavage - points[0].cleavage_after) / Math.max(1, points[points.length - 1].cleavage_after - points[0].cleavage_after)) * plotWidth;
  const yOf = (score) => margin.top + plotHeight - ((score - minScore) / (maxScore - minScore || 1)) * plotHeight;
  const body = [];
  body.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  body.push(textRun({ x: margin.left, y: 24, text: title ?? 'Signal-peptide cleavage score', size: 15, weight: 'bold' }));
  body.push(textRun({ x: margin.left, y: 41, text: `${analysis.length} aa · ${analysis.organism} · threshold ${analysis.threshold}`, size: 10, fill: '#57606a' }));
  body.push(line({ x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotHeight, stroke: '#8c959f' }));
  body.push(line({ x1: margin.left, y1: margin.top + plotHeight, x2: margin.left + plotWidth, y2: margin.top + plotHeight, stroke: '#8c959f' }));
  for (let i = 0; i <= 4; i++) {
    const value = minScore + ((maxScore - minScore) * i) / 4;
    const y = yOf(value);
    body.push(line({ x1: margin.left - 4, y1: y, x2: margin.left, y2: y, stroke: '#8c959f' }));
    body.push(textRun({ x: margin.left - 8, y: y + 3, text: round(value, 2).toFixed(2), size: 9, fill: '#57606a', anchor: 'end' }));
  }
  const thresholdY = yOf(analysis.threshold);
  body.push(line({ x1: margin.left, y1: thresholdY, x2: margin.left + plotWidth, y2: thresholdY, stroke: '#cf222e', width: 1, dash: [5, 4] }));
  body.push(textRun({ x: margin.left + plotWidth, y: thresholdY - 5, text: `threshold ${analysis.threshold}`, size: 9, fill: '#cf222e', anchor: 'end' }));
  body.push(polyline(points.map((p) => [round(xOf(p.cleavage_after), 2), round(yOf(p.score), 2)]), { stroke: '#0969da', width: 1.6 }));
  if (analysis.cleavable) {
    const x = xOf(analysis.cleavage_after);
    const y = yOf(analysis.best_score);
    body.push(circle({ cx: round(x, 2), cy: round(y, 2), r: 4, fill: '#cf222e', stroke: '#ffffff', strokeWidth: 1 }));
    body.push(textRun({ x: round(x, 2), y: round(y - 10, 2), text: `cleavage after ${analysis.cleavage_after}`, size: 10, fill: '#cf222e', anchor: 'middle' }));
  }
  body.push(textRun({ x: margin.left + plotWidth / 2, y: height - 12, text: 'candidate cleavage position (residues in the signal peptide)', size: 10, fill: '#57606a', anchor: 'middle' }));
  return svgDocument({
    width,
    height,
    title: `Signal-peptide score profile (${analysis.organism}, threshold ${analysis.threshold})`,
    description: analysis.cleavable ? `Best candidate cleavage after residue ${analysis.cleavage_after} with score ${analysis.best_score}` : 'No candidate exceeded the threshold',
    body: body.join(''),
  });
}

// ── antigenic propensity (#14) ──────────────────────────────────────────────

export const ANTIGENICITY_DEFAULTS = { window: 7, minRegionLength: 6, maxRegions: 20 };

function meanScale(sequence, scale) {
  let total = 0;
  for (const aa of sequence) total += scale[aa];
  return total / sequence.length;
}

/**
 * Kolaskar-Tongaonkar antigenic propensity with the three scales the method was
 * derived from (Parker hydrophilicity, Emini accessibility, Vihinen flexibility).
 *
 * The 7-mer <A(p)> is assigned to the central residue; a residue is selected when
 * its <A(p)> reaches the protein mean (or 1.0 when the mean is at least 1.0), and
 * a region is reported when at least `minRegionLength` consecutive residues are
 * selected. This is a propensity ranking, not an epitope predictor.
 */
export function antigenicityProfile(rawSequence, options = {}) {
  const sequence = normalizeProtein(rawSequence);
  if (sequence.length > PROTEIN_ANNOTATE_LIMITS.maxSequenceLength) {
    throw new MolbioInputError(`the protein is ${sequence.length} residues; the limit is ${PROTEIN_ANNOTATE_LIMITS.maxSequenceLength} per scan`);
  }
  if (sequence.length < 8) throw new MolbioInputError('antigenic propensity needs at least 8 residues (one centred 7-mer)');
  const minRegionLength = options.minRegionLength ?? ANTIGENICITY_DEFAULTS.minRegionLength;
  if (!Number.isInteger(minRegionLength) || minRegionLength < 1 || minRegionLength > 100) throw new MolbioInputError('min_region_length must be an integer between 1 and 100 (6 is the Kolaskar-Tongaonkar convention)');
  const maxRegions = options.maxRegions ?? ANTIGENICITY_DEFAULTS.maxRegions;
  if (!Number.isInteger(maxRegions) || maxRegions < 1 || maxRegions > 200) throw new MolbioInputError('max_regions must be an integer between 1 and 200');

  const meanPropensity = meanScale(sequence, ANTIGENIC_PROPENSITY);
  const threshold = meanPropensity < 1 ? meanPropensity : 1;
  const centres = [];
  for (let centre = 3; centre <= sequence.length - 4; centre++) {
    let total = 0;
    for (let k = centre - 3; k <= centre + 3; k++) total += ANTIGENIC_PROPENSITY[sequence[k]];
    centres.push({ position: centre + 1, propensity: total / 7 });
  }
  const selected = centres.filter((point) => point.propensity >= threshold);
  const regions = [];
  let run = [];
  const flush = () => {
    if (run.length < minRegionLength) { run = []; return; }
    const start = run[0].position;
    const end = run[run.length - 1].position;
    const peptide = sequence.slice(start - 1, end);
    let peak = run[0];
    for (const point of run) if (point.propensity > peak.propensity) peak = point;
    regions.push({
      start,
      end,
      length: end - start + 1,
      peak_position: peak.position,
      peak_propensity: round3(peak.propensity),
      parker_mean: round3(meanScale(peptide, PARKER_HYDROPHILICITY)),
      emini_mean: round3(meanScale(peptide, EMINI_ACCESSIBILITY)),
      flexibility_mean: round3(meanScale(peptide, VIHINEN_FLEXIBILITY)),
    });
    run = [];
  };
  for (const point of centres) {
    if (point.propensity >= threshold) run.push(point);
    else if (run.length > 0) flush();
  }
  if (run.length > 0) flush();
  regions.sort((a, b) => b.peak_propensity - a.peak_propensity);
  const truncated = regions.length > maxRegions;
  const kept = (truncated ? regions.slice(0, maxRegions) : regions).sort((a, b) => a.start - b.start);

  return {
    length: sequence.length,
    window: ANTIGENICITY_DEFAULTS.window,
    mean_propensity: round3(meanPropensity),
    threshold: round3(threshold),
    regions: kept,
    parker_mean: round3(meanScale(sequence, PARKER_HYDROPHILICITY)),
    emini_mean: round3(meanScale(sequence, EMINI_ACCESSIBILITY)),
    flexibility_mean: round3(meanScale(sequence, VIHINEN_FLEXIBILITY)),
    truncated,
    notes: [
      'Antigenic propensity is the Kolaskar & Tongaonkar 1990 7-mer method, not an epitope predictor; BepiPred/NetMHC-style scores are trained models with different semantics.',
      'Regions are runs of residues whose <A(p)> reaches the protein mean (or 1.0 when that mean is at least 1.0); the flanking 3 residues of each 7-mer are not part of the reported span.',
      'Parker hydrophilicity, Emini accessibility and Vihinen flexibility are reported as region means to help read the propensity; they are not combined into a single score.',
    ],
  };
}
