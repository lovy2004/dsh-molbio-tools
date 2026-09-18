/**
 * dsh-molbio-tools/msa.mjs
 *
 * Multiple sequence alignment (progressive profile alignment guided by a
 * UPGMA tree over k-mer distances) and conservation analysis. Pure
 * computation: deterministic, synchronous, lossless JSON, zero dependencies.
 *
 * Design notes:
 * - Pairwise/profile global alignment uses affine gap penalties with FREE
 *   terminal gaps (semi-global): match +4, mismatch -4, gap open -6,
 *   gap extend -2. Scores are heuristic units, not likelihoods.
 * - Guide distances are 5-mer sharing fractions — O(N^2 * L) — instead of
 *   all-pairs dynamic programming, so the progressive stage is the only
 *   O(L^2) cost (N-1 profile alignments).
 * - Profile alignment uses sum-of-pairs scoring from per-column symbol
 *   counts: each residue pair scores +4 (identical symbol) or -4, so a
 *   column pair scores 8*matches - 4*pairs. "Once a gap, always a gap":
 *   every profile column is either fully occupied or all-gap, so a column
 *   is summarised by 16 symbol counts (ACGT + 11 IUPAC ambiguity codes).
 * - Identical ambiguous symbols match fully; different symbols (including
 *   e.g. R vs A) do not match — deterministic and simple to reason about.
 * - Conservation: column identity = top symbol count / residues; the
 *   entropy score is 1 - H/2 over the 4 expanded base fractions; consensus
 *   is the top symbol when its fraction is >= 0.5, otherwise the IUPAC
 *   ambiguity code of the union of expanded bases.
 *
 * All outputs are estimates for working comparisons, not phylogenetic
 * ground truth.
 */

import { MolbioInputError, normalizeSequence } from './lib.mjs';

// ── scoring and limits ──────────────────────────────────────────────────────

export const MSA_SCORING = {
  match: 4,
  mismatch: -4,
  gapOpen: 6, // magnitudes; applied with a minus sign
  gapExtend: 2,
  kmerK: 5,
};

export const MSA_LIMITS = {
  maxSequences: 50,
  maxLength: 3000,
  maxTotalBases: 30000,
};

const SYMBOLS = ['A', 'C', 'G', 'T', 'R', 'Y', 'S', 'W', 'K', 'M', 'B', 'D', 'H', 'V', 'N'];
const SYMBOL_INDEX = {};
for (let k = 0; k < SYMBOLS.length; k++) SYMBOL_INDEX[SYMBOLS[k]] = k;

// Bitmask of the ACGT set each symbol expands to (A=1, C=2, G=4, T=8).
const EXPANDED_BASES = {
  A: 1, C: 2, G: 4, T: 8,
  R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3,
  B: 14, D: 13, H: 11, V: 7, N: 15,
};

const BASE_INDEX = { A: 0, C: 1, G: 2, T: 3 };

// ACGT-subset mask → IUPAC ambiguity code.
const UNION_CODE = {
  3: 'M', 5: 'R', 9: 'W', 6: 'S', 10: 'Y', 12: 'K',
  7: 'V', 11: 'H', 13: 'D', 14: 'B', 15: 'N',
};

const NEG_INF = -1_000_000_000;
const SYMBOL_COUNT = SYMBOLS.length;

// ── input normalisation ─────────────────────────────────────────────────────

/** Normalize an unaligned input sequence (IUPAC DNA; U treated as T). */
export function normalizeMsaSequence(raw, label = 'sequence') {
  return normalizeSequence(raw, label).replace(/U/g, 'T');
}

/** Normalize one row of a pre-aligned input ("-" gaps allowed; U→T, "."→"-"). */
export function normalizeAlignedRow(raw, label = 'alignment row') {
  if (typeof raw !== 'string') throw new MolbioInputError(`${label} must be a string`);
  const cleaned = raw.toUpperCase().replace(/[\s\d]/g, '').replace(/\./g, '-').replace(/U/g, 'T');
  if (cleaned.length === 0) throw new MolbioInputError(`${label} contains no characters`);
  if (cleaned.length > 100_000) throw new MolbioInputError(`${label} is too long (${cleaned.length} columns; limit 100000)`);
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch !== '-' && SYMBOL_INDEX[ch] === undefined) {
      throw new MolbioInputError(`${label} contains invalid character ${JSON.stringify(ch)} at position ${i + 1}; expected IUPAC DNA bases (A C G T R Y S W K M B D H V N) or "-"`);
    }
  }
  return cleaned;
}

// ── profiles ────────────────────────────────────────────────────────────────

/**
 * A profile is a set of equal-length aligned rows plus per-column symbol
 * counts and residue counts. Columns may be partial (terminal overhangs:
 * some rows gapped); a NEW gap against an existing profile column extends
 * the whole column ("once a gap, always a gap").
 */
function makeProfile(rows) {
  const width = rows.length;
  const columns = rows[0].length;
  const counts = new Uint16Array(columns * SYMBOL_COUNT);
  const residues = new Uint16Array(columns);
  for (let c = 0; c < columns; c++) {
    for (let r = 0; r < width; r++) {
      const ch = rows[r][c];
      if (ch !== '-') {
        counts[c * SYMBOL_COUNT + SYMBOL_INDEX[ch]]++;
        residues[c]++;
      }
    }
  }
  return { rows, width, columns, counts, residues };
}

/**
 * Affine-gap global alignment of two profiles with free terminal gaps.
 * Sum-of-pairs cell score: 8*matches - 4*pairs (each residue pair +4/-4);
 * residues aligned against gaps score 0. Returns the merged profile and the
 * alignment score.
 */
function alignProfiles(profileA, profileB) {
  const ca = profileA.counts;
  const cb = profileB.counts;
  const ra = profileA.residues;
  const rb = profileB.residues;
  const la = profileA.columns;
  const lb = profileB.columns;
  const wa = profileA.width;
  const wb = profileB.width;
  const stride = lb + 1;
  const size = (la + 1) * stride;
  const H = new Int32Array(size);
  const F = new Int32Array(size); // last op: gap in B (consumed an A column)
  const E = new Int32Array(size); // last op: gap in A (consumed a B column)
  const dir = new Uint8Array(size); // 1 diag, 2 gap in B, 3 gap in A
  F.fill(NEG_INF);
  E.fill(NEG_INF);
  // Free terminal gaps: row 0 (gaps in A) and column 0 (gaps in B) cost 0.
  for (let j = 0; j <= lb; j++) {
    H[j] = 0;
    E[j] = 0;
  }
  for (let i = 1; i <= la; i++) {
    const p = i * stride;
    H[p] = 0;
    F[p] = 0;
  }
  for (let i = 1; i <= la; i++) {
    const rowBase = i * stride;
    const aBase = (i - 1) * SYMBOL_COUNT;
    for (let j = 1; j <= lb; j++) {
      const idx = rowBase + j;
      const bBase = (j - 1) * SYMBOL_COUNT;
      let matches = 0;
      for (let s = 0; s < SYMBOL_COUNT; s++) matches += ca[aBase + s] * cb[bBase + s];
      const pairs = ra[i - 1] * rb[j - 1];
      const diagScore = H[idx - stride - 1] + 8 * matches - 4 * pairs;
      const fScore = Math.max(H[idx - stride] - MSA_SCORING.gapOpen, F[idx - stride] - MSA_SCORING.gapExtend);
      const eScore = Math.max(H[idx - 1] - MSA_SCORING.gapOpen, E[idx - 1] - MSA_SCORING.gapExtend);
      F[idx] = fScore;
      E[idx] = eScore;
      let best = diagScore;
      let d = 1;
      if (fScore > best) {
        best = fScore;
        d = 2;
      }
      if (eScore > best) {
        best = eScore;
        d = 3;
      }
      H[idx] = best;
      dir[idx] = d;
    }
  }
  // Free terminal gaps at the end: best over the last row / last column.
  let best = NEG_INF;
  let bi = 0;
  let bj = 0;
  for (let j = 0; j <= lb; j++) {
    if (H[la * stride + j] > best) {
      best = H[la * stride + j];
      bi = la;
      bj = j;
    }
  }
  for (let i = la - 1; i >= 0; i--) {
    if (H[i * stride + lb] > best) {
      best = H[i * stride + lb];
      bi = i;
      bj = lb;
    }
  }
  // Traceback; column strings are collected back-to-front, then reversed.
  const opA = [];
  const opB = [];
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0) {
    const d = dir[i * stride + j];
    if (d === 1) {
      opA.push(columnString(profileA.rows, i - 1));
      opB.push(columnString(profileB.rows, j - 1));
      i--;
      j--;
    } else if (d === 2) {
      opA.push(columnString(profileA.rows, i - 1));
      opB.push('-'.repeat(wb));
      i--;
    } else {
      opA.push('-'.repeat(wa));
      opB.push(columnString(profileB.rows, j - 1));
      j--;
    }
  }
  while (i > 0) {
    opA.push(columnString(profileA.rows, i - 1));
    opB.push('-'.repeat(wb));
    i--;
  }
  while (j > 0) {
    opA.push('-'.repeat(wa));
    opB.push(columnString(profileB.rows, j - 1));
    j--;
  }
  opA.reverse();
  opB.reverse();
  const rows = [];
  for (let r = 0; r < wa; r++) rows.push(joinColumn(opA, r));
  for (let r = 0; r < wb; r++) rows.push(joinColumn(opB, r));
  return { profile: makeProfile(rows), score: best };
}

function columnString(rows, column) {
  let out = '';
  for (let r = 0; r < rows.length; r++) out += rows[r][column];
  return out;
}

function joinColumn(columns, row) {
  let out = '';
  for (let c = 0; c < columns.length; c++) out += columns[c][row];
  return out;
}

// ── guide tree (k-mer distances + UPGMA) ────────────────────────────────────

function kmerDistances(entries) {
  const n = entries.length;
  const k = MSA_SCORING.kmerK;
  const profiles = entries.map((entry) => {
    const seq = entry.sequence;
    const map = new Map();
    const km = Math.min(k, seq.length);
    for (let i = 0; i + km <= seq.length; i++) {
      const mer = seq.slice(i, i + km);
      map.set(mer, (map.get(mer) ?? 0) + 1);
    }
    return { map, total: seq.length - km + 1 };
  });
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    dist[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const [small, big] = profiles[i].total <= profiles[j].total ? [profiles[i], profiles[j]] : [profiles[j], profiles[i]];
      let shared = 0;
      for (const [mer, count] of small.map) shared += Math.min(count, big.map.get(mer) ?? 0);
      const d = 1 - (2 * shared) / (profiles[i].total + profiles[j].total);
      dist[i * n + j] = d;
      dist[j * n + i] = d;
    }
  }
  return dist;
}

/** UPGMA clustering; returns merges in chronological (valid post-) order. */
function upgmaGuide(dist) {
  const n = Math.round(Math.sqrt(dist.length));
  const size = new Array(n).fill(1);
  const active = Array.from({ length: n }, (_, k) => k);
  const merges = [];
  while (active.length > 1) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const d = dist[active[x] * n + active[y]];
        if (d < best) {
          best = d;
          bi = x;
          bj = y;
        }
      }
    }
    const i = active[bi];
    const j = active[bj];
    merges.push({ i, j });
    for (const k of active) {
      if (k === i || k === j) continue;
      const merged = (size[i] * dist[i * n + k] + size[j] * dist[j * n + k]) / (size[i] + size[j]);
      dist[i * n + k] = merged;
      dist[k * n + i] = merged;
    }
    size[i] += size[j];
    active.splice(bj, 1);
  }
  return merges;
}

// ── progressive alignment ───────────────────────────────────────────────────

/**
 * Progressive multiple sequence alignment of IUPAC DNA sequences.
 * @param {Array<{id: string, sequence: string}>} entries - 2..50 entries.
 * @returns {{alignment: Array<{id, sequence}>, columns: number, score: number}}
 *   aligned rows in input order; `score` is the sum of the merge scores.
 */
export function progressiveAlign(entries) {
  const n = entries.length;
  if (n < 2) throw new MolbioInputError(`multiple sequence alignment needs at least 2 sequences (got ${n})`);
  if (n > MSA_LIMITS.maxSequences) throw new MolbioInputError(`at most ${MSA_LIMITS.maxSequences} sequences per alignment (got ${n})`);
  let total = 0;
  for (const entry of entries) {
    const seq = entry.sequence;
    if (seq.length > MSA_LIMITS.maxLength) throw new MolbioInputError(`sequence ${JSON.stringify(entry.id)} is ${seq.length} bases long (limit ${MSA_LIMITS.maxLength} per sequence)`);
    total += seq.length;
  }
  if (total > MSA_LIMITS.maxTotalBases) throw new MolbioInputError(`total input ${total} bases exceeds the ${MSA_LIMITS.maxTotalBases}-base limit`);
  if (n === 2) {
    const result = alignProfiles(makeProfile([entries[0].sequence]), makeProfile([entries[1].sequence]));
    return {
      alignment: entries.map((entry, k) => ({ id: entry.id, sequence: result.profile.rows[k] })),
      columns: result.profile.columns,
      score: result.score,
    };
  }
  const dist = kmerDistances(entries);
  const merges = upgmaGuide(dist);
  const groups = new Map(); // cluster id → { profile, order }
  let totalScore = 0;
  for (let k = 0; k < n; k++) groups.set(k, { profile: makeProfile([entries[k].sequence]), order: [k] });
  for (const { i, j } of merges) {
    const left = groups.get(i);
    const right = groups.get(j);
    const merged = alignProfiles(left.profile, right.profile);
    totalScore += merged.score;
    groups.set(i, { profile: merged.profile, order: left.order.concat(right.order) });
    groups.delete(j);
  }
  const finalGroup = groups.values().next().value;
  const byOriginal = new Array(n);
  for (let k = 0; k < n; k++) byOriginal[finalGroup.order[k]] = finalGroup.profile.rows[k];
  return {
    alignment: byOriginal.map((sequence, k) => ({ id: entries[k].id, sequence })),
    columns: finalGroup.profile.columns,
    score: totalScore,
  };
}

// ── conservation analysis ───────────────────────────────────────────────────

function unionCodeOf(mask) {
  return UNION_CODE[mask] ?? 'N';
}

/**
 * Pairwise identity statistics over aligned rows: per pair, identical
 * non-gap columns / total columns (two gaps never count as a match).
 * @returns {{mean: number, min: number, max: number}} percents.
 */
export function pairwiseIdentities(rows) {
  const n = rows.length;
  const columns = rows[0].length;
  let sum = 0;
  let count = 0;
  let min = 1;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = rows[i];
    for (let j = i + 1; j < n; j++) {
      const b = rows[j];
      let matches = 0;
      for (let c = 0; c < columns; c++) {
        const ch = a[c];
        if (ch !== '-' && ch === b[c]) matches++;
      }
      const identity = columns === 0 ? 1 : matches / columns;
      sum += identity;
      count++;
      if (identity < min) min = identity;
      if (identity > max) max = identity;
    }
  }
  if (count === 0) return { mean: 100, min: 100, max: 100 };
  const pct = (x) => Math.round(x * 10000) / 100;
  return { mean: pct(sum / count), min: pct(min), max: pct(max) };
}

/**
 * Conservation analysis over aligned equal-length rows.
 * Column identity = top-symbol count / residues (gaps excluded); all-gap
 * columns count as conserved and get consensus "-". The conservation score
 * is 1 - H/2 where H is the Shannon entropy (bits) over the four expanded
 * base fractions. variable_positions is capped at 200 entries.
 * @returns {object} see the molbio_conservation tool schema.
 */
export function conservationAnalysis(rows, threshold = 0.8) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new MolbioInputError(`conservation analysis needs at least 2 sequences (got ${Array.isArray(rows) ? rows.length : 0})`);
  }
  if (!(threshold > 0 && threshold <= 1)) throw new MolbioInputError(`threshold must be between 0 and 1 (got ${threshold})`);
  const n = rows.length;
  const columns = rows[0].length;
  for (const row of rows) {
    if (row.length !== columns) throw new MolbioInputError(`all sequences must have the same length after alignment (expected ${columns} columns, got ${row.length})`);
  }
  if (columns === 0) throw new MolbioInputError('the alignment has no columns');
  const consensusChars = [];
  const perColumn = [];
  const variable = [];
  let identitySum = 0;
  let conserved = 0;
  for (let c = 0; c < columns; c++) {
    const counts = new Array(SYMBOL_COUNT).fill(0);
    let residues = 0;
    for (let r = 0; r < n; r++) {
      const ch = rows[r][c];
      if (ch !== '-') {
        counts[SYMBOL_INDEX[ch]]++;
        residues++;
      }
    }
    let identity = 0;
    let conservation = 0;
    let consensus = '-';
    if (residues > 0) {
      let top = 0;
      let topSymbol = 'N';
      let expanded = 0;
      for (let s = 0; s < SYMBOL_COUNT; s++) {
        if (counts[s] === 0) continue;
        if (counts[s] > top) {
          top = counts[s];
          topSymbol = SYMBOLS[s];
        }
        expanded |= EXPANDED_BASES[SYMBOLS[s]];
      }
      identity = Math.round((top / residues) * 1000) / 1000;
      if (top / residues >= 0.5) {
        consensus = topSymbol;
      } else {
        consensus = unionCodeOf(expanded);
      }
      let entropy = 0;
      for (const base of ['A', 'C', 'G', 'T']) {
        const mask = BASE_INDEX[base];
        let count = 0;
        for (let s = 0; s < SYMBOL_COUNT; s++) {
          if (counts[s] > 0 && (EXPANDED_BASES[SYMBOLS[s]] & (1 << mask)) !== 0) count += counts[s];
        }
        if (count === 0) continue;
        const frac = count / residues;
        entropy -= frac * Math.log2(frac);
      }
      conservation = Math.round((1 - entropy / 2) * 1000) / 1000;
    }
    identitySum += identity;
    if (residues === 0 || identity >= threshold) {
      conserved++;
    } else {
      variable.push({ column: c + 1, consensus, identity });
    }
    consensusChars.push(consensus);
    perColumn.push({ column: c + 1, consensus, identity, conservation });
  }
  const variablePositions = variable.slice(0, 200);
  const result = {
    sequence_count: n,
    aligned_columns: columns,
    consensus: consensusChars.join(''),
    identity_percent: Math.round((identitySum / columns) * 10000) / 100,
    conserved_columns: conserved,
    conserved_percent: Math.round((conserved / columns) * 10000) / 100,
    variable_positions: variablePositions,
    variable_positions_truncated: variable.length > 200,
    pairwise_identity_percent: pairwiseIdentities(rows),
  };
  if (columns <= 300) result.per_column = perColumn;
  return result;
}
