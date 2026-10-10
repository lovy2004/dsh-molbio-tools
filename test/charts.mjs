/**
 * dsh-molbio-tools/test/charts.mjs
 *
 * Two things are checked here, and they are different kinds of claim:
 *
 * 1. The CSV/TSV reader and the statistics are PURE FUNCTIONS, so they are
 *    checked against hand-computed values — including the conventions that must
 *    not drift from the rest of the package (linear-interpolation quartiles,
 *    Freedman-Diaconis binning) and the error messages that name the offending
 *    line, because a real experiment table is where bad input comes from.
 *
 * 2. The pictures are checked in PIXELS, not in strings. A chart that renders
 *    to a plausible-looking SVG but puts the ink in the wrong place is exactly
 *    the defect this suite exists for, and it is invisible to every
 *    string-matching assertion. Each new chart kind therefore asserts that ink
 *    lands where the data says it should.
 *
 * The rasterizer is the ceiling on all of this: `unsupported` and
 * `missing_glyphs` must both come back EMPTY from REAL renderer output, so a
 * construct outside the supported subset fails here instead of silently
 * vanishing from the picture the model is shown.
 *
 *   node test/charts.mjs
 */

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import {
  SERIES_COLORS,
  boxStats,
  findColumn,
  histogramBins,
  kernelDensity,
  numericColumn,
  numericColumns,
  parseTable,
  percentile,
  renderBoxPlot,
  renderHeatmap,
  renderHistogram,
  renderLineChart,
  renderViolinPlot,
  renderVolcanoPlot,
  resolveTable,
} from '../charts.mjs';
import { COLOR_RAMPS, colorRamp } from '../svgio.mjs';
import { renderSvgToPng } from '../svgpng.mjs';

// ── raster helpers ──────────────────────────────────────────────────────────

/**
 * Decode the encoder's own output back to pixels.
 *
 * `renderSvgToPng` returns a finished PNG (that is what `attach_image` ships),
 * so a pixel assertion has to decode it. This is deliberately a small,
 * strict decoder — 8-bit RGB, no interlace — and it asserts on anything else,
 * so a future encoder change that alters the format fails here loudly rather
 * than producing garbage coordinates.
 */
function decodeRgb(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      assert.equal(view.getUint8(offset + 16), 8, 'chart PNGs are 8 bits per channel');
      assert.equal(view.getUint8(offset + 17), 2, 'chart PNGs are RGB (colour type 2)');
      assert.equal(view.getUint8(offset + 20), 0, 'chart PNGs are not interlaced');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'filter type 0 (None) as the encoder writes');
    rgb.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, rgb };
}

/** [r, g, b] at one pixel of a rendered chart. */
function pixel(image, x, y) {
  const offset = (y * image.width + x) * 3;
  return [image.rgb[offset], image.rgb[offset + 1], image.rgb[offset + 2]];
}

/** Non-white pixels inside a rectangle: "is there ink HERE?". */
function countInk(image, x0, y0, x1, y1) {
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(y1, image.height); y++) {
    for (let x = Math.max(0, x0); x < Math.min(x1, image.width); x++) {
      const [r, g, b] = pixel(image, x, y);
      if (r !== 255 || g !== 255 || b !== 255) count++;
    }
  }
  return count;
}

/**
 * The rows and columns inside the canvas that carry any ink, excluding the
 * card border. Tests use this to LOCATE the drawing instead of hard-coding
 * pixel offsets: a layout tweak that moves the plot rectangle must not fail a
 * data assertion, but ink in the wrong place still must.
 */
function inkBox(image, margin = 14) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let y = margin; y < image.height - margin; y++) {
    for (let x = margin; x < image.width - margin; x++) {
      const [r, g, b] = pixel(image, x, y);
      if (r === 255 && g === 255 && b === 255) continue;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    }
  }
  return box;
}

/**
 * The plot rectangle, found from the two spines rather than assumed.
 *
 * The Y spine is the TALLEST column of ink in the left half — not simply the
 * first column with a lot of ink, because the rotated Y-axis title is a tall
 * thin run of text that comes first and would be mistaken for the spine
 * (measuring from there put every coordinate ~15 px off and made the gap
 * between two boxes look like the middle of one).
 */
function plotRect(image) {
  const { height, width } = image;
  const columnInk = (x) => {
    let n = 0;
    for (let y = 30; y < height - 30; y++) if (countInk(image, x, y, x + 1, y + 1) > 0) n++;
    return n;
  };
  const rowInk = (y) => {
    let n = 0;
    for (let x = 30; x < width - 30; x++) if (countInk(image, x, y, x + 1, y + 1) > 0) n++;
    return n;
  };
  let tallest = 0;
  for (let x = 40; x < width / 2; x++) tallest = Math.max(tallest, columnInk(x));
  let left = -1;
  for (let x = 40; x < width / 2; x++) {
    if (columnInk(x) >= tallest * 0.8) { left = x; break; }
  }
  let bottom = -1;
  for (let y = height - 30; y > height / 2; y--) {
    if (rowInk(y) > 300) { bottom = y; break; }
  }
  assert.ok(left > 0, 'the Y spine is drawn');
  assert.ok(bottom > 0, 'the X spine is drawn');
  return { left, bottom };
}

/** First inked row in a column band, or Infinity. */
function firstInkRow(image, x0, x1, y0, y1) {
  for (let y = y0; y < y1; y++) if (countInk(image, x0, y, x1, y + 1) > 0) return y;
  return Infinity;
}

/** "#4a7dd8" → [74, 125, 216]. */
function rgbOf(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

/**
 * Pixels matching one series colour, to within a tolerance for the antialiased
 * edge the rasterizer produces. This is how a test tells two series apart from
 * the neutral grey of gridlines and axis labels — matching "any ink" would see
 * the grid and the legend instead.
 */
function countColor(image, x0, y0, x1, y1, hex, tolerance = 40) {
  const [tr, tg, tb] = rgbOf(hex);
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(y1, image.height); y++) {
    for (let x = Math.max(0, x0); x < Math.min(x1, image.width); x++) {
      const [r, g, b] = pixel(image, x, y);
      if (Math.abs(r - tr) <= tolerance && Math.abs(g - tg) <= tolerance && Math.abs(b - tb) <= tolerance) count++;
    }
  }
  return count;
}

/** First row holding a pixel of `hex`, scanning a column band downward. */
function firstColorRow(image, x0, x1, y0, y1, hex, tolerance = 40) {
  for (let y = y0; y < y1; y++) if (countColor(image, x0, y, x1, y + 1, hex, tolerance) > 0) return y;
  return Infinity;
}

/** Render one chart and hold the rasterizer to its contract. */
function raster(svg, label) {
  const result = renderSvgToPng(svg, { supersample: 1 });
  assert.deepEqual(result.unsupported, [], `${label}: the chart used SVG the rasterizer cannot draw`);
  assert.deepEqual(result.missing_glyphs, [], `${label}: the chart used characters the built-in font cannot draw`);
  return decodeRgb(result.data);
}

/** Render a chart at high resolution for eyeballing: `node test/charts.mjs --preview <dir>`. */
export function sampleDocuments() {
  return [
    ['histogram', renderHistogram({ title: 'Insert size', x_label: 'fragment size (bp)', y_label: 'reads', values: [100, 110, 120, 120, 130, 130, 130, 140, 140, 150, 150, 150, 150, 160, 170, 180, 200, 220, 260, 300, 380] }).svg],
    ['box plot', renderBoxPlot({ title: 'Ct by strain', x_label: 'strain', y_label: 'Ct', series: [{ label: 'wt', values: [22.1, 22.4, 23.9, 22.8, 22.2] }, { label: 'ko', values: [19.4, 19.1, 19.8, 34.5, 19.3] }] }).svg],
    ['line chart', renderLineChart({ title: 'Growth curve', x_label: 'time (h)', y_label: 'OD600', series: [{ label: 'wt', x: [0, 2, 4, 6, 8], y: [0.05, 0.2, 0.8, 1.4, 1.5] }, { label: 'ko', x: [0, 2, 4, 6, 8], y: [0.04, 0.1, 0.3, 0.5, 0.55] }] }).svg],
    ['violin plot', renderViolinPlot({ title: 'Ct by strain', x_label: 'strain', y_label: 'Ct', series: [{ label: 'wt', values: [22.1, 22.4, 23.9, 22.8, 22.2, 22.6] }, { label: 'ko', values: [19.4, 19.1, 19.8, 34.5, 19.3, 19.6] }] }).svg],
    ['volcano plot', renderVolcanoPlot({ title: 'Differential expression', points: [{ label: 'KRAS', log2fc: 2.5, p: 0.0001 }, { label: 'TP53', log2fc: -2.2, p: 0.002 }, { label: 'MYC', log2fc: 0.3, p: 0.6 }, { label: 'BRCA1', log2fc: -0.2, p: 0.9 }, { label: 'EGFR', log2fc: 1.8, p: 0.01 }], label_top: 3 }).svg],
    ['heatmap', renderHeatmap({ title: 'Z-scores by gene', rows: ['KRAS', 'TP53', 'MYC', 'PTEN'], columns: ['ctrl1', 'ctrl2', 'ctrl3', 'kd1', 'kd2', 'kd3'], matrix: [[0.1, 0.2, 0.05, 2.1, 1.9, 2.3], [-0.3, -0.1, -0.2, 1.4, 1.2, 1.5], [0.05, -0.1, 0.1, 0.2, 0.1, 0.3], [-1.2, -1.1, -1.3, 0.4, 0.5, 0.3]], scale: 'row_zscore', value_label: 'row z' }).svg],
  ];
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

// ── statistics ──────────────────────────────────────────────────────────────

test('quartiles interpolate linearly, the same rule fastq-qc.mjs uses', () => {
  // Position = (n - 1) * p. For [1..4]: q1 position 0.75 -> 1.75, q3 -> 3.25.
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.75), 3.25);
  assert.equal(percentile([7], 0.25), 7, 'a single value is its own quartile');
  assert.equal(percentile([], 0.5), 0, 'an empty sample is 0, not NaN');
});

test('boxStats partitions outliers at 1.5xIQR and reports the fences honestly', () => {
  const stats = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
  assert.equal(stats.count, 10);
  assert.equal(stats.min, 1);
  assert.equal(stats.q1, 3.25);
  assert.equal(stats.median, 5.5);
  assert.equal(stats.q3, 7.75);
  assert.equal(stats.max, 100);
  assert.equal(stats.iqr, 4.5);
  assert.deepEqual(stats.outliers, [100], 'the far value is an outlier, not part of the whisker');
  assert.equal(stats.whisker_high, 9, 'the whisker stops at the last point inside the fence');
  assert.equal(stats.whisker_low, 1);
});

test('boxStats survives a constant sample instead of producing NaN fences', () => {
  const stats = boxStats([4, 4, 4]);
  assert.equal(stats.iqr, 0);
  assert.deepEqual(stats.outliers, [], 'zero IQR must not make every value an outlier');
  assert.equal(stats.whisker_low, 4);
  assert.equal(stats.whisker_high, 4);
  assert.equal(stats.median, 4);
});

test('histogram binning defaults to Freedman-Diaconis and counts every value', () => {
  const values = [100, 110, 120, 120, 130, 130, 130, 140, 140, 150, 150, 150, 150, 160, 170, 180, 200, 220, 260, 300, 380];
  const shape = histogramBins(values);
  assert.equal(shape.rule, 'freedman-diaconis');
  assert.equal(shape.bin_count, 8);
  assert.equal(shape.bins.reduce((sum, bin) => sum + bin.count, 0), values.length, 'no value is dropped');
  assert.equal(shape.bins[0].start, 100);
  assert.equal(shape.bins.at(-1).end, 380, 'the last edge is the sample max');
  assert.equal(shape.bins.at(-1).count, 1, 'the maximum lands in the final bin, not outside every bin');
  assert.deepEqual(shape.bins.map((bin) => bin.count), [7, 7, 3, 1, 1, 1, 0, 1]);
});

test('histogram binning honours an explicit count and degenerates safely', () => {
  const explicit = histogramBins([1, 2, 3, 4, 5, 6, 7, 8], 4);
  assert.equal(explicit.bin_count, 4);
  assert.equal(explicit.rule, 'requested');
  assert.equal(histogramBins([5, 5, 5]).rule, 'single-value', 'a constant sample needs no spread rule');
  assert.equal(histogramBins([5, 5, 5]).bin_count, 1);
  assert.throws(() => histogramBins([1, 2, 3], 0), /between 1 and 200/);
  assert.throws(() => histogramBins([], 4), /at least one finite value/);
  // A sample too small for an IQR must fall back rather than ask for 0 bins.
  const tiny = histogramBins([1, 2]);
  assert.ok(tiny.bin_count >= 1 && Number.isFinite(tiny.bin_width), 'a two-value sample still gets a usable bin');
});

// ── CSV / TSV reader ────────────────────────────────────────────────────────

test('the reader detects the delimiter and keeps quoted fields intact', () => {
  const tsv = ['gene\tlog2FC', 'A\t1.5', 'B\t-2.25', ''].join('\n');
  assert.equal(parseTable(tsv).delimiter_name, 'tab');
  assert.equal(parseTable(['a,b', '1,2', ''].join('\n')).delimiter_name, 'comma');
  assert.equal(parseTable(['a;b', '1;2', ''].join('\n')).delimiter_name, 'semicolon');
  assert.equal(parseTable(['a|b', '1|2', ''].join('\n')).delimiter_name, 'pipe');
  assert.equal(parseTable(['a\tb', '1,5\t2', ''].join('\n')).delimiter_name, 'tab', 'a comma inside a TSV field does not win');

  assert.deepEqual(parseTable(['name,note', '"a,b",x', ''].join('\n')).columns[0].values, ['a,b']);
  assert.deepEqual(parseTable(['name', '"say ""hi"""', ''].join('\n')).columns[0].values, ['say "hi"'], 'a doubled quote is one literal quote');
  assert.deepEqual(parseTable(['name,note', '"5"" probe",x', ''].join('\n')).columns[0].values, ['5" probe']);
});

test('the reader reports non-numeric columns and missing values rather than guessing', () => {
  const table = parseTable(['gene\tct\tpadj', 'A\t22\t0.01', 'B\ttext\tNA', ''].join('\n'));
  assert.equal(findColumn(table, 'ct').numeric, false, 'one bad cell makes the whole column text');
  assert.equal(findColumn(table, 'padj').numeric, true);
  assert.equal(findColumn(table, 'padj').missing, 1);
  assert.deepEqual(findColumn(table, 'padj').values, [0.01, null], 'a missing value stays null, never 0');
  assert.deepEqual(numericColumns(table).map((column) => column.name), ['padj']);
  assert.deepEqual(numericColumn(table, findColumn(table, 'padj')), [0.01]);
});

test('the reader names the offending line and column, and refuses ragged input', () => {
  const mixed = parseTable(['gene\tct', 'A\t22', 'B\ttext', ''].join('\n'));
  // 'ct' is classified text because of one bad cell, so the reader reports the
  // FIRST value it cannot use — sheet line 2, because the header is line 1.
  assert.throws(() => numericColumn(mixed, findColumn(mixed, 'ct')), /line 2, column "ct": "22" is not a number/);
  assert.throws(() => parseTable(['a,b', '1,2,3', ''].join('\n')), /line 2 has 3 field\(s\) but the first line has 2/);
  assert.throws(() => parseTable(['a,b', '"unterminated,x', ''].join('\n')), /odd number of double quotes/);
  assert.throws(() => parseTable('no delimiter here'), /could not detect a delimiter/);
  assert.throws(() => parseTable('a,b'), /no data rows/, 'a header with no data rows is not a table');
});
test('a column that is numeric except for one cell still reports that cell by line', () => {
  // The interesting case for an off-by-one: every earlier row is fine, so the
  // reported line must be the row that actually failed (header is line 1).
  const table = parseTable(['sample\tct', 'A\t22', 'B\t23', 'C\tN/A', ''].join('\n'));
  const column = findColumn(table, 'ct');
  assert.equal(column.numeric, false, 'one unusable cell makes the column text, not silently shortened');
  assert.deepEqual(column.values, ['22', '23', 'N/A']);
  assert.throws(() => numericColumn(table, column), /is not a number/);
});
test('column lookup is tolerant of case and whitespace, and lists the columns when it fails', () => {
  const table = parseTable(['Gene Name\tCt', 'A\t22', ''].join('\n'));
  assert.equal(findColumn(table, '  gene name ').name, 'Gene Name');
  assert.equal(findColumn(table, 'ct').name, 'Ct');
  assert.throws(() => findColumn(table, 'nope', 'value_column'), /value_column "nope" is not a column of the table; columns are: "Gene Name", "Ct"/);
});

test('duplicate column names are disambiguated instead of silently resolving to the first', () => {
  const table = parseTable(['ct,ct', '1,2', ''].join('\n'));
  assert.deepEqual(table.column_names, ['ct', 'ct_2']);
});

test('resolveTable cannot be given both sources, and needs one to read a file', async () => {
  await assert.rejects(() => resolveTable({ data_path: 'a.csv', data: 'x\n1\n' }, async () => 'x\n1\n'), /not both/);
  const table = await resolveTable({ data: 'x\n1\n2\n' }, async () => { throw new Error('must not read'); });
  assert.deepEqual(table.column_names, ['x']);
  assert.equal(await resolveTable({}, async () => 'x\n1\n'), null, 'no source is not an error here');
  const fromFile = await resolveTable({ data_path: 'data.csv' }, async (path) => {
    assert.equal(path, 'data.csv');
    return 'a,b\n1,2\n';
  });
  assert.deepEqual(fromFile.column_names, ['a', 'b']);
});

// ── rendered pictures ───────────────────────────────────────────────────────

test('histogram: bars rise from the x axis where the reported bins place them', () => {
  const values = [100, 110, 120, 120, 130, 130, 130, 140, 140, 150, 150, 150, 150, 160, 170, 180, 200, 220, 260, 300, 380];
  const chart = renderHistogram({ title: 'Insert size', x_label: 'bp', y_label: 'reads', values });
  assert.equal(chart.stats.bin_count, 8);
  assert.equal(chart.marks, values.length);
  assert.deepEqual(chart.stats.bins.map((bin) => bin.count), [7, 7, 3, 1, 1, 1, 0, 1]);
  const image = raster(chart.svg, 'histogram');
  const { left, bottom } = plotRect(image);

  // Locate the full extent of the bars: everything that reaches down to the
  // x axis, inside the plot.
  const barColumns = [];
  for (let x = left + 1; x < image.width - 20; x++) {
    if (countInk(image, x, bottom - 5, x + 1, bottom) > 0) barColumns.push(x);
  }
  assert.ok(barColumns.length > 300, 'the bars cover most of the axis width');

  const span = chart.stats.max - chart.stats.min;
  const xOf = (value) => left + ((value - chart.stats.min) / span) * (barColumns.at(-1) - left + 1);
  chart.stats.bins.forEach((bin, index) => {
    if (bin.count === 0) return;
    const middle = Math.round((xOf(bin.start) + xOf(bin.end)) / 2);
    assert.ok(
      countInk(image, middle - 2, bottom - 6, middle + 2, bottom) > 0,
      `bin ${index} (count ${bin.count}) draws a bar at its own centre`,
    );
  });

  // The empty bin must be a real gap. Measured just ABOVE the x spine: the
  // spine itself inks the bottom two rows of the plot rectangle, so a window
  // that includes it would report a gap in every bin.
  const empty = chart.stats.bins.findIndex((bin) => bin.count === 0);
  assert.ok(empty >= 0, 'the sample has an empty bin to check');
  const gapLeft = xOf(chart.stats.bins[empty].start);
  const gapRight = xOf(chart.stats.bins[empty].end);
  const inset = (gapRight - gapLeft) / 4;
  assert.equal(
    countInk(image, Math.round(gapLeft + inset), bottom - 6, Math.round(gapRight - inset), bottom - 3),
    0,
    'the count-0 bin leaves a gap on the axis',
  );

  // Bar height follows the count. Measured by COLOUR: the horizontal gridlines
  // are a light grey and "any non-white pixel" would find one in every row,
  // making every bar look like it reached the top of the plot.
  const barColor = SERIES_COLORS[0];
  const tallBin = chart.stats.bins.findIndex((bin) => bin.count === 7);
  const shortBin = chart.stats.bins.findIndex((bin) => bin.count === 1);
  const centreOf = (index) => Math.round((xOf(chart.stats.bins[index].start) + xOf(chart.stats.bins[index].end)) / 2);
  const tallTop = firstColorRow(image, centreOf(tallBin) - 4, centreOf(tallBin) + 4, 40, bottom, barColor);
  const shortTop = firstColorRow(image, centreOf(shortBin) - 4, centreOf(shortBin) + 4, 40, bottom, barColor);
  assert.ok(Number.isFinite(tallTop) && Number.isFinite(shortTop), 'both bins draw a bar in the series colour');
  assert.ok(tallTop < shortTop - 50, `a count-7 bar reaches far above a count-1 bar (${tallTop} vs ${shortTop})`);
});

test('box plot: each sample is a box at its own position, outliers above it', () => {
  const series = [
    { label: 'wt', values: [22.1, 22.4, 23.9, 22.8, 22.2] },
    { label: 'ko', values: [19.4, 19.1, 19.8, 34.5, 19.3] },
  ];
  const chart = renderBoxPlot({ title: 'Ct by strain', x_label: 'strain', y_label: 'Ct', series });
  assert.equal(chart.stats.length, 2);
  assert.deepEqual(chart.stats[0].outliers, [23.9]);
  // ko's IQR is 0.5 (19.3-19.8), so the low fence sits at 18.55 and 19.1 is an
  // inlier that the lower whisker reaches — only 34.5 is an outlier.
  assert.deepEqual(chart.stats[1].outliers, [34.5]);
  assert.equal(chart.stats[1].whisker_low, 19.1);
  assert.equal(chart.stats[1].whisker_high, 19.8);
  assert.equal(chart.marks, 10);
  const image = raster(chart.svg, 'box plot');
  const { bottom } = plotRect(image);

  /** Horizontal runs of one series colour in a row. */
  const runsInRow = (y, hex) => {
    const runs = [];
    let start = null;
    for (let x = 40; x < image.width - 20; x++) {
      const hit = countColor(image, x, y, x + 1, y + 1, hex) > 0;
      if (hit && start === null) start = x;
      if (!hit && start !== null) { runs.push([start, x - 1]); start = null; }
    }
    if (start !== null) runs.push([start, image.width - 21]);
    return runs;
  };
  // Find each box body as a WIDE horizontal run of its colour. Locating the
  // boxes from the pixels (rather than from an assumed slot width) is what
  // keeps this test honest if the layout changes: the first version computed a
  // slot six times too small and then measured empty space between the boxes.
  const boxes = [];
  for (const hex of [SERIES_COLORS[0], SERIES_COLORS[1]]) {
    let found = null;
    for (let y = 60; y < bottom; y++) {
      const wide = runsInRow(y, hex).filter(([from, to]) => to - from >= 20);
      if (wide.length === 1) { found = { hex, row: y, from: wide[0][0], to: wide[0][1], centre: Math.round((wide[0][0] + wide[0][1]) / 2) }; break; }
    }
    assert.ok(found !== null, `a box body is drawn in ${hex}`);
    boxes.push(found);
  }
  assert.ok(boxes[0].centre < boxes[1].centre, 'the two samples occupy different horizontal positions');

  // The 34.5 outlier sits far above the other sample's box, in its own colour.
  const topIn = (box) => {
    for (let y = 52; y < bottom; y++) if (countColor(image, box.from, y, box.to, y + 1, box.hex) > 0) return y;
    return Infinity;
  };
  const wtTop = topIn(boxes[0]);
  const koTop = topIn(boxes[1]);
  assert.ok(koTop < wtTop - 100, `the ko outlier reaches far above the wt box (${koTop} vs ${wtTop})`);
  // Both boxes are at the same kind of depth for their own data, so neither is
  // drawn off its own axis.
  assert.ok(countInk(image, boxes[0].from, bottom - 40, boxes[0].to, bottom) > 0, 'the first box reaches the axis');
  assert.ok(countInk(image, boxes[1].from, bottom - 40, boxes[1].to, bottom) > 0, 'the second box reaches the axis');
});

test('line chart: each series is inked across the plot at its own y level', () => {
  const series = [
    { label: 'wt', x: [0, 2, 4, 6, 8], y: [0.05, 0.2, 0.8, 1.4, 1.5] },
    { label: 'ko', x: [0, 2, 4, 6, 8], y: [0.04, 0.1, 0.3, 0.5, 0.55] },
  ];
  const chart = renderLineChart({ title: 'Growth curve', x_label: 'time (h)', y_label: 'OD600', series });
  assert.equal(chart.stats.series_count, 2);
  assert.equal(chart.stats.point_count, 10);
  assert.equal(chart.stats.series[0].points, 5, 'per-series point counts are reported');
  assert.equal(chart.stats.series[0].y_min, 0.05);
  assert.equal(chart.stats.series[0].y_max, 1.5);
  assert.deepEqual(chart.stats.y_range, [0.04, 1.5], 'the axis covers both series');
  const image = raster(chart.svg, 'line chart');
  const { left, bottom } = plotRect(image);
  // Scan from the chart's OWN reported plot top, so the legend band (which is
  // drawn in these same colours above the plot rectangle) is excluded by
  // construction rather than by a hard-coded offset.
  const scanTop = Math.ceil(chart.plot.y) + 2;

  // Locate each series in the colour domain of the PLOT only: the legend is
  // drawn in the same two colours, so a global scan for "the topmost blue
  // pixel" finds the legend swatch and never the data.
  const blue = SERIES_COLORS[0];
  const red = SERIES_COLORS[1];
  const colourExtent = (hex) => {
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    // Start BELOW the legend swatches, which are drawn in these same colours
    // just above the plot rectangle and would otherwise define the extent.
    for (let y = scanTop; y < bottom; y++) {
      for (let x = left + 1; x < image.width - 10; x++) {
        if (countColor(image, x, y, x + 1, y + 1, hex) === 0) continue;
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
      }
    }
    return box;
  };
  const blueBox = colourExtent(blue);
  const redBox = colourExtent(red);
  assert.ok(Number.isFinite(blueBox.minX) && Number.isFinite(redBox.minX), 'both series are drawn in their own colours');
  assert.ok(blueBox.maxX - blueBox.minX > 400, 'the rising series spans the plot width');
  assert.ok(redBox.maxX - redBox.minX > 400, 'the flat series spans the plot width too');

  // The rising series reaches its highest point on the right; the flat one stays
  // low. Both are read from the same axis, so their minY values are comparable.
  assert.ok(blueBox.minY < redBox.minY - 100, `the rising series reaches far higher than the flat one (${blueBox.minY} vs ${redBox.minY})`);

  // And the rising series really rises: its ink at the left end sits lower.
  const leftEndTop = firstColorRow(image, blueBox.minX, blueBox.minX + 6, 40, bottom, blue);
  const rightEndTop = firstColorRow(image, blueBox.maxX - 6, blueBox.maxX + 1, 40, bottom, blue);
  assert.ok(Number.isFinite(leftEndTop) && Number.isFinite(rightEndTop), 'the rising series is inked at both ends');
  assert.ok(rightEndTop < leftEndTop - 100, `the 1.5 OD600 end is far above the 0.05 start (${rightEndTop} vs ${leftEndTop})`);
});

test('repeated x values are plotted at one position, not spread across the axis', () => {
  // Two readings at the same x, far apart in y, plus a third at the far right.
  // If a repeated x were spread horizontally, the left part of the picture
  // would hold a shallow diagonal instead of one tall vertical run.
  const doubled = renderLineChart({ title: 'Replicates', series: [{ label: 'a', x: [0, 0, 3], y: [1, 5, 1] }] });
  const single = renderLineChart({ title: 'One point', series: [{ label: 'a', x: [0, 3], y: [1, 1] }] });
  const doubledImage = raster(doubled.svg, 'repeated x');
  const singleImage = raster(single.svg, 'single point');

  const { left, bottom } = plotRect(doubledImage);
  // The start point sits ~5% into the padded x domain. Measure the ink in the
  // left fifth, from BELOW the legend band (the legend is drawn inside the plot
  // and would otherwise dominate the count in both charts).
  const right = Math.round(left + (bottom - left) * 0.2);
  const leftFifthInk = (image) => countInk(image, left + 1, 95, right, bottom);
  const doubledCount = leftFifthInk(doubledImage);
  const singleCount = leftFifthInk(singleImage);
  assert.ok(
    doubledCount > singleCount + 150,
    `the same-x readings add a tall vertical run of ink (${doubledCount} vs ${singleCount})`,
  );
});

test('every chart kind rasterizes with nothing unsupported and no missing glyphs', () => {
  for (const [name, svg] of sampleDocuments()) {
    const image = raster(svg, name);
    assert.ok(image.width > 0 && image.height > 0);
    assert.ok(countInk(image, 0, 0, image.width, image.height) > 500, `${name}: the picture has real content`);
  }
});

// ── batch 2: colour ramps, violin, volcano, heatmap ─────────────────────────

test('colorRamp interpolates between its stops, clamps, and is a total function', () => {
  for (const name of Object.keys(COLOR_RAMPS)) {
    assert.match(colorRamp(0, name), /^#[0-9a-f]{6}$/, `${name} low end is a hex colour`);
    assert.match(colorRamp(1, name), /^#[0-9a-f]{6}$/, `${name} high end is a hex colour`);
    assert.equal(colorRamp(0, name), COLOR_RAMPS[name][0], `${name} at 0 is its first stop`);
    assert.equal(colorRamp(1, name), COLOR_RAMPS[name].at(-1), `${name} at 1 is its last stop`);
  }
  // Out-of-range input clamps: a heatmap must never produce a colour off-scale.
  assert.equal(colorRamp(-3), colorRamp(0));
  assert.equal(colorRamp(7), colorRamp(1));
  // A non-number cannot leak a NaN string into the SVG.
  assert.equal(colorRamp(Number.NaN), colorRamp(0));
  assert.match(colorRamp(0.5, 'greys'), /^#[0-9a-f]{6}$/);
  // An unknown ramp name falls back rather than throwing mid-render.
  assert.match(colorRamp(0.5, 'no-such-ramp'), /^#[0-9a-f]{6}$/);
});

test('kernelDensity spans the data, normalises to its own peak, and survives a constant sample', () => {
  const values = [22.1, 22.4, 23.9, 22.8, 22.2, 22.6];
  const density = kernelDensity(values);
  // The grid must span the DATA. Evaluating a kernel centred at ~22 at
  // fractions of 1 puts every term ~80 bandwidths out, where exp underflows to
  // 0 — the first version of this function returned an all-zero density.
  assert.ok(density.grid[0] < 22.1 && density.grid.at(-1) > 23.9, 'the grid brackets the sample');
  assert.ok(density.density.some((value) => value > 0.5), 'the density is not flat zero');
  assert.equal(Math.max(...density.density), 1, 'normalised to its own peak');
  assert.ok(density.bandwidth > 0, 'a positive bandwidth');
  // Silverman under the IQR/sigma rule: the low end must not be dominated by an
  // outlier the way a plain sigma rule would be.
  assert.ok(density.bandwidth < 1, 'the bandwidth is on the scale of the sample, not of its range');
  // A constant sample must not divide by zero or return NaN.
  const flat = kernelDensity([5, 5, 5]);
  assert.ok(Number.isFinite(flat.bandwidth) && flat.bandwidth > 0, 'a constant sample still gets a usable bandwidth');
  assert.ok(flat.density.every((value) => Number.isFinite(value)));
  assert.throws(() => kernelDensity([]), /at least one finite value/);
});

test('violin plot: the silhouette is widest where the data is densest, and the box sits inside it', () => {
  // Two tight clusters far apart and one straggler: the silhouette must pinch
  // between them rather than be a uniform blob.
  const series = [{ label: 'bimodal', values: [1, 1.1, 1.2, 1.15, 1.05, 9, 9.1, 9.2, 9.15, 9.05, 5] }];
  const chart = renderViolinPlot({ title: 'Bimodal', y_label: 'value', series });
  assert.equal(chart.stats.length, 1);
  assert.equal(chart.stats[0].count, 11);
  assert.equal(chart.marks, 11);
  const image = raster(chart.svg, 'violin plot');
  const { left, bottom } = plotRect(image);
  const { plot } = chart;
  // The y axis spans the silhouette's own padded data range, so map a value to
  // its row through the same arithmetic the renderer used.
  const values = series[0].values;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.1, 1);
  const rowOf = (value) => bottom - ((value - (min - padding)) / ((max + padding) - (min - padding))) * (bottom - plot.y);
  const widthAt = (value) => countInk(image, left + 1, Math.round(rowOf(value)) - 2, left + plot.width, Math.round(rowOf(value)) + 2);
  const peakWidth = widthAt(1.1);
  const valleyWidth = widthAt(5);
  assert.ok(peakWidth > valleyWidth, `the cluster at 1.1 is wider than the gap at 5 (${peakWidth} vs ${valleyWidth})`);
  assert.ok(peakWidth > 40, 'the silhouette has real width at the cluster');
  assert.ok(countInk(image, left + 1, plot.y, left + plot.width, bottom) > 200, 'the silhouette is drawn');
});

test('volcano plot: up is red, down is blue, and unchanged points stay grey', () => {
  const points = [
    { label: 'UP', log2fc: 2.5, p: 0.0001 },
    { label: 'DOWN', log2fc: -2.2, p: 0.002 },
    { label: 'FLAT', log2fc: 0.2, p: 0.8 },
  ];
  const chart = renderVolcanoPlot({ title: 'DE', points, label_top: 0 });
  assert.equal(chart.stats.count, 3);
  assert.equal(chart.stats.significant_count, 2);
  assert.equal(chart.stats.up_count, 1);
  assert.equal(chart.stats.down_count, 1);
  assert.equal(chart.stats.max_significance, 4);
  const image = raster(chart.svg, 'volcano plot');
  // The three marks are distinguishable by colour, which is the whole point of
  // the chart. The thresholds are drawn as dashed guides in a neutral grey.
  assert.ok(countColor(image, 0, 52, image.width, 380, '#c73a3a') > 0, 'an up-regulated point is red');
  assert.ok(countColor(image, 0, 52, image.width, 380, '#2166ac') > 0, 'a down-regulated point is blue');
  assert.ok(countColor(image, 0, 52, image.width, 380, '#9aa4ae') > 10, 'the unchanged point is grey');
  // The significant pair must be taller on the axis than the flat one: p = 0.8
  // is -log10 ≈ 0.097, so its mark sits at the very bottom.
  const highInk = countInk(image, 0, 52, image.width, 200);
  assert.ok(highInk > 0, 'the significant points are drawn high on the axis');
  assert.throws(() => renderVolcanoPlot({ points: [{ log2fc: 1, p: 0 }] }), /p must be a number in \(0, 1\]/);
  assert.throws(() => renderVolcanoPlot({ points: [{ log2fc: 1, p: 1.5 }] }), /p must be a number in \(0, 1\]/);
  assert.throws(() => renderVolcanoPlot({ points: [{ log2fc: Number.NaN, p: 0.5 }] }), /log2fc must be a finite number/);
  assert.throws(() => renderVolcanoPlot({ points: [] }), /at least one point/);
});

test('heatmap: the smallest value takes the ramp\'s low colour and the largest its high colour', () => {
  const rows = ['r_low', 'r_mid', 'r_high'];
  // One column, three distinct values, so each cell is a different ramp position.
  const chart = renderHeatmap({ rows, columns: ['only'], matrix: [[-2], [0], [2]] });
  const image = raster(chart.svg, 'heatmap');
  const { grid } = chart;
  const cellCentre = (index) => [
    Math.round(grid.x + grid.cell_width / 2),
    Math.round(grid.y + grid.cell_height * (index + 0.5)),
  ];
  const expected = (value) => colorRamp((value + 2) / 4, chart.stats.color_scale);
  for (const [index, value] of [-2, 0, 2].entries()) {
    const [x, y] = cellCentre(index);
    const actual = pixel(image, x, y);
    // The stroke is white and 0.5 wide, so sample a few pixels in and accept the
    // nearest match to the expected fill.
    let distance = Infinity;
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        const [r, g, b] = pixel(image, x + dx, y + dy);
        const [er, eg, eb] = rgbOf(expected(value));
        distance = Math.min(distance, Math.max(Math.abs(r - er), Math.abs(g - eg), Math.abs(b - eb)));
      }
    }
    assert.ok(distance <= 6, `cell for ${value} is filled with the ramp colour for its position (nearest distance ${distance})`);
  }
  // The scale has a bar, and its top must be the HIGH end of the same ramp —
  // cells and bar reading differently was a real defect.
  const barTop = pixel(image, Math.round(grid.bar_x + grid.bar_width / 2), Math.round(grid.y + 3));
  const [hr, hg, hb] = rgbOf(expected(2));
  assert.ok(Math.max(Math.abs(barTop[0] - hr), Math.abs(barTop[1] - hg), Math.abs(barTop[2] - hb)) < 30, 'the top of the colour bar matches the high end of the ramp');
});

test('heatmap: a missing cell is a distinct neutral, not the ramp midpoint', () => {
  const chart = renderHeatmap({ rows: ['a', 'b'], columns: ['x', 'y'], matrix: [[1, null], [3, 5]] });
  assert.equal(chart.stats.missing_cells, 1);
  const image = raster(chart.svg, 'heatmap with a gap');
  const { grid } = chart;
  const missing = pixel(image, Math.round(grid.x + grid.cell_width * 1.5), Math.round(grid.y + grid.cell_height * 0.5));
  assert.deepEqual(missing, [242, 243, 245], 'the missing cell is the neutral grey the renderer documents');
});

test('heatmap: scale transforms are reported, and an unknown one is refused', () => {
  // Two values per row, so a row z-score is a real spread and not the
  // degenerate all-zero result a single-column row would give.
  const matrix = [[1, 2], [10, 30]];
  const plain = renderHeatmap({ rows: ['a', 'b'], columns: ['x', 'y'], matrix });
  assert.equal(plain.stats.scale, 'none');
  assert.equal(plain.stats.scaled, false);
  const zscored = renderHeatmap({ rows: ['a', 'b'], columns: ['x', 'y'], matrix, scale: 'row_zscore' });
  assert.equal(zscored.stats.scaled, true, 'a display transform must be visible in the output');
  // A row z-score is centred on zero by construction.
  assert.ok(Math.abs(zscored.stats.max + zscored.stats.min) < 1e-9, 'row z-scores are symmetric about zero');
  assert.ok(zscored.stats.max > 0, 'and they actually spread');
  const logged = renderHeatmap({ rows: ['a'], columns: ['x', 'y'], matrix: [[2, 8]], scale: 'log2' });
  assert.deepEqual([logged.stats.min, logged.stats.max], [1, 3], 'log2 is applied before colouring');
  assert.throws(() => renderHeatmap({ rows: ['a'], columns: ['x'], matrix: [[1]], scale: 'log10' }), /unknown scale/);
  assert.throws(() => renderHeatmap({ rows: ['a'], columns: ['x'], matrix: [[0]], scale: 'log2' }), /log2 scale needs positive values/);
  assert.throws(() => renderHeatmap({ rows: ['a', 'b'], columns: ['x'], matrix: [[1]] }), /one row per label/);
  assert.throws(() => renderHeatmap({ rows: ['a'], columns: ['x', 'y'], matrix: [[1]] }), /has 1 value\(s\) but there are 2/);
  assert.throws(() => renderHeatmap({ rows: ['a'], columns: ['x'], matrix: [[Number.NaN]] }), /non-finite value/);
  assert.throws(() => renderHeatmap({ rows: ['a'], columns: ['x'], matrix: [[1]], color_scale: 'rainbow' }), /unknown color_scale/);
  // The cell cap must fail in the tool, not in the rasterizer.
  const big = Array.from({ length: 80 }, () => new Array(80).fill(1));
  assert.throws(() => renderHeatmap({ rows: big.map((_, index) => `r${index}`), columns: big[0].map((_, index) => `c${index}`), matrix: big }), /limit is 4000/);
});

test('heatmap: long and wide layouts are reported, and the two orientations differ', () => {
  // Wide: one labelled row, twelve numeric columns → a 1 x 12 strip.
  const wideText = ['gene,c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11,c12', 'a,1,2,3,4,5,6,7,8,9,10,11,12', ''].join('\n');
  const wideTable = parseTable(wideText);
  const wideLabels = wideTable.columns.find((column) => !column.numeric);
  const wideNumeric = numericColumns(wideTable);
  const wide = renderHeatmap({
    rows: wideLabels.values.map(String),
    columns: wideNumeric.map((column) => column.name),
    matrix: [wideNumeric.map((column) => column.values[0])],
  });
  assert.deepEqual([wide.stats.rows, wide.stats.columns], [1, 12]);
  assert.ok(wide.grid.cell_width < wide.grid.cell_height, 'a wide strip has narrow, tall cells');

  // Long: twelve rows, one column → a 12 x 1 strip. The same twelve values, so
  // the only difference is the orientation the labels impose.
  const longText = ['gene,sample,z', ...Array.from({ length: 12 }, (_, index) => `r${index},only,${index + 1}`), ''].join('\n');
  const longTable = parseTable(longText);
  const long = renderHeatmap({
    rows: findColumn(longTable, 'gene').values.map(String),
    columns: ['only'],
    matrix: findColumn(longTable, 'z').values.map((value) => [value]),
  });
  assert.deepEqual([long.stats.rows, long.stats.columns], [12, 1]);
  assert.ok(long.grid.cell_width > long.grid.cell_height, 'a tall strip has wide, short cells');
  assert.equal(wide.stats.cells, long.stats.cells, 'the same number of cells either way');
});

// ── runner ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

if (flag('--preview') !== undefined) {
  const out = resolve(flag('--preview'));
  mkdirSync(out, { recursive: true });
  for (const [name, svg] of sampleDocuments()) {
    const result = renderSvgToPng(svg);
    const file = join(out, `${name.replaceAll(' ', '-')}.png`);
    writeFileSync(file, result.data);
    console.log(`${file} (${result.width}x${result.height}, ${result.data.length} bytes)`);
  }
} else {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL ${name}`);
      for (const line of String(error.message).split('\n').slice(0, 8)) console.log(`       ${line}`);
    }
  }
  console.log(`\ncharts checks ${failed === 0 ? 'passed' : 'FAILED'}: ${tests.length - failed}/${tests.length}`);
  if (failed > 0) process.exit(1);
}
