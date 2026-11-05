/**
 * dsh-molbio-tools/dotplot.mjs
 *
 * Self-comparison dotplot by exact word matching: a dot at (i, j) means the
 * k-mer starting at i equals the k-mer starting at j (direct repeat), and a red
 * dot means it equals the reverse complement of the k-mer at j (inverted
 * repeat). Pure computation; the SVG is binned into a fixed pixel grid so a
 * repetitive sequence cannot produce a million-element document.
 *
 * Deliberately NOT a window/identity dotplot (EMBOSS dotmatcher-style): this is
 * the k-mer view, which is exact, deterministic and needs no scoring matrix.
 */
import { MolbioInputError, normalizeSequence } from './lib.mjs';
import { axis, linearScale, niceTicks, panel, rect, svgDocument, textRun } from './svgio.mjs';

/** Accepted ranges and work caps. */
export const DOTPLOT_LIMITS = {
  minWord: 4,
  maxWord: 12,
  maxLength: 20_000,
  maxPairs: 200_000,
  maxCells: 60_000,
  grid: 400,
};

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Reverse complement of one canonical k-mer (A/C/G/T only). */
function rcWord(word) {
  let out = '';
  for (let index = word.length - 1; index >= 0; index--) {
    const base = word[index];
    out += base === 'A' ? 'T' : base === 'C' ? 'G' : base === 'G' ? 'C' : 'A';
  }
  return out;
}

/**
 * Compute the self-comparison dotplot.
 *
 * @param {string} raw DNA sequence (IUPAC; ambiguous k-mers are skipped).
 * @param {{word?: number, mode?: 'direct'|'inverted'|'both', grid?: number}} [options]
 * @returns {{length: number, word: number, mode: string, direct_matches: number,
 *   inverted_matches: number, direct_cells: number, inverted_cells: number,
 *   ambiguous_bases: number, truncated: boolean, plot_truncated: boolean,
 *   grid: number, directGrid: Set<number>, invertedGrid: Set<number>}}
 */
export function dotplot(raw, options = {}) {
  const sequence = normalizeSequence(raw, 'sequence');
  if (sequence.length > DOTPLOT_LIMITS.maxLength) {
    throw new MolbioInputError('the sequence is ' + sequence.length + ' bp; the dotplot limit is ' + DOTPLOT_LIMITS.maxLength + ' bp');
  }
  const word = options.word ?? 8;
  if (!Number.isInteger(word) || word < DOTPLOT_LIMITS.minWord || word > DOTPLOT_LIMITS.maxWord) {
    throw new MolbioInputError('word must be an integer between ' + DOTPLOT_LIMITS.minWord + ' and ' + DOTPLOT_LIMITS.maxWord);
  }
  if (sequence.length < word * 2) {
    throw new MolbioInputError('the sequence is ' + sequence.length + ' bp; at word ' + word + ' it needs at least ' + word * 2 + ' bp to show a repeat');
  }
  const mode = options.mode ?? 'both';
  if (!['direct', 'inverted', 'both'].includes(mode)) {
    throw new MolbioInputError('mode must be "direct", "inverted" or "both"');
  }
  const grid = options.grid ?? DOTPLOT_LIMITS.grid;
  if (!Number.isInteger(grid) || grid < 50 || grid > 1000) {
    throw new MolbioInputError('grid must be an integer between 50 and 1000');
  }

  const index = new Map();
  let ambiguousBases = 0;
  for (let start = 0; start + word <= sequence.length; start++) {
    const wordText = sequence.slice(start, start + word);
    let canonical = true;
    for (const base of wordText) {
      if (base !== 'A' && base !== 'C' && base !== 'G' && base !== 'T') {
        canonical = false;
        break;
      }
    }
    if (!canonical) {
      ambiguousBases++;
      continue;
    }
    const list = index.get(wordText);
    if (list === undefined) index.set(wordText, [start]);
    else list.push(start);
  }

  const length = sequence.length;
  const cellOf = (position) => Math.min(grid - 1, Math.floor((position / length) * grid));
  const directGrid = new Set();
  const invertedGrid = new Set();
  let directMatches = 0;
  let invertedMatches = 0;
  let truncated = false;
  let plotTruncated = false;
  let work = 0;

  const addCell = (set, x, y) => {
    const key = x * 4096 + y;
    if (set.has(key)) return;
    // Bound the RENDERED cells, not just the match count: a dense plot must not
    // produce a document with one <rect> per match.
    if (directGrid.size + invertedGrid.size >= DOTPLOT_LIMITS.maxCells) {
      plotTruncated = true;
      return;
    }
    set.add(key);
  };

  outer: for (const [wordText, positions] of index) {
    if (mode === 'direct' || mode === 'both') {
      for (let a = 0; a < positions.length; a++) {
        for (let b = 0; b < positions.length; b++) {
          if (work >= DOTPLOT_LIMITS.maxPairs) {
            truncated = true;
            break outer;
          }
          work++;
          directMatches++;
          addCell(directGrid, cellOf(positions[a]), cellOf(positions[b]));
        }
      }
    }
    if (mode === 'inverted' || mode === 'both') {
      const rc = rcWord(wordText);
      if (rc === wordText) continue; // a palindromic word would double-count the same pairs
      const rcPositions = index.get(rc);
      if (rcPositions === undefined) continue;
      for (const from of positions) {
        for (const to of rcPositions) {
          if (work >= DOTPLOT_LIMITS.maxPairs) {
            truncated = true;
            break outer;
          }
          work++;
          invertedMatches++;
          addCell(invertedGrid, cellOf(from), cellOf(to));
        }
      }
    }
  }

  return {
    length,
    word,
    mode,
    direct_matches: directMatches,
    inverted_matches: invertedMatches,
    direct_cells: directGrid.size,
    inverted_cells: invertedGrid.size,
    ambiguous_bases: ambiguousBases,
    truncated,
    plot_truncated: plotTruncated,
    grid,
    directGrid,
    invertedGrid,
  };
}

/**
 * Render a computed dotplot as an SVG document. The grid is binned: one
 * `<rect>` per occupied cell, so the document size is bounded by the grid, not
 * by the number of matches.
 *
 * @param {ReturnType<typeof dotplot>} data
 * @param {{title?: string}} [options]
 * @returns {string} SVG text.
 */
export function renderDotplot(data, options = {}) {
  const width = 720;
  // The x axis needs a title line BELOW its tick labels, and the legend needs a
  // home INSIDE the panel. At 720 px the plot was 628 px square and the title /
  // legend fell on (or outside) the bottom border; 760 px keeps the plot square
  // (same 628 px) while giving both a row of their own. `bottom: 66` is what
  // preserves that square: 728 (frame) - 34 (top) - 66 = 628.
  const height = 760;
  const frame = panel({
    x: 16,
    y: 16,
    width: width - 32,
    height: height - 32,
    inset: { top: 34, right: 14, bottom: 66, left: 46 },
    title: options.title ?? 'Sequence dotplot',
    subtitle: data.length + ' bp · word ' + data.word + ' · ' + data.mode + ' · ' + data.direct_matches + ' direct / ' + data.inverted_matches + ' inverted match(es)'
      + (data.truncated ? ' · scan capped' : '') + (data.ambiguous_bases > 0 ? ' · ' + data.ambiguous_bases + ' ambiguous k-mer(s) skipped' : ''),
  });
  const plot = frame.plot;
  const x = linearScale([1, data.length], [plot.x, plot.x + plot.width]);
  const y = linearScale([1, data.length], [plot.y + plot.height, plot.y]);
  const cellWidth = plot.width / data.grid;
  const cellHeight = plot.height / data.grid;
  const parts = [frame.markup];
  const drawCells = (set, fill, opacity) => {
    const cells = [];
    for (const key of set) {
      const cx = Math.floor(key / 4096);
      const cy = key - cx * 4096;
      cells.push(rect({
        x: round(plot.x + cx * cellWidth, 2),
        y: round(plot.y + cy * cellHeight, 2),
        width: Math.max(1, round(cellWidth, 2)),
        height: Math.max(1, round(cellHeight, 2)),
        fill,
        fillOpacity: opacity,
      }));
    }
    return cells.join('\n');
  };
  if (data.invertedGrid.size > 0) parts.push(drawCells(data.invertedGrid, '#cf222e', 0.55));
  if (data.directGrid.size > 0) parts.push(drawCells(data.directGrid, '#24292f', 0.7));
  parts.push(axis({
    from: plot.x,
    to: plot.x + plot.width,
    at: plot.y + plot.height,
    ticks: niceTicks([1, data.length], 6).map((tick) => x.of(tick)),
    orientation: 'x',
    tickLabel: (pixel) => String(Math.round(x.invert(pixel))),
    title: 'position (bp)',
  }));
  parts.push(axis({
    from: plot.y,
    to: plot.y + plot.height,
    at: plot.x,
    ticks: niceTicks([1, data.length], 6).map((tick) => y.of(tick)),
    orientation: 'y',
    tickLabel: (pixel) => String(Math.round(y.invert(pixel))),
    title: 'position (bp)',
  }));
  parts.push(legend(data));
  return svgDocument({
    width,
    height,
    title: options.title ?? 'Sequence dotplot',
    description: 'Exact ' + data.word + '-mer self-comparison of a ' + data.length + ' bp sequence; black cells are direct repeats, red cells are inverted repeats.',
    body: parts.join('\n'),
  });
}

/** A compact legend; omitted when the corresponding mode produced no cells. */
function legend(data) {
  const entries = [];
  // Only label a class that was actually computed AND has dots: in
  // inverted-only mode a black "direct repeat" key would claim a measurement
  // that never ran.
  if (data.directGrid.size > 0) entries.push(['#24292f', 'direct repeat']);
  if (data.invertedGrid.size > 0) entries.push(['#cf222e', 'inverted repeat']);
  let x = 28;
  const y = 730;
  const parts = [];
  for (const [color, label] of entries) {
    parts.push(rect({ x, y: y - 8, width: 9, height: 9, fill: color }));
    parts.push(textRun({ x: x + 13, y, text: label, size: 9, fill: '#57606a' }));
    x += 130;
  }
  return parts.join('\n');
}
