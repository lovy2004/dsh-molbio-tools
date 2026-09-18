/**
 * dsh-molbio-tools/logo.mjs
 *
 * Sequence logo: per-column base frequencies and information content, plus an
 * SVG renderer. Pure computation — deterministic, synchronous, lossless JSON,
 * zero dependencies.
 *
 * Math (stated exactly, because logo conventions differ between tools):
 * - Frequencies are computed over RESIDUES ONLY (gaps excluded), so a gappy
 *   column's letters sum to 1 across the bases actually observed there. Gap
 *   counts are reported per column so a caller can see where the coverage
 *   drops.
 * - Information content uses the four-base distribution obtained by expanding
 *   IUPAC ambiguity codes into their base sets (R contributes half to A and
 *   half to G). Bits max is therefore 2 (log2 4).
 * - R_i = log2(4) - (H_i + e_n) with
 *   e_n = (1 / (2 * ln 2)) * (K - 1) / n  — the conventional small-sample
 *   entropy correction (K = 4 symbols, n = residues in the column), applied
 *   only when `small_sample` is on (default). R_i is clamped to >= 0.
 * - Letter height = frequency * R_i, so a column's letters sum to R_i. This is
 *   "information content" scaling, the standard sequence-logo convention;
 *   `score_type: 'frequency'` switches to plain frequencies (a "frequency
 *   plot", letters sum to 1).
 *
 * The renderer draws text glyphs positioned by baseline, sized in user units
 * (deliberately NOT a transform scale: a scale would scale the font's em box,
 * whose baseline offset is font dependent, and tall columns would overflow).
 * Text renders identically in every browser and without external fonts.
 */

import { MolbioInputError } from './lib.mjs';

/** Bitmask of the ACGT set each IUPAC symbol expands to (A=1, C=2, G=4, T=8). */
const EXPANDED_BASES = {
  A: 1, C: 2, G: 4, T: 8,
  R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3,
  B: 14, D: 13, H: 11, V: 7, N: 15,
};

/** Classic sequence-logo letter colours. */
export const LOGO_COLORS = {
  A: '#2e9b4f',
  C: '#2f6fd0',
  G: '#d99a17',
  T: '#cc3b3b',
};

/** Hard cap on rendered columns — an SVG with 100k glyphs is not a picture. */
export const LOGO_MAX_COLUMNS = 2000;

const LN2 = Math.log(2);

/**
 * Per-column base composition of an alignment.
 * @param {string[]} rows aligned equal-length rows ("-" gaps, IUPAC allowed).
 * @param {{smallSample?: boolean}} [options]
 * @returns {Array<{column: number, residues: number, gaps: number,
 *   a: number, c: number, g: number, t: number,
 *   bits: number, entropy: number, information: number, conservation: number}>}
 *   `bits` is the information content R_i, `entropy` the raw Shannon entropy
 *   in bits, `conservation` the v15-compatible 1 - H/2 score, and the four
 *   base fields are residue fractions summing to 1 (0 when the column is all
 *   gaps — such a column reports R_i = 0 and must not be drawn as stacked
 *   letters of unknown base).
 */
export function columnComposition(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new MolbioInputError(`a sequence logo needs at least 2 aligned sequences (got ${Array.isArray(rows) ? rows.length : 0})`);
  }
  const columns = rows[0].length;
  for (const row of rows) {
    if (row.length !== columns) {
      throw new MolbioInputError(`all sequences must have the same length (expected ${columns} columns, got ${row.length}) — align them first (molbio_msa_align)`);
    }
  }
  if (columns === 0) throw new MolbioInputError('the alignment has no columns');
  if (columns > LOGO_MAX_COLUMNS) {
    throw new MolbioInputError(`the alignment has ${columns} columns; a logo is limited to ${LOGO_MAX_COLUMNS} columns`);
  }
  const smallSample = options.smallSample !== false;
  const out = [];
  for (let c = 0; c < columns; c++) {
    // Weighted base counts: an ambiguity code spreads 1/k of its weight over
    // the k bases it expands to.
    const weights = [0, 0, 0, 0];
    let residues = 0;
    for (const row of rows) {
      const ch = row[c];
      if (ch === '-') continue;
      const mask = EXPANDED_BASES[ch];
      if (mask === undefined) continue; // unreachable for normalized rows
      let cardinality = 0;
      for (let b = 0; b < 4; b++) if ((mask & (1 << b)) !== 0) cardinality++;
      for (let b = 0; b < 4; b++) if ((mask & (1 << b)) !== 0) weights[b] += 1 / cardinality;
      residues++;
    }
    const gaps = rows.length - residues;
    let entropy = 0;
    if (residues > 0) {
      for (const weight of weights) {
        if (weight <= 0) continue;
        const frac = weight / residues;
        entropy -= frac * Math.log2(frac);
      }
    }
    const correction = smallSample && residues > 0 ? (1 / (2 * LN2)) * (4 - 1) / residues : 0;
    const information = Math.max(0, 2 - entropy - correction);
    const round3 = (x) => Math.round(x * 1000) / 1000;
    out.push({
      column: c + 1,
      residues,
      gaps,
      a: residues === 0 ? 0 : round3(weights[0] / residues),
      c: residues === 0 ? 0 : round3(weights[1] / residues),
      g: residues === 0 ? 0 : round3(weights[2] / residues),
      t: residues === 0 ? 0 : round3(weights[3] / residues),
      bits: round3(information),
      entropy: round3(entropy),
      information: round3(information),
      conservation: round3(Math.max(0, 1 - entropy / 2)),
    });
  }
  return out;
}

/** Signature line printed under the logo. */
function headerText(compositions, scoreType, options) {
  const columns = compositions.length;
  const gaps = compositions.reduce((sum, item) => sum + item.gaps, 0);
  const scale = scoreType === 'frequency' ? 'frequency' : 'bits';
  const correction = scoreType === 'frequency' ? '' : ` (small-sample corrected: ${options.smallSample === false ? 'no' : 'yes'})`;
  return `${options.sequenceCount !== undefined ? `${options.sequenceCount} sequences x ` : ''}${columns} columns; letter height = ${scale}${correction}${gaps > 0 ? `; ${gaps} gap(s) excluded from frequencies` : ''}`;
}

/**
 * Render a sequence logo as a standalone SVG document.
 * @param {Array} compositions per-column output of {@link columnComposition}.
 * @param {{title?: string, scoreType?: 'bits'|'frequency', sequenceCount?: number,
 *   smallSample?: boolean, columnWidth?: number, height?: number}} [options]
 * @returns {string} SVG text.
 */
export function renderSequenceLogo(compositions, options = {}) {
  if (!Array.isArray(compositions) || compositions.length === 0) {
    throw new MolbioInputError('cannot render a logo with no columns');
  }
  const scoreType = options.scoreType === 'frequency' ? 'frequency' : 'bits';
  const maxBits = scoreType === 'frequency' ? 1 : 2;
  const columnWidth = options.columnWidth ?? 26;
  const plotHeight = options.height ?? 220;
  const columns = compositions.length;
  const top = 82;
  const left = 74;
  const right = 28;
  const bottomPad = 46;
  const width = left + columns * columnWidth + right;
  const height = top + plotHeight + bottomPad;
  const yFor = (value) => top + plotHeight - (value / maxBits) * plotHeight;
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${left}" y="30" font-size="16" font-weight="bold" fill="#1a1a1a">${escapeXml(options.title ?? 'Sequence logo')}</text>`);
  parts.push(`<text x="${left}" y="50" font-size="11" fill="#555555">${escapeXml(headerText(compositions, scoreType, options))}</text>`);

  // Alternating decade bands so long logos stay readable by eye.
  for (let c = 0; c < columns; c += 10) {
    if ((Math.floor(c / 10) % 2) === 1) {
      const x = left + c * columnWidth;
      const bandWidth = Math.min(10, columns - c) * columnWidth;
      parts.push(`<rect x="${round(x)}" y="${top}" width="${round(bandWidth)}" height="${plotHeight}" fill="#f6f7f9"/>`);
    }
  }

  // Bits grid + y axis.
  const gridStep = scoreType === 'frequency' ? 0.25 : 0.5;
  for (let value = 0; value <= maxBits + 1e-9; value += gridStep) {
    const y = round(yFor(value));
    const isBase = Math.abs(value) < 1e-9 || Math.abs(value - maxBits) < 1e-9;
    parts.push(`<line x1="${left}" y1="${y}" x2="${round(left + columns * columnWidth)}" y2="${y}" stroke="${isBase ? '#9aa0a6' : '#dfe3e8'}" stroke-width="${isBase ? 1 : 0.6}"${isBase ? '' : ' stroke-dasharray="3 3"'}/>`);
    parts.push(`<text x="${left - 8}" y="${round(y + 4)}" font-size="11" text-anchor="end" fill="#444444">${formatTick(value)}</text>`);
  }
  parts.push(`<text x="18" y="${round(top + plotHeight / 2)}" font-size="12" fill="#333333" text-anchor="middle" transform="rotate(-90 18 ${round(top + plotHeight / 2)})">${scoreType === 'frequency' ? 'frequency' : 'information content (bits)'}</text>`);

  // Letters: stack from 0 upward in ascending height so the tallest sits on top.
  // A glyph's pixel height is bounded by BOTH the column width (a letter must
  // not bleed into its neighbour — `textLength` makes the browser compress a
  // wide glyph instead of overflowing) and the plot height (a 2-bit letter in
  // a tall-but-narrow logo is still capped, so the picture stays legible;
  // clipping is impossible because the stacking keeps the top inside the plot).
  const maxFontSize = columnWidth * 0.95;
  for (let c = 0; c < columns; c++) {
    const item = compositions[c];
    const centerX = left + c * columnWidth + columnWidth / 2;
    const fractions = [
      ['A', item.a], ['C', item.c], ['G', item.g], ['T', item.t],
    ].filter(([, fraction]) => fraction > 0);
    fractions.sort((leftPair, rightPair) => leftPair[1] - rightPair[1] || leftPair[0].localeCompare(rightPair[0]));
    let cursor = 0;
    for (const [base, fraction] of fractions) {
      const bits = fraction * item.bits;
      if (bits <= 0.0005) continue;
      const yBottom = yFor(cursor);
      const yTop = yFor(cursor + bits);
      const glyphHeight = yBottom - yTop;
      // A capital letter's cap top sits roughly one cap-height (≈0.72 em in
      // common sans fonts) above its baseline, so dividing by 0.74 makes the
      // ink fill the slot [yTop, yBottom] with a hair of margin — enough that
      // rounding the SVG coordinates can never push the glyph past an edge.
      const fontSize = Math.min(glyphHeight / 0.74, maxFontSize);
      // Baseline AT the slot's bottom keeps a capped (narrow-column) glyph
      // resting on the letter below it instead of floating between slots.
      parts.push(`<text x="${round(centerX)}" y="${round(yBottom)}" font-size="${round(fontSize)}" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" textLength="${round(columnWidth * 0.92)}" lengthAdjust="spacingAndGlyphs" fill="${LOGO_COLORS[base]}">${base}</text>`);
      cursor += bits;
    }
    if (item.bits > 0.0005) {
      parts.push(`<title>column ${item.column}: ${item.bits.toFixed(2)} bits — A ${item.a}, C ${item.c}, G ${item.g}, T ${item.t}${item.gaps > 0 ? ` (${item.gaps} gap(s))` : ''}</title>`);
    }
  }

  // x axis.
  const axisY = top + plotHeight;
  const labelStep = columns <= 40 ? 5 : columns <= 120 ? 10 : 25;
  for (let column = 1; column <= columns; column += labelStep) {
    const x = round(left + (column - 1) * columnWidth + columnWidth / 2);
    parts.push(`<line x1="${x}" y1="${axisY}" x2="${x}" y2="${round(axisY + 4)}" stroke="#9aa0a6" stroke-width="0.8"/>`);
    parts.push(`<text x="${x}" y="${round(axisY + 18)}" font-size="10" text-anchor="middle" fill="#555555">${column}</text>`);
  }
  parts.push(`<text x="${round(left + (columns * columnWidth) / 2)}" y="${round(axisY + 38)}" font-size="12" text-anchor="middle" fill="#333333">alignment position</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function formatTick(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
