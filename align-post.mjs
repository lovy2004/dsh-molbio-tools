/**
 * dsh-molbio-tools/align-post.mjs
 *
 * Alignment post-processing: what to do with an alignment AFTER it exists.
 * `msa.mjs` builds alignments and reports per-column conservation; this module
 * answers the questions that follow — what is the consensus, which columns are
 * junk, how similar is everything to everything, and how well is each column
 * covered. Pure computation: deterministic, synchronous, lossless JSON, zero
 * dependencies.
 *
 * WHY A SEPARATE MODULE RATHER THAN MORE OF `conservationAnalysis`
 * -----------------------------------------------------------------
 * Two of these four answers need semantics that `msa.mjs` deliberately does not
 * have, and changing `msa.mjs` would silently move numbers that released
 * versions already report:
 *
 *  - **Consensus has three defensible definitions, and the caller must pick.**
 *    `conservationAnalysis` uses one (plurality above 0.5, else the union of
 *    observed bases) and says so. Here `consensus_mode` makes the choice
 *    explicit, because "the consensus base" in a report means different things
 *    to a sequencer and to a primer designer.
 *  - **Pairwise identity has two defensible denominators.** `msa.mjs`
 *    `pairwiseIdentities` divides by ALL columns, double-gap columns included;
 *    that is right for "how much of this alignment is shared" but it makes a
 *    pair that is half gaps look less identical than it is. This module divides
 *    by the columns where at least one row has a residue, which is the
 *    convention most alignment reports use. THE TWO ARE NOT INTERCHANGEABLE and
 *    both are documented in their own output and in the tool description; the
 *    numbers here are the ones this module's tests pin.
 *
 * The IUPAC alphabet is imported from `lib.mjs`, never re-encoded. Seven copies
 * of that table were collapsed into one in 0.18.3, with a proof of equivalence;
 * a new module is exactly where an eighth copy would have appeared.
 *
 * All outputs are estimates for working comparisons, not phylogenetic ground
 * truth.
 */

import { BASE_INDEX, IUPAC_MASKS, MASK_SYMBOLS, MolbioInputError } from './lib.mjs';

/** Hard limits, exported so the tool schema, the renderer and tests agree. */
export const ALIGN_POST_LIMITS = {
  /** Rows in the identity matrix. Above this the matrix is omitted, not truncated. */
  maxMatrixSequences: 50,
  /** Entries in each truncated per-column list. */
  maxColumnList: 500,
  /** Longest consensus string echoed in full by the renderer. */
  maxConsensusShown: 120,
};

/** The three consensus definitions, in the order the tool's enum lists them. */
export const CONSENSUS_MODES = ['plurality', 'union', 'strict'];

/**
 * IUPAC code for the union of the bases observed in one column.
 *
 * Built by OR-ing the masks of the observed symbols, so an ambiguous input
 * symbol contributes every base it stands for — the same rule
 * `conservationAnalysis` uses, through the same table.
 */
function unionCode(counts, symbols) {
  let mask = 0;
  for (let index = 0; index < symbols.length; index++) {
    if (counts[index] > 0) mask |= IUPAC_MASKS[symbols[index]];
  }
  return MASK_SYMBOLS[mask] ?? 'N';
}

/**
 * One column's consensus under the requested definition.
 *
 * @param {number[]} counts - per-symbol counts, in `symbols` order.
 * @param {number} residues - how many rows have a residue here.
 * @param {string[]} symbols - the alphabet order the counts use.
 * @param {'plurality'|'union'|'strict'} mode
 * @param {number} threshold - the plurality cut-off, in (0, 1].
 * @returns {{consensus: string, identity: number}}
 *   `identity` is top-symbol count / residues, 0 for an all-gap column.
 */
function columnConsensus(counts, residues, symbols, mode, threshold) {
  if (residues === 0) return { consensus: '-', identity: 0 };
  let top = 0;
  let topSymbol = 'N';
  for (let index = 0; index < symbols.length; index++) {
    if (counts[index] > top) {
      top = counts[index];
      topSymbol = symbols[index];
    }
  }
  const identity = Math.round((top / residues) * 1000) / 1000;
  if (mode === 'union') return { consensus: unionCode(counts, symbols), identity };
  if (mode === 'strict') {
    // 'strict' reports a plain base only when one base carries the column
    // outright; anything mixed becomes N, which is the honest symbol for "this
    // position does not determine a base".
    return { consensus: top / residues >= threshold ? topSymbol : 'N', identity };
  }
  // 'plurality': the top symbol when it is a majority, else the ambiguity code
  // for everything observed — the convention `conservationAnalysis` uses.
  return { consensus: top / residues >= threshold ? topSymbol : unionCode(counts, symbols), identity };
}

/**
 * Alignment post-processing.
 *
 * @param {string[]} rows - equal-length aligned rows ('-' for gaps).
 * @param {object} [options]
 * @param {'plurality'|'union'|'strict'} [options.consensusMode]
 * @param {number} [options.consensusThreshold] - plurality cut-off, (0, 1].
 * @param {number} [options.maxGapFraction] - columns above this are trimmed.
 * @param {number} [options.coverageThreshold] - columns below this are flaggged.
 * @returns {object} see the `molbio_alignment_postprocess` output schema.
 */
export function alignmentPostprocess(rows, {
  consensusMode = 'plurality',
  consensusThreshold = 0.5,
  maxGapFraction = 0.5,
  coverageThreshold = 0.8,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new MolbioInputError(`alignment post-processing needs at least 2 sequences (got ${Array.isArray(rows) ? rows.length : 0})`);
  }
  if (!CONSENSUS_MODES.includes(consensusMode)) {
    throw new MolbioInputError(`unknown consensus_mode ${JSON.stringify(consensusMode)}; available: ${CONSENSUS_MODES.join(', ')}`);
  }
  for (const [name, value] of [['consensus_threshold', consensusThreshold], ['max_gap_fraction', maxGapFraction], ['coverage_threshold', coverageThreshold]]) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new MolbioInputError(`${name} must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
    }
  }
  if (!(consensusThreshold > 0)) {
    throw new MolbioInputError(`consensus_threshold must be greater than 0 (got ${consensusThreshold})`);
  }
  const columns = rows[0].length;
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'string') throw new MolbioInputError(`alignment[${index}] must be a string`);
    if (row.length !== columns) {
      throw new MolbioInputError(`all sequences must have the same length after alignment (expected ${columns} columns, got ${row.length} at row ${index + 1})`);
    }
  }
  if (columns === 0) throw new MolbioInputError('the alignment has no columns');

  // A fixed alphabet order for the per-column counts, and its inverse so each
  // character is one lookup rather than a scan. `IUPAC_MASKS` is the single
  // source of the alphabet (`lib.mjs`); this only fixes an ORDER for counting.
  const symbols = Object.keys(IUPAC_MASKS).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const symbolIndex = new Map(symbols.map((symbol, index) => [symbol, index]));

  // ── per column: consensus, coverage, gap fraction ─────────────────────────
  const consensusChars = [];
  const gapColumns = [];
  const lowCoverage = [];
  const coveragePerColumn = [];
  let conserved = 0;
  let coverageSum = 0;
  let fullyCovered = 0;
  let identitySumOverColumns = 0;
  for (let column = 0; column < columns; column++) {
    const counts = new Array(symbols.length).fill(0);
    let residues = 0;
    for (const row of rows) {
      const character = row[column];
      if (character === '-') continue;
      const index = symbolIndex.get(character);
      if (index === undefined) throw new MolbioInputError(`column ${column + 1} contains ${JSON.stringify(character)}, which is not an IUPAC DNA symbol`);
      counts[index] += 1;
      residues += 1;
    }
    const gaps = rows.length - residues;
    const gapFraction = Math.round((gaps / rows.length) * 1000) / 1000;
    const coverage = Math.round((residues / rows.length) * 1000) / 1000;
    const { consensus, identity } = columnConsensus(counts, residues, symbols, consensusMode, consensusThreshold);
    consensusChars.push(consensus);
    coveragePerColumn.push({ column: column + 1, coverage, residues });
    coverageSum += coverage;
    if (residues === rows.length) fullyCovered += 1;
    if (gapFraction > maxGapFraction) gapColumns.push(column + 1);
    if (coverage < coverageThreshold) lowCoverage.push(column + 1);
    if (residues > 0 && identity >= consensusThreshold) conserved += 1;
    identitySumOverColumns += identity;
  }

  // ── the kept columns after trimming ───────────────────────────────────────
  const trimmed = new Set(gapColumns);
  const keptColumns = [];
  for (let column = 1; column <= columns; column++) if (!trimmed.has(column)) keptColumns.push(column);

  // ── pairwise identity matrix ──────────────────────────────────────────────
  // Numerator: columns where both rows carry the SAME residue. Denominator: the
  // columns where at least one row carries a residue — double-gap columns are
  // excluded, which is this module's convention and NOT `msa.mjs`'s (see the
  // header). A pair with no comparable column at all reports 100, the same
  // convention `pairwiseIdentities` uses for its no-pair case: there is nothing
  // to disagree about.
  const n = rows.length;
  const matrix = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        row.push(100);
        continue;
      }
      let identical = 0;
      let comparable = 0;
      for (let column = 0; column < columns; column++) {
        const left = rows[i][column];
        const right = rows[j][column];
        if (left === '-' && right === '-') continue;
        comparable += 1;
        if (left === right && left !== '-') identical += 1;
      }
      row.push(comparable === 0 ? 100 : Math.round((identical / comparable) * 10000) / 100);
    }
    matrix.push(row);
  }

  // The summary is computed FROM the matrix, not alongside it. Deriving the two
  // separately let them disagree for a pair with no comparable column at all
  // (both rows all-gap): the matrix applies the "nothing to disagree about"
  // convention and reports 100, while a separate pass over the columns averaged
  // to 0. One source means one answer.
  const offDiagonal = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) offDiagonal.push(matrix[i][j]);
  }
  const pairwise = offDiagonal.length === 0 ? { mean: 100, min: 100, max: 100 } : {
    mean: Math.round((offDiagonal.reduce((sum, value) => sum + value, 0) / offDiagonal.length) * 100) / 100,
    min: Math.min(...offDiagonal),
    max: Math.max(...offDiagonal),
  };

  const matrixIncluded = n <= ALIGN_POST_LIMITS.maxMatrixSequences;

  return {
    sequence_count: n,
    aligned_columns: columns,
    consensus_mode: consensusMode,
    consensus_threshold: consensusThreshold,
    consensus: consensusChars.join(''),
    conserved_columns: conserved,
    mean_column_identity: Math.round((identitySumOverColumns / columns) * 10000) / 100,
    gap_fraction_threshold: maxGapFraction,
    columns_before_trim: columns,
    columns_after_trim: keptColumns.length,
    trimmed_columns: gapColumns.slice(0, ALIGN_POST_LIMITS.maxColumnList),
    trimmed_columns_truncated: gapColumns.length > ALIGN_POST_LIMITS.maxColumnList,
    coverage_threshold: coverageThreshold,
    mean_coverage: Math.round((coverageSum / columns) * 1000) / 1000,
    min_coverage: Math.min(...coveragePerColumn.map((entry) => entry.coverage)),
    fully_covered_columns: fullyCovered,
    low_coverage_columns: lowCoverage.slice(0, ALIGN_POST_LIMITS.maxColumnList),
    low_coverage_columns_truncated: lowCoverage.length > ALIGN_POST_LIMITS.maxColumnList,
    per_column: coveragePerColumn.slice(0, ALIGN_POST_LIMITS.maxColumnList),
    per_column_truncated: coveragePerColumn.length > ALIGN_POST_LIMITS.maxColumnList,
    identity_matrix_included: matrixIncluded,
    identity_matrix: matrixIncluded ? matrix : [],
    pairwise_identity_percent: pairwise,
  };
}

/**
 * Render one aligned row for the text report, eliding the middle of a long
 * alignment the same way `showMsaSlice` elides a long sequence.
 */
export function showAlignedSlice(row, budget = ALIGN_POST_LIMITS.maxConsensusShown) {
  if (row.length <= budget) return row;
  const half = Math.floor((budget - 12) / 2);
  return `${row.slice(0, half)} …[${row.length - half * 2} cols]… ${row.slice(row.length - half)}`;
}
