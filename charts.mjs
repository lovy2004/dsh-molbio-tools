/**
 * dsh-molbio-tools/charts.mjs
 *
 * Experiment-data charts for `molbio_plot`, in two batches:
 *
 *   batch 1 — histogram, box plot, line chart
 *   batch 2 — violin plot, volcano plot, heatmap
 *
 * plus the CSV/TSV table reader they all share.
 *
 * WHY A SECOND CHART MODULE
 * -------------------------
 * `plot.mjs` (bar chart, scatter, virtual gel) predates `svgio.mjs` and carries
 * its own `escapeXml` / `niceStep` / `validateNumbers` copies. Rewriting it
 * would change SVGs that existing tests and benchmark tasks already assert on,
 * so the new charts are built on `svgio.mjs` instead — new code takes on no new
 * copies of those helpers, old output stays byte-identical. The duplication
 * that remains is registered as a known debt, not an oversight.
 *
 * THE ONE HARD RULE (inherited from `svgio.mjs`)
 * ----------------------------------------------
 * Everything here emits the SVG subset `svgpng.mjs` can rasterize: `rect`,
 * `line`, `circle`, `polygon`, `polyline`, `path`, `text` with `transform` used
 * ONLY for the rotate-about-a-point form that `textRun` already emits. No `<g>`,
 * no `url(#…)`, no gradients, no CSS classes. `test/svgpng.mjs` asserts on real
 * renderer output that `unsupported` and `missing_glyphs` are both EMPTY, so a
 * new construct must fail the suite rather than vanish from the picture.
 *
 * STATISTICS CONVENTIONS (must not drift from the rest of the package)
 * -------------------------------------------------------------------
 * - Quartiles/percentiles use LINEAR INTERPOLATION on the sorted values, the
 *   same `percentile` the FASTQ QC report uses. Two tools reporting different
 *   Q1 for the same numbers would be a silent defect.
 * - The histogram bin count defaults to Freedman-Diaconis,
 *   `ceil((max-min) / (2·IQR·n^(-1/3)))`, falling back to Sturges
 *   `ceil(log2(n)) + 1` when the IQR is zero or degenerate (a rule that cannot
 *   produce a usable bin width must not produce "0 bins" or a NaN).
 * - Box-plot whiskers reach the furthest point within 1.5·IQR; everything past
 *   that is reported as an outlier and drawn individually.
 *
 * Host side only: this module is not part of the client bundle.
 */

import { MolbioInputError } from './lib.mjs';
import {
  COLOR_RAMPS,
  axis,
  circle,
  colorRamp,
  escapeXml,
  formatTick,
  line,
  linearScale,
  niceTicks,
  panel,
  polyline,
  rect,
  round,
  svgDocument,
  textRun,
} from './svgio.mjs';

// ── canvas ──────────────────────────────────────────────────────────────────

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 440;

/** Series palette; index 0 is the package's usual chart blue. */
export const SERIES_COLORS = ['#4a7dd8', '#c73a3a', '#1f883d', '#8250df', '#e8b400', '#0aa2c0', '#d1568b', '#57606a'];

const FRAME_BORDER = '#d0d7de';
const TICK_COLOR = '#57606a';
const GRID_COLOR = '#eef0f2';

// ── statistics ──────────────────────────────────────────────────────────────

/**
 * Linear-interpolation percentile over an ALREADY SORTED array — byte-for-byte
 * the rule `fastq-qc.mjs` uses, so the two agree on every quartile.
 */
export function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

/** Five-number summary plus the 1.5·IQR outlier partition. */
export function boxStats(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) throw new MolbioInputError('a box plot needs at least one finite value');
  const sorted = [...finite].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const inliers = sorted.filter((value) => value >= lowFence && value <= highFence);
  // With every value identical, iqr === 0 and both fences collapse onto that
  // value; the inlier set is then the whole sample and the whiskers coincide
  // with the box, which is the honest picture.
  const whiskerLow = inliers.length > 0 ? inliers[0] : sorted[0];
  const whiskerHigh = inliers.length > 0 ? inliers[inliers.length - 1] : sorted[sorted.length - 1];
  return {
    count: sorted.length,
    min: sorted[0],
    q1,
    median,
    q3,
    max: sorted[sorted.length - 1],
    iqr,
    whisker_low: whiskerLow,
    whisker_high: whiskerHigh,
    outliers: sorted.filter((value) => value < lowFence || value > highFence),
  };
}

/**
 * Histogram bin edges and counts.
 *
 * `requestedBins` wins when given; otherwise Freedman-Diaconis, falling back to
 * Sturges when the IQR cannot support it. The bin count is capped so a huge
 * sample cannot ask for a bar narrower than a pixel.
 */
export function histogramBins(values, requestedBins) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) throw new MolbioInputError('a histogram needs at least one finite value');
  const n = finite.length;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  let binCount;
  let rule;
  if (requestedBins !== undefined) {
    if (!Number.isInteger(requestedBins) || requestedBins < 1 || requestedBins > 200) {
      throw new MolbioInputError('bins must be an integer between 1 and 200');
    }
    binCount = requestedBins;
    rule = 'requested';
  } else if (max === min) {
    binCount = 1;
    rule = 'single-value';
  } else {
    const q1 = percentile([...finite].sort((a, b) => a - b), 0.25);
    const q3 = percentile([...finite].sort((a, b) => a - b), 0.75);
    const iqr = q3 - q1;
    const width = iqr > 0 ? 2 * iqr * n ** (-1 / 3) : 0;
    if (width > 0 && (max - min) / width >= 1) {
      binCount = Math.ceil((max - min) / width);
      rule = 'freedman-diaconis';
    } else {
      binCount = Math.ceil(Math.log2(n)) + 1;
      rule = 'sturges';
    }
  }
  binCount = Math.max(1, Math.min(binCount, 200));
  const width = (max - min) / binCount;
  const edges = [];
  for (let i = 0; i <= binCount; i++) edges.push(min + width * i);
  // The last edge is the sample max, so the max lands in the final bin by
  // closed-right containment rather than falling outside every bin.
  edges[binCount] = max;
  const counts = new Array(binCount).fill(0);
  for (const value of finite) {
    let index = width === 0 ? 0 : Math.floor((value - min) / width);
    if (index >= binCount) index = binCount - 1;
    if (index < 0) index = 0;
    counts[index] += 1;
  }
  const bins = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({ start: edges[i], end: edges[i + 1], count: counts[i] });
  }
  return { bins, bin_count: binCount, bin_width: width, rule, count: n, min, max };
}

// ── CSV / TSV reader ────────────────────────────────────────────────────────

const DELIMITERS = { comma: ',', tab: '\t', semicolon: ';', pipe: '|' };
const MAX_COLUMNS = 200;
const MAX_ROWS = 200000;
/**
 * A plain decimal or scientific number, optionally with `,` thousands groups.
 *
 * The three alternatives are tried in order and each is anchored, so a value is
 * only numeric when a whole branch matches: `1.5` matches the plain branch, and
 * a thousands-grouped `1,234` matches only the first. (An earlier form made the
 * decimal part optional on BOTH digit branches, which let `\d{1,3}` match the
 * `1` of `1.5` and then failed the trailing optional group — rejecting every
 * plain decimal. Anchoring per branch is what makes that impossible.)
 */
const NUMBER_RE = /^(?:[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\d*\.\d+)(?:[eE][+-]?\d+)?)$/;

function delimiterName(character) {
  for (const [name, value] of Object.entries(DELIMITERS)) if (value === character) return name;
  return character;
}

/** Count delimiter candidates outside quoted fields. */
function detectDelimiter(text, requested) {
  if (requested !== undefined && requested !== 'auto') {
    const character = DELIMITERS[requested] ?? requested;
    if (typeof character !== 'string' || character.length !== 1) {
      throw new MolbioInputError(`unknown delimiter ${JSON.stringify(requested)}; use auto, comma, tab, semicolon, pipe, or a single character`);
    }
    return character;
  }
  const head = text.split(/\r?\n/).filter((row) => row.trim() !== '').slice(0, 20);
  if (head.length === 0) throw new MolbioInputError('the data is empty: no header line found');
  let best = null;
  for (const [name, character] of Object.entries(DELIMITERS)) {
    const counts = head.map((row) => {
      let inQuotes = false;
      let count = 0;
      for (const current of row) {
        if (current === '"') inQuotes = !inQuotes;
        else if (current === character && !inQuotes) count += 1;
      }
      return count;
    });
    const first = counts[0];
    if (first === 0) continue;
    // A real delimiter appears the same number of times on every row; that
    // consistency is what separates TSV from "a comma inside free text".
    const consistent = counts.every((count) => count === first);
    const score = consistent ? first + 1000 : first;
    if (best === null || score > best.score) best = { name, character, score };
  }
  if (best === null) return null;
  return best.character;
}

/**
 * Split one delimited line, honouring double-quoted fields and `""` escapes.
 *
 * Two things this deliberately does NOT do:
 * - It never speculates about a stray quote. An unterminated quoted field
 *   swallows the rest of the line, which shows up as a field-count mismatch;
 *   `parseTable` recognises that case and names the quote instead of blaming
 *   the delimiter.
 * - A quote only OPENS a field at the field's first non-space character, so an
 *   inch mark in the middle of a value (`5" probe`) stays literal.
 */
function splitRow(row, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < row.length; i++) {
    const character = row[i];
    if (inQuotes) {
      if (character === '"') {
        if (row[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (character === delimiter) {
      fields.push(current.trim());
      current = '';
      atFieldStart = true;
    } else {
      if (character.trim() !== '') atFieldStart = false;
      current += character;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse delimited text into columns with per-cell numeric inference.
 *
 * A cell that is empty, `NA`, `NaN`, or not a number stays `null` on a numeric
 * column instead of aborting the whole parse: real experiment tables carry
 * missing values, and the honest behaviour is to report the count and let the
 * chart decide. A column containing ANY non-numeric non-null cell is classified
 * `string`, so a mistyped column surfaces as "this column is not numeric"
 * rather than as silently dropped rows.
 */
export function parseTable(text, { delimiter = 'auto', header = true } = {}) {
  if (typeof text !== 'string') throw new MolbioInputError('table data must be a string');
  const rawLines = text.split(/\r?\n/).filter((row) => row.trim() !== '');
  if (rawLines.length === 0) throw new MolbioInputError('the data has no rows');
  const character = detectDelimiter(text, delimiter);
  if (character === null) {
    if (delimiter !== 'auto') {
      throw new MolbioInputError(`no ${delimiterName(DELIMITERS[delimiter] ?? delimiter)} was found on the first line although \`delimiter\` asked for it`);
    }
    // One column of values is a legitimate histogram/box-plot sample
    // ("values.csv" with no header), so single-column data is accepted with the
    // delimiter guessed as a comma. Anything else fails loudly at the shape
    // checks below, which is where the honest error belongs.
    if (rawLines.length === 1) {
      throw new MolbioInputError('could not detect a delimiter (comma, tab, semicolon, pipe) and the data has only one line — pass `delimiter` explicitly, or use the inline array parameter instead');
    }
  }
  const delimiterCharacter = character ?? ',';
  const matrix = rawLines.map((row) => splitRow(row, delimiterCharacter));
  const width = matrix[0].length;
  if (width > MAX_COLUMNS) throw new MolbioInputError(`the table has ${width} columns; the limit is ${MAX_COLUMNS}`);
  matrix.forEach((row, index) => {
    if (row.length !== width) {
      // An unterminated quoted field swallows every delimiter after it, which
      // is by far the most common cause of a short row in a real table — say so
      // instead of sending the caller to hunt for a delimiter problem.
      const oddQuotes = (rawLines[index].match(/"/g) ?? []).length % 2 !== 0;
      const cause = oddQuotes
        ? 'that line has an odd number of double quotes — a quoted field is probably unterminated'
        : 'a delimiter or a stray quote is the usual cause';
      throw new MolbioInputError(`line ${index + 1} has ${row.length} field(s) but the first line has ${width} — every row must have the same number of fields; ${cause}`);
    }
  });
  if (matrix.length > MAX_ROWS + 1) throw new MolbioInputError(`the table has ${matrix.length - 1} data rows; the limit is ${MAX_ROWS}`);
  let names;
  let dataRows;
  if (header) {
    names = matrix[0].map((name, index) => (name === '' ? `column_${index + 1}` : name));
    dataRows = matrix.slice(1);
  } else {
    names = matrix[0].map((_, index) => `column_${index + 1}`);
    dataRows = matrix;
  }
  // Two identically named columns are legal in the wild and fatal to name
  // lookup; disambiguate instead of silently resolving to the first.
  const seen = new Map();
  names = names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  });
  const columns = names.map((name, index) => {
    const values = dataRows.map((row) => row[index]);
    let numeric = true;
    let missing = 0;
    for (const value of values) {
      if (value === '' || value === 'NA' || value === 'NaN' || value === 'null') {
        missing += 1;
        continue;
      }
      if (!NUMBER_RE.test(value)) {
        numeric = false;
        break;
      }
    }
    return {
      name,
      index,
      numeric,
      missing,
      values: values.map((value) => {
        if (value === '' || value === 'NA' || value === 'NaN' || value === 'null') return null;
        if (!numeric) return value;
        const cleaned = value.includes(',') ? value.replaceAll(',', '') : value;
        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? parsed : null;
      }),
    };
  });
  if (dataRows.length === 0) throw new MolbioInputError('the table has a header but no data rows');
  return {
    columns,
    column_names: names,
    row_count: dataRows.length,
    delimiter: delimiterCharacter,
    delimiter_name: delimiterName(delimiterCharacter),
    header: header !== false,
  };
}

/** Case-insensitive, whitespace-tolerant column lookup with a usable error. */
export function findColumn(table, requested, label = 'column') {
  const wanted = String(requested).trim().toLowerCase();
  const exact = table.columns.find((column) => column.name.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  const prefix = table.columns.filter((column) => column.name.toLowerCase().startsWith(wanted));
  if (prefix.length === 1) return prefix[0];
  const hint = prefix.length > 1 ? ` (it matches ${prefix.map((column) => JSON.stringify(column.name)).join(', ')} — name one exactly)` : '';
  throw new MolbioInputError(`${label} ${JSON.stringify(requested)} is not a column of the table${hint}; columns are: ${table.column_names.map((name) => JSON.stringify(name)).join(', ')}`);
}

/**
 * One numeric column as an array, naming the first offending row on failure.
 *
 * `firstDataLine` is the sheet line of data row 0 (2 when there is a header,
 * because the header is line 1). Getting this wrong sends the caller to the
 * wrong line of their table, which on a real experiment sheet costs more than
 * the error itself.
 */
export function numericColumn(table, column, firstDataLine = 2) {
  const values = [];
  for (let index = 0; index < column.values.length; index++) {
    const value = column.values[index];
    if (value === null) continue;
    if (typeof value !== 'number') {
      throw new MolbioInputError(`line ${index + firstDataLine}, column ${JSON.stringify(column.name)}: ${JSON.stringify(value)} is not a number`);
    }
    values.push(value);
  }
  if (values.length === 0) throw new MolbioInputError(`column ${JSON.stringify(column.name)} has no numeric values`);
  return values;
}

export function numericColumns(table) {
  return table.columns.filter((column) => column.numeric);
}

/**
 * Resolve a table from the caller's data source.
 *
 * `data_path` (a workspace file) and `data` (inline text) are mutually
 * exclusive. `readFile` may be synchronous (returning the text) or async
 * (returning a promise of it) — the fs seam is async, the tests are not, and
 * `await` handles both — which is why this function is async. Returns `null`
 * when neither source was given, so a caller can fall through to its inline
 * array form.
 */
export async function resolveTable({ data_path: dataPath, data, delimiter, header }, readFile) {
  if (dataPath !== undefined && data !== undefined) {
    throw new MolbioInputError('pass either data_path (a workspace file) or data (inline text), not both');
  }
  if (dataPath !== undefined) {
    if (typeof dataPath !== 'string' || dataPath.trim() === '') throw new MolbioInputError('data_path must be a non-empty path');
    const text = await readFile(dataPath);
    if (typeof text !== 'string') throw new MolbioInputError(`could not read ${dataPath} as text`);
    return parseTable(text, { delimiter, header });
  }
  if (data !== undefined) {
    if (typeof data !== 'string' || data.trim() === '') throw new MolbioInputError('data must be non-empty text in CSV/TSV form');
    return parseTable(data, { delimiter, header });
  }
  return null;
}

// ── drawing scaffolding ─────────────────────────────────────────────────────

function validateFinite(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new MolbioInputError(`${label} must be a non-empty array`);
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new MolbioInputError(`${label} contains a non-finite value: ${JSON.stringify(value)}`);
    }
  }
  return values;
}

/** A padded domain so points are not drawn on the axis itself. */
function padDomain(min, max, fraction = 0.05) {
  if (max === min) {
    const pad = Math.abs(max) * 0.1 + 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * fraction;
  return [min - pad, max + pad];
}

/**
 * Document margins, as measured from the panel's inner plot rectangle to the
 * canvas edge. The band from the canvas edge to the plot is what holds the axis
 * titles, so the left band has to clear the rotated Y title and the bottom band
 * the X title plus the tick labels. These are converted into `panel` insets
 * below — `panel` applies its insets FROM the card edge, so they are the frame
 * origin plus the band, not the band alone. (Passing the band alone draws the
 * plot rectangle outward and every mark lands off its own axes; that was the
 * first bug this file had.)
 */
const FRAME_ORIGIN = 8;
const FRAME_SIZE = { width: CHART_WIDTH - 16, height: CHART_HEIGHT - 16 };

/**
 * The band between the card edge and the plot rectangle, per side. It holds the
 * axis titles (left and bottom), the x tick labels (bottom), and the chart title
 * plus the legend (top) — the top band is the tallest of the four because those
 * last two stack there rather than overlapping.
 */
const AXIS_BAND = { top: 62, right: 28, bottom: 62, left: 74 };

function frame(title) {
  const body = panel({
    x: FRAME_ORIGIN,
    y: FRAME_ORIGIN,
    ...FRAME_SIZE,
    // The card supplies the border and the plot rectangle; the chart title is
    // drawn by `finish` at the document's own scale, so `panel`'s title slot
    // stays empty and the top band reserves the strip it would have used.
    inset: {
      top: FRAME_ORIGIN + AXIS_BAND.top,
      right: FRAME_ORIGIN + AXIS_BAND.right,
      bottom: FRAME_ORIGIN + AXIS_BAND.bottom,
      left: FRAME_ORIGIN + AXIS_BAND.left,
    },
  });
  const parts = [body.markup];
  if (title !== undefined && title !== '') {
    parts.push(textRun({ x: body.plot.x + body.plot.width / 2, y: 30, text: title, size: 15, weight: 'bold', anchor: 'middle' }));
  }
  return { parts, plot: body.plot };
}

function finish(parts, { title, description, xTitle, yTitle, plot }) {
  if (yTitle !== undefined && yTitle !== '') {
    parts.push(textRun({ x: 22, y: plot.y + plot.height / 2, text: yTitle, size: 11, anchor: 'middle', rotate: -90, fill: TICK_COLOR }));
  }
  if (xTitle !== undefined && xTitle !== '') {
    parts.push(textRun({ x: plot.x + plot.width / 2, y: CHART_HEIGHT - 20, text: xTitle, size: 11, anchor: 'middle', fill: TICK_COLOR }));
  }
  return svgDocument({
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    title: title ?? '',
    description: description ?? '',
    body: parts.join('\n'),
  });
}

/**
 * Horizontal grid lines, y tick labels and the y scale for one domain.
 * Mirrors the axis convention the existing charts use (grid behind data, ticks
 * on the left spine), so a new chart sits next to an old one without looking
 * like a different product.
 */
function yAxis(parts, plot, min, max, label) {
  const scale = linearScale([min, max], [plot.y + plot.height, plot.y]);
  const ticks = niceTicks([min, max], 6);
  for (const tick of ticks) {
    const y = scale.of(tick);
    parts.push(line({ x1: plot.x, y1: y, x2: plot.x + plot.width, y2: y, stroke: GRID_COLOR, width: 1 }));
    parts.push(textRun({ x: plot.x - 6, y: y + 3, text: formatTick(tick), size: 9, anchor: 'end', fill: TICK_COLOR }));
  }
  parts.push(line({ x1: plot.x, y1: plot.y, x2: plot.x, y2: plot.y + plot.height, stroke: '#24292f', width: 1.2 }));
  parts.push(line({ x1: plot.x, y1: plot.y + plot.height, x2: plot.x + plot.width, y2: plot.y + plot.height, stroke: '#24292f', width: 1.2 }));
  return scale;
}

/**
 * Legend for a multi-series chart, laid out in the TOP BAND between the chart
 * title and the plot rectangle.
 *
 * It deliberately does not sit inside the plot: a legend drawn there covers the
 * series it describes (the first chart version put a swatch on top of the first
 * data point) and it also shares the series colours, so a pixel assertion about
 * the data cannot tell the legend apart from the lines.
 */
function legend(parts, plot, entries) {
  if (entries.length <= 1) return;
  const perRow = Math.min(entries.length, 4);
  const columnWidth = plot.width / perRow;
  entries.forEach((entry, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const x = plot.x + column * columnWidth;
    // 24 px above the plot rectangle, not 6: a legend drawn close to the plot
    // reads as part of the data area, and a pixel test that scans for the
    // series colour finds the swatch instead of the line.
    const y = plot.y - 24 - row * 13;
    parts.push(rect({ x: x, y: y - 7, width: 9, height: 9, fill: entry.color, rx: 1 }));
    parts.push(textRun({ x: x + 13, y: y, text: entry.label, size: 9, fill: '#57606a' }));
  });
}

// ── histogram ───────────────────────────────────────────────────────────────

/**
 * Histogram of one numeric sample. Bins default to Freedman-Diaconis.
 *
 * @returns {{svg: string, stats: object, marks: number}}
 */
export function renderHistogram({ title, x_label, y_label, values, bins: requestedBins, color = SERIES_COLORS[0] }) {
  const sample = validateFinite(values, 'values');
  const shape = histogramBins(sample, requestedBins);
  const { parts, plot } = frame(title);
  const counts = shape.bins.map((bin) => bin.count);
  const yMax = Math.max(1, ...counts);
  const y = yAxis(parts, plot, 0, yMax, y_label);
  const x = linearScale(shape.min === shape.max ? [shape.min - 0.5, shape.max + 0.5] : [shape.min, shape.max], [plot.x, plot.x + plot.width]);
  const slot = plot.width / shape.bin_count;
  shape.bins.forEach((bin, index) => {
    if (bin.count === 0) return;
    // Bin edges come from the data domain, so on a nice round domain the first
    // edge can round to the same pixel as the plot's left edge; clamp to the
    // plot rectangle so a bar never spills outside its own axis.
    const rawLeft = shape.min === shape.max ? plot.x + index * slot : x.of(bin.start);
    const rawRight = shape.min === shape.max ? rawLeft + slot : x.of(bin.end);
    const left = Math.max(plot.x, rawLeft);
    const right = Math.min(plot.x + plot.width, rawRight);
    const top = y.of(bin.count);
    const base = y.of(0);
    // A 1 px inset keeps neighbouring bars from touching, which is what makes a
    // count-0 bin read as a visible gap rather than as a slightly wider bar.
    const barLeft = left + 0.5;
    const barWidth = Math.max(1, right - left - 1);
    parts.push(rect({
      x: barLeft,
      y: top,
      width: barWidth,
      height: Math.max(1, base - top),
      fill: color,
      fillOpacity: 0.9,
      rx: 1,
    }));
  });
  for (const tick of niceTicks([shape.min, shape.max], 6)) {
    const px = x.of(tick);
    parts.push(line({ x1: px, y1: plot.y + plot.height, x2: px, y2: plot.y + plot.height + 4, stroke: TICK_COLOR, width: 1 }));
    parts.push(textRun({ x: px, y: plot.y + plot.height + 16, text: formatTick(tick), size: 9, anchor: 'middle', fill: TICK_COLOR }));
  }
  const note = `bins: ${shape.bin_count} x ${formatTick(shape.bin_width)} (${shape.rule})`;
  parts.push(textRun({ x: plot.x + plot.width, y: plot.y - 6, text: note, size: 9, anchor: 'end', fill: TICK_COLOR }));
  const svg = finish(parts, { title, description: `histogram of ${shape.count} values in ${shape.bin_count} bins`, xTitle: x_label, yTitle: y_label, plot });
  return { svg, stats: shape, marks: shape.count, plot };
}

// ── box plot ────────────────────────────────────────────────────────────────

/**
 * Box plot of one or more samples side by side.
 * `series` is `[{ label, values }]`; whiskers reach 1.5·IQR, outliers are dots.
 */
export function renderBoxPlot({ title, x_label, y_label, series }) {
  if (!Array.isArray(series) || series.length === 0) throw new MolbioInputError('a box plot needs at least one series');
  const prepared = series.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new MolbioInputError(`series ${index + 1} must be an object with a values array`);
    const label = entry.label === undefined || entry.label === '' ? `series ${index + 1}` : String(entry.label);
    const stats = boxStats(validateFinite(entry.values, `series ${index + 1} values`));
    return { label, stats, color: entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length] };
  });
  const lows = prepared.map((entry) => Math.min(entry.stats.whisker_low, ...entry.stats.outliers, entry.stats.min));
  const highs = prepared.map((entry) => Math.max(entry.stats.whisker_high, ...entry.stats.outliers, entry.stats.max));
  const [domainMin, domainMax] = padDomain(Math.min(...lows), Math.max(...highs));
  const { parts, plot } = frame(title);
  const y = yAxis(parts, plot, domainMin, domainMax, y_label);
  const slot = plot.width / prepared.length;
  const boxWidth = Math.max(8, Math.min(64, slot * 0.5));
  prepared.forEach((entry, index) => {
    const cx = plot.x + slot * index + slot / 2;
    const { stats } = entry;
    const q1 = y.of(stats.q1);
    const q3 = y.of(stats.q3);
    const mid = y.of(stats.median);
    parts.push(rect({ x: cx - boxWidth / 2, y: Math.min(q1, q3), width: boxWidth, height: Math.max(1, Math.abs(q1 - q3)), fill: entry.color, fillOpacity: 0.35, stroke: entry.color, strokeWidth: 1.2 }));
    parts.push(line({ x1: cx - boxWidth / 2, y1: mid, x2: cx + boxWidth / 2, y2: mid, stroke: entry.color, width: 2 }));
    parts.push(line({ x1: cx, y1: q3, x2: cx, y2: y.of(stats.whisker_high), stroke: entry.color, width: 1.2 }));
    parts.push(line({ x1: cx, y1: q1, x2: cx, y2: y.of(stats.whisker_low), stroke: entry.color, width: 1.2 }));
    for (const end of [y.of(stats.whisker_high), y.of(stats.whisker_low)]) {
      parts.push(line({ x1: cx - boxWidth / 4, y1: end, x2: cx + boxWidth / 4, y2: end, stroke: entry.color, width: 1.2 }));
    }
    for (const outlier of stats.outliers) {
      parts.push(circleMark(cx, y.of(outlier), entry.color));
    }
    const label = entry.label.length > 16 ? `${entry.label.slice(0, 15)}…` : entry.label;
    parts.push(textRun({ x: cx, y: plot.y + plot.height + 16, text: label, size: 9, anchor: 'middle', fill: TICK_COLOR }));
    parts.push(textRun({ x: cx, y: plot.y + plot.height + 28, text: `n=${stats.count}`, size: 8, anchor: 'middle', fill: TICK_COLOR }));
  });
  parts.push(textRun({ x: plot.x + plot.width, y: plot.y - 6, text: 'box: Q1-Q3, line: median, whiskers: 1.5xIQR, dots: outliers', size: 9, anchor: 'end', fill: TICK_COLOR }));
  const svg = finish(parts, { title, description: `box plot of ${prepared.length} series`, xTitle: x_label, yTitle: y_label, plot });
  return { svg, stats: prepared.map((entry) => ({ label: entry.label, ...entry.stats })), marks: prepared.reduce((sum, entry) => sum + entry.stats.count, 0), plot };
}

/** One small outlier dot (kept local so `circle` stays an explicit import). */
function circleMark(cx, cy, fill) {
  return `<circle cx="${round(cx)}" cy="${round(cy)}" r="2.5" fill="${fill}"/>`;
}

// ── line chart ──────────────────────────────────────────────────────────────

/**
 * Line chart: one or more series against a shared numeric x.
 * `series` is `[{ label, x, y }]` — every series must share the x length.
 */
export function renderLineChart({ title, x_label, y_label, series, markers = true }) {
  if (!Array.isArray(series) || series.length === 0) throw new MolbioInputError('a line chart needs at least one series');
  const prepared = series.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new MolbioInputError(`series ${index + 1} must be an object with x and y arrays`);
    const xs = validateFinite(entry.x, `series ${index + 1} x`);
    const ys = validateFinite(entry.y, `series ${index + 1} y`);
    if (xs.length !== ys.length) throw new MolbioInputError(`series ${index + 1}: x and y must have the same length (got ${xs.length} and ${ys.length})`);
    if (xs.length < 2) throw new MolbioInputError(`series ${index + 1} needs at least 2 points to draw a line`);
    return {
      label: entry.label === undefined || entry.label === '' ? `series ${index + 1}` : String(entry.label),
      xs,
      ys,
      color: entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length],
      dash: entry.dash,
    };
  });
  const allX = prepared.flatMap((entry) => entry.xs);
  const allY = prepared.flatMap((entry) => entry.ys);
  const [xMin, xMax] = padDomain(Math.min(...allX), Math.max(...allX));
  const [yMin, yMax] = padDomain(Math.min(...allY), Math.max(...allY));
  const { parts, plot } = frame(title);
  const y = yAxis(parts, plot, yMin, yMax, y_label);
  const x = linearScale([xMin, xMax], [plot.x, plot.x + plot.width]);
  for (const tick of niceTicks([xMin, xMax], 6)) {
    const px = x.of(tick);
    parts.push(line({ x1: px, y1: plot.y, x2: px, y2: plot.y + plot.height, stroke: '#f6f7f8', width: 1 }));
    parts.push(textRun({ x: px, y: plot.y + plot.height + 16, text: formatTick(tick), size: 9, anchor: 'middle', fill: TICK_COLOR }));
  }
  for (const entry of prepared) {
    const points = entry.xs.map((value, index) => [x.of(value), y.of(entry.ys[index])]);
    parts.push(polyline(points, { stroke: entry.color, width: 1.8, dash: entry.dash }));
    if (markers === true) {
      for (const [px, py] of points) {
        parts.push(`<circle cx="${round(px)}" cy="${round(py)}" r="2.6" fill="${entry.color}"/>`);
      }
    }
  }
  legend(parts, plot, prepared.map((entry) => ({ label: entry.label, color: entry.color })));
  const svg = finish(parts, { title, description: `line chart of ${prepared.length} series`, xTitle: x_label, yTitle: y_label, plot });
  return {
    svg,
    stats: {
      series: prepared.map((entry) => ({ label: entry.label, points: entry.xs.length, x_min: Math.min(...entry.xs), x_max: Math.max(...entry.xs), y_min: Math.min(...entry.ys), y_max: Math.max(...entry.ys) })),
      series_count: prepared.length,
      point_count: prepared.reduce((sum, entry) => sum + entry.xs.length, 0),
      x_range: [Math.min(...allX), Math.max(...allX)],
      y_range: [Math.min(...allY), Math.max(...allY)],
    },
    marks: prepared.reduce((sum, entry) => sum + entry.xs.length, 0),
    plot,
  };
}

/** Escape helper re-exported for callers that build their own annotations. */
export { escapeXml };

// ── violin plot ─────────────────────────────────────────────────────────────

/** Cap on the sample a density estimate is run over, so a tool call stays bounded. */
const MAX_DENSITY_VALUES = 20000;

/**
 * Gaussian kernel density estimate over a fixed 0..1 grid.
 *
 * The bandwidth is Silverman's rule of thumb using `min(σ, IQR/1.34)` — the
 * IQR form matters because a single outlier inflates σ and would otherwise
 * flatten the whole violin into a smear. A floor on `h` keeps a constant or
 * near-constant sample from producing a spike of infinite height, and the grid
 * is normalised so the caller only has to scale by the plot half-width.
 *
 * @returns {{grid: number[], density: number[], bandwidth: number, peak: number}}
 */
export function kernelDensity(values, { bandwidth, gridPoints = 128 } = {}) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) throw new MolbioInputError('a density estimate needs at least one finite value');
  if (finite.length > MAX_DENSITY_VALUES) {
    throw new MolbioInputError(`a violin plot is capped at ${MAX_DENSITY_VALUES} values per series (got ${finite.length}); aggregate or subsample first`);
  }
  const n = finite.length;
  const mean = finite.reduce((sum, value) => sum + value, 0) / n;
  const sorted = [...finite].sort((a, b) => a - b);
  const iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25);
  const variance = n > 1 ? finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  const sigma = Math.sqrt(variance);
  const spread = Math.min(sigma > 0 ? sigma : Infinity, iqr > 0 ? iqr / 1.34 : Infinity);
  const scale = Number.isFinite(spread) && spread > 0 ? spread : Math.max(Math.abs(mean) * 0.1, 1);
  // Silverman, with a floor: a degenerate sample must not divide by zero.
  const h = Math.max(bandwidth ?? 1.06 * scale * n ** (-1 / 5), 1e-9);
  // The grid spans the DATA, not 0..1. Evaluating the kernel at fractions of 1
  // while the sample lives around 22 puts every term ~80 bandwidths out, where
  // exp underflows to exactly 0 — the first version of this function returned an
  // all-zero density for that reason. `from`/`to` are returned so the caller
  // draws the silhouette on the same axis it measured.
  const padding = Math.max((sorted[n - 1] - sorted[0]) * 0.1, h * 3);
  const from = sorted[0] - padding;
  const to = sorted[n - 1] + padding;
  const grid = [];
  const density = [];
  for (let index = 0; index < gridPoints; index++) {
    const t = gridPoints === 1 ? (from + to) / 2 : from + ((to - from) * index) / (gridPoints - 1);
    grid.push(t);
    let sum = 0;
    for (const value of finite) {
      const z = (value - t) / h;
      sum += Math.exp(-0.5 * z * z);
    }
    // Normalised by n only: the constant factor 1/(h·√2π) is shared by every
    // grid point, so the caller's scaling is unaffected and the numbers stay
    // readable. The result is then divided by its own peak, so the shape can be
    // scaled to a half-width without knowing the data's units.
    density.push(sum / n);
  }
  const peak = Math.max(...density, 1e-12);
  return { grid, density: density.map((value) => value / peak), bandwidth: h, peak, from, to };
}

/**
 * Violin plot: one kernel density silhouette per sample, with the box summary
 * (median + IQR) drawn inside it.
 *
 * The silhouette is a polygon, not a clip path: the rasterizer has no `<g>` and
 * no `url(#…)`, so the shape has to be built from the grid points directly.
 */
export function renderViolinPlot({ title, x_label, y_label, series, bandwidth, show_box = true }) {
  if (!Array.isArray(series) || series.length === 0) throw new MolbioInputError('a violin plot needs at least one series');
  const prepared = series.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new MolbioInputError(`series ${index + 1} must be an object with a values array`);
    const values = validateFinite(entry.values, `series ${index + 1} values`);
    return {
      label: entry.label === undefined || entry.label === '' ? `series ${index + 1}` : String(entry.label),
      values,
      stats: boxStats(values),
      density: kernelDensity(values, bandwidth === undefined ? {} : { bandwidth }),
      color: entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length],
    };
  });
  const lows = prepared.map((entry) => entry.stats.min);
  const highs = prepared.map((entry) => entry.stats.max);
  const [domainMin, domainMax] = padDomain(Math.min(...lows), Math.max(...highs));
  const { parts, plot } = frame(title);
  const y = yAxis(parts, plot, domainMin, domainMax, y_label);
  const slot = plot.width / prepared.length;
  const halfWidth = Math.min(slot * 0.42, 90);
  prepared.forEach((entry, index) => {
    const centre = plot.x + slot * index + slot / 2;
    const points = [];
    entry.density.grid.forEach((t, point) => {
      points.push([centre + entry.density.density[point] * halfWidth, y.of(t)]);
    });
    for (let point = entry.density.grid.length - 1; point >= 0; point--) {
      points.push([centre - entry.density.density[point] * halfWidth, y.of(entry.density.grid[point])]);
    }
    parts.push(polyline(points, { fill: entry.color, stroke: entry.color, width: 1, closed: true, opacity: 0.45 }));
    if (show_box === true) {
      const { stats } = entry;
      parts.push(line({ x1: centre - halfWidth * 0.28, y1: y.of(stats.q1), x2: centre + halfWidth * 0.28, y2: y.of(stats.q1), stroke: '#24292f', width: 1 }));
      parts.push(line({ x1: centre - halfWidth * 0.28, y1: y.of(stats.q3), x2: centre + halfWidth * 0.28, y2: y.of(stats.q3), stroke: '#24292f', width: 1 }));
      parts.push(line({ x1: centre - halfWidth * 0.28, y1: y.of(stats.median), x2: centre + halfWidth * 0.28, y2: y.of(stats.median), stroke: '#24292f', width: 2 }));
    }
    const label = entry.label.length > 16 ? `${entry.label.slice(0, 15)}…` : entry.label;
    parts.push(textRun({ x: centre, y: plot.y + plot.height + 16, text: label, size: 9, anchor: 'middle', fill: TICK_COLOR }));
    parts.push(textRun({ x: centre, y: plot.y + plot.height + 28, text: `n=${entry.values.length}`, size: 8, anchor: 'middle', fill: TICK_COLOR }));
  });
  parts.push(textRun({ x: plot.x + plot.width, y: plot.y - 6, text: 'outline: Gaussian kernel density, bars: median and IQR', size: 9, anchor: 'end', fill: TICK_COLOR }));
  const svg = finish(parts, { title, description: `violin plot of ${prepared.length} series`, xTitle: x_label, yTitle: y_label, plot });
  return {
    svg,
    // Same per-series shape as the box plot (plus the bandwidth), so a caller —
    // and the tool's own summary — can read either kind identically.
    stats: prepared.map((entry) => ({
      label: entry.label,
      count: entry.stats.count,
      min: entry.stats.min,
      q1: entry.stats.q1,
      median: entry.stats.median,
      q3: entry.stats.q3,
      max: entry.stats.max,
      outliers: entry.stats.outliers,
      bandwidth: entry.density.bandwidth,
    })),
    total_values: prepared.reduce((sum, entry) => sum + entry.values.length, 0),
    marks: prepared.reduce((sum, entry) => sum + entry.values.length, 0),
    plot,
  };
}

// ── volcano plot ────────────────────────────────────────────────────────────

/**
 * Volcano plot: effect size against significance.
 *
 * This computes NO statistics of its own. `-log10(p)` is a display transform of
 * a p-value the data already carries, and the fold-change threshold is a label,
 * not a test — deciding what counts as significant is the caller's business.
 */
export function renderVolcanoPlot({ title, x_label, y_label, points, fold_change_threshold = 1, p_threshold = 0.05, label_top = 0 }) {
  if (!Array.isArray(points) || points.length === 0) throw new MolbioInputError('a volcano plot needs at least one point');
  const prepared = points.map((point, index) => {
    if (point === null || typeof point !== 'object') throw new MolbioInputError(`point ${index + 1} must be an object with log2fc and p`);
    const fold = point.log2fc;
    const p = point.p;
    if (typeof fold !== 'number' || !Number.isFinite(fold)) throw new MolbioInputError(`point ${index + 1}: log2fc must be a finite number`);
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p > 1) throw new MolbioInputError(`point ${index + 1}: p must be a number in (0, 1] (a p-value of 0 cannot be plotted; use the smallest reported value)`);
    return {
      label: point.label === undefined ? '' : String(point.label),
      fold,
      p,
      significance: -Math.log10(p),
    };
  });
  const significant = (point) => Math.abs(point.fold) >= fold_change_threshold && point.p <= p_threshold;
  const xs = prepared.map((point) => point.fold);
  const ys = prepared.map((point) => point.significance);
  const [xMin, xMax] = padDomain(Math.min(0, ...xs), Math.max(0, ...xs));
  const [yMin, yMax] = padDomain(0, Math.max(...ys, -Math.log10(p_threshold)));
  const { parts, plot } = frame(title);
  const y = yAxis(parts, plot, yMin, yMax, y_label ?? '-log10 p');
  const x = linearScale([xMin, xMax], [plot.x, plot.x + plot.width]);
  for (const tick of niceTicks([xMin, xMax], 6)) {
    const px = x.of(tick);
    parts.push(line({ x1: px, y1: plot.y, x2: px, y2: plot.y + plot.height, stroke: '#f6f7f8', width: 1 }));
    parts.push(textRun({ x: px, y: plot.y + plot.height + 16, text: formatTick(tick), size: 9, anchor: 'middle', fill: TICK_COLOR }));
  }
  // Threshold guides: dashed, because they mark a CHOICE rather than data.
  for (const boundary of [-fold_change_threshold, fold_change_threshold]) {
    if (boundary <= xMin || boundary >= xMax) continue;
    const px = x.of(boundary);
    parts.push(line({ x1: px, y1: plot.y, x2: px, y2: plot.y + plot.height, stroke: '#8c959f', width: 1, dash: [4, 3] }));
  }
  const pLine = y.of(-Math.log10(p_threshold));
  parts.push(line({ x1: plot.x, y1: pLine, x2: plot.x + plot.width, y2: pLine, stroke: '#8c959f', width: 1, dash: [4, 3] }));
  const up = '#c73a3a';
  const down = '#2166ac';
  const flat = '#9aa4ae';
  const ordered = [...prepared].sort((a, b) => b.significance - a.significance);
  const labelled = new Set(ordered.filter((point) => point.label !== '').slice(0, Math.max(0, label_top)).map((point) => point.label));
  for (const point of prepared) {
    const px = x.of(point.fold);
    const py = y.of(point.significance);
    if (!significant(point)) {
      parts.push(circle({ cx: px, cy: py, r: 2.6, fill: flat, fillOpacity: 0.6 }));
      continue;
    }
    parts.push(circle({ cx: px, cy: py, r: 3.4, fill: point.fold > 0 ? up : down }));
    if (labelled.has(point.label)) {
      parts.push(textRun({ x: px + 5, y: py + 3, text: point.label, size: 8, fill: '#24292f' }));
    }
  }
  parts.push(textRun({ x: plot.x + plot.width, y: plot.y - 6, text: `dashed: |log2FC| ${formatTick(fold_change_threshold)} and p ${formatTick(p_threshold)}`, size: 9, anchor: 'end', fill: TICK_COLOR }));
  const svg = finish(parts, { title, description: `volcano plot of ${prepared.length} points`, xTitle: x_label ?? 'log2 fold change', yTitle: y_label ?? '-log10 p', plot });
  return {
    svg,
    stats: {
      count: prepared.length,
      significant_count: prepared.filter(significant).length,
      up_count: prepared.filter((point) => significant(point) && point.fold > 0).length,
      down_count: prepared.filter((point) => significant(point) && point.fold < 0).length,
      fold_change_threshold,
      p_threshold,
      max_significance: Math.max(...ys),
      labelled: [...labelled],
    },
    marks: prepared.length,
    plot,
  };
}

// ── heatmap ─────────────────────────────────────────────────────────────────

/** Cap on cells, so a large matrix fails in the tool rather than in the rasterizer. */
export const MAX_HEATMAP_CELLS = 4000;

/**
 * Heatmap of a row × column matrix, one `<rect>` per cell.
 *
 * Deliberately NOT a gradient: the rasterizer rejects `<linearGradient>` and
 * `<g>`, and `test/svgpng.mjs` asserts real renderer output contains nothing
 * unsupported. A grid of computed hex fills is also what makes a pixel
 * assertion possible at all.
 *
 * `scale` is a display transform, not a statistic: `row_zscore` is the usual
 * way to compare profiles whose levels differ, and the output says it was done
 * (`scaled: true`) so nobody reads it as raw values.
 */
export function renderHeatmap({ title, x_label, y_label, rows, columns, matrix, scale = 'none', color_scale, value_label = 'value' }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new MolbioInputError('a heatmap needs at least one row');
  if (!Array.isArray(columns) || columns.length === 0) throw new MolbioInputError('a heatmap needs at least one column');
  if (!Array.isArray(matrix) || matrix.length !== rows.length) {
    throw new MolbioInputError(`the matrix must have one row per label (${rows.length} labels, ${Array.isArray(matrix) ? matrix.length : 0} rows)`);
  }
  matrix.forEach((row, index) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new MolbioInputError(`matrix row ${index + 1} has ${Array.isArray(row) ? row.length : 0} value(s) but there are ${columns.length} column label(s)`);
    }
  });
  const cells = rows.length * columns.length;
  if (cells > MAX_HEATMAP_CELLS) {
    throw new MolbioInputError(`the matrix has ${cells} cells; the limit is ${MAX_HEATMAP_CELLS} (a larger grid cannot be drawn legibly in one figure)`);
  }
  const transformed = matrix.map((row) => row.map((value) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new MolbioInputError(`the matrix contains a non-finite value: ${JSON.stringify(value)}`);
    if (scale === 'log2') {
      if (value <= 0) throw new MolbioInputError(`cannot take log2 of ${value}; a log2 scale needs positive values`);
      return Math.log2(value);
    }
    return value;
  }));
  let values = transformed;
  if (scale === 'row_zscore') {
    values = transformed.map((row) => {
      const present = row.filter((value) => value !== null);
      if (present.length === 0) return row;
      const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
      const variance = present.length > 1 ? present.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (present.length - 1) : 0;
      const sigma = Math.sqrt(variance);
      return row.map((value) => (value === null ? null : sigma === 0 ? 0 : (value - mean) / sigma));
    });
  } else if (scale !== 'none' && scale !== 'log2') {
    throw new MolbioInputError(`unknown scale ${JSON.stringify(scale)}; use none, row_zscore or log2`);
  }
  const flat = values.flat().filter((value) => value !== null);
  if (flat.length === 0) throw new MolbioInputError('the matrix has no finite values to draw');
  const min = Math.min(...flat);
  const max = Math.max(...flat);
  const ramp = color_scale ?? (min < 0 ? 'divergingRedBlue' : 'viridis');
  if (COLOR_RAMPS[ramp] === undefined) {
    throw new MolbioInputError(`unknown color_scale ${JSON.stringify(color_scale)}; use ${Object.keys(COLOR_RAMPS).join(', ')}`);
  }
  const position = (value) => (max === min ? 0.5 : (value - min) / (max - min));
  const { parts, plot } = frame(title);
  // Narrow the drawing area by the colour bar's own width BEFORE laying out
  // cells and labels: the first version used the full plot rectangle and then
  // put the bar beside it, which pushed the bar's labels off the canvas.
  const barWidth = 14;
  const barGap = 10;
  const barLabelWidth = 34;
  const gridWidth = Math.max(40, plot.width - barWidth - barGap - barLabelWidth);
  const barX = plot.x + gridWidth + barGap;
  const cellWidth = gridWidth / columns.length;
  const cellHeight = plot.height / rows.length;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < columns.length; c++) {
      const value = values[r][c];
      const x = plot.x + c * cellWidth;
      const y = plot.y + r * cellHeight;
      if (value === null) {
        // A missing cell is drawn pale grey, NOT as the ramp's midpoint: "no
        // measurement" must not read as "mid value".
        parts.push(rect({ x: x, y: y, width: cellWidth, height: cellHeight, fill: '#f2f3f5', stroke: '#ffffff', strokeWidth: 0.5 }));
        continue;
      }
      // `position` maps the smallest value to 0 and the largest to 1, and every
      // ramp in `COLOR_RAMPS` is listed LOW END FIRST — so this is a direct
      // mapping, no inversion. An earlier version wrote `1 - position` here,
      // which painted the most negative cell red and the most positive blue:
      // exactly backwards for the z-score data this chart is mostly used on.
      parts.push(rect({ x: x, y: y, width: cellWidth, height: cellHeight, fill: colorRamp(position(value), ramp), stroke: '#ffffff', strokeWidth: 0.5 }));
    }
  }
  const labelSize = Math.max(6, Math.min(9, cellHeight * 0.55));
  const columnSize = Math.max(6, Math.min(9, cellWidth * 1.6));
  rows.forEach((label, index) => {
    const text = String(label);
    const trimmed = text.length > 14 ? `${text.slice(0, 13)}…` : text;
    parts.push(textRun({ x: plot.x - 5, y: plot.y + index * cellHeight + cellHeight / 2 + 3, text: trimmed, size: labelSize, anchor: 'end', fill: TICK_COLOR }));
  });
  columns.forEach((label, index) => {
    const text = String(label);
    const trimmed = text.length > 10 ? `${text.slice(0, 9)}…` : text;
    parts.push(textRun({ x: plot.x + index * cellWidth + cellWidth / 2, y: plot.y - 5, text: trimmed, size: columnSize, anchor: 'middle', fill: TICK_COLOR }));
  });
  // Colour bar, drawn cell-by-cell: a gradient element would not rasterize.
  // The max value sits at the TOP, so each step renders the ramp position that
  // corresponds to its own value — the bar and the cells must read the same way
  // round, and an earlier version flipped the bar alone (blue at the top of a
  // scale whose largest cell was red).
  const barHeight = Math.min(140, plot.height * 0.6);
  const barTop = plot.y;
  const steps = 48;
  for (let step = 0; step < steps; step++) {
    // Top of the bar is the MAX: position 1, whose colour is the ramp's high end.
    // Each step walks the position down to 0 at the bottom, so the bar and the
    // cells read the same way round.
    const positionOfStep = 1 - step / (steps - 1);
    parts.push(rect({
      x: barX,
      y: barTop + (barHeight / steps) * step,
      width: barWidth,
      height: barHeight / steps + 0.6,
      fill: colorRamp(positionOfStep, ramp),
    }));
  }
  parts.push(rect({ x: barX, y: barTop, width: barWidth, height: barHeight, fill: 'none', stroke: '#d0d7de', strokeWidth: 1 }));
  parts.push(textRun({ x: barX + barWidth + 3, y: barTop + 8, text: formatTick(max), size: 8, fill: TICK_COLOR }));
  parts.push(textRun({ x: barX + barWidth + 3, y: barTop + barHeight, text: formatTick(min), size: 8, fill: TICK_COLOR }));
  parts.push(textRun({ x: barX + barWidth + 3, y: barTop + 19, text: value_label, size: 8, fill: TICK_COLOR }));
  const note = `scale: ${scale}${scale === 'none' ? '' : ' (a display transform, not a statistic)'}`;
  parts.push(textRun({ x: plot.x, y: plot.y + plot.height + 14, text: note, size: 9, fill: TICK_COLOR }));
  const svg = finish(parts, { title, description: `heatmap of ${rows.length} rows by ${columns.length} columns`, xTitle: x_label, yTitle: y_label, plot });
  return {
    svg,
    stats: {
      rows: rows.length,
      columns: columns.length,
      cells,
      missing_cells: values.flat().filter((value) => value === null).length,
      min,
      max,
      scale,
      color_scale: ramp,
      scaled: scale !== 'none',
    },
    marks: cells,
    plot,
    // The grid is narrower than `plot` because the colour bar lives inside that
    // rectangle; a test (or a caller) that needs a cell's position must use
    // these rather than recomputing the layout.
    grid: { x: plot.x, y: plot.y, width: gridWidth, height: plot.height, cell_width: cellWidth, cell_height: cellHeight, bar_x: barX, bar_width: barWidth },
  };
}
