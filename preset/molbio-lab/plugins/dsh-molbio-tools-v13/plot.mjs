/**
 * dsh-molbio-tools/plot.mjs
 *
 * Deterministic SVG charts: bar chart with optional error bars (mean ± SD)
 * and scatter plot with optional linear fit. Pure string generation, written
 * to workspace files by the tools.
 */

import { MolbioInputError } from './lib.mjs';

/** Least-squares linear fit: y = intercept + slope·x. */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) throw new MolbioInputError('a linear fit needs at least 2 points');
  const xMean = xs.reduce((sum, v) => sum + v, 0) / n;
  const yMean = ys.reduce((sum, v) => sum + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - xMean) ** 2;
    sxy += (xs[i] - xMean) * (ys[i] - yMean);
    syy += (ys[i] - yMean) ** 2;
  }
  if (sxx === 0) throw new MolbioInputError('cannot fit a line: all x values are equal');
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const rSquared = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r_squared: rSquared };
}

const WIDTH = 720;
const HEIGHT = 440;
const MARGIN = { top: 64, right: 30, bottom: 62, left: 72 };

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function niceStep(range, targetTicks = 5) {
  const raw = range / targetTicks;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const factor of [1, 2, 5, 10]) {
    if (raw <= power * factor) return power * factor;
  }
  return power * 10;
}

function validateNumbers(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new MolbioInputError(`${label} must be a non-empty array`);
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new MolbioInputError(`${label} contains a non-finite value: ${JSON.stringify(value)}`);
  }
  return values;
}

function frameParts(title, xLabel, yLabel) {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="system-ui, sans-serif" role="img">`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  if (title !== undefined && title !== '') {
    parts.push(`<text x="${WIDTH / 2}" y="28" font-size="16" font-weight="700" fill="#1f2328" text-anchor="middle">${escapeXml(title)}</text>`);
  }
  return parts;
}

function yAxisParts(parts, min, max, step, xLabel, yLabel) {
  const plotTop = MARGIN.top;
  const plotBottom = HEIGHT - MARGIN.bottom;
  const yOf = (v) => plotBottom - ((v - min) / (max - min)) * (plotBottom - plotTop);
  // grid + ticks
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    const y = yOf(v);
    parts.push(`<line x1="${MARGIN.left}" y1="${y.toFixed(2)}" x2="${WIDTH - MARGIN.right}" y2="${y.toFixed(2)}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${MARGIN.left - 8}" y="${y.toFixed(2)}" font-size="10" fill="#57606a" text-anchor="end" dominant-baseline="middle">${Number.isInteger(v) ? v : v.toFixed(2)}</text>`);
  }
  parts.push(`<line x1="${MARGIN.left}" y1="${plotTop}" x2="${MARGIN.left}" y2="${plotBottom}" stroke="#1f2328" stroke-width="1.5"/>`);
  parts.push(`<line x1="${MARGIN.left}" y1="${plotBottom}" x2="${WIDTH - MARGIN.right}" y2="${plotBottom}" stroke="#1f2328" stroke-width="1.5"/>`);
  if (yLabel !== undefined && yLabel !== '') {
    parts.push(`<text x="20" y="${(plotTop + plotBottom) / 2}" font-size="12" fill="#1f2328" text-anchor="middle" transform="rotate(-90 20 ${(plotTop + plotBottom) / 2})">${escapeXml(yLabel)}</text>`);
  }
  return { yOf, plotTop, plotBottom };
}

/** Bar chart with optional error bars. */
export function renderBarChart({ title, x_label, y_label, labels, values, errors }) {
  const vals = validateNumbers(values, 'values');
  if (!Array.isArray(labels) || labels.length !== vals.length) throw new MolbioInputError('labels must be an array with the same length as values');
  let errs = undefined;
  if (errors !== undefined) {
    if (!Array.isArray(errors) || errors.length !== vals.length) throw new MolbioInputError('errors must be an array with the same length as values');
    for (const value of errors) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new MolbioInputError('errors must contain non-negative numbers');
    }
    errs = errors;
  }
  let min = Math.min(0, ...vals);
  let max = Math.max(0, ...vals);
  if (errs !== undefined) {
    min = Math.min(min, ...vals.map((v, i) => v - errs[i]));
    max = Math.max(max, ...vals.map((v, i) => v + errs[i]));
  }
  if (max === min) max = min + 1;
  const parts = frameParts(title, x_label, y_label);
  const step = niceStep(max - min);
  const { yOf, plotTop, plotBottom } = yAxisParts(parts, min, max, step, x_label, y_label);
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const slot = plotWidth / vals.length;
  const barWidth = Math.max(6, Math.min(48, slot * 0.6));
  for (let i = 0; i < vals.length; i++) {
    const cx = MARGIN.left + slot * i + slot / 2;
    const yTop = yOf(Math.max(0, vals[i]));
    const yBase = yOf(0);
    parts.push(`<rect x="${(cx - barWidth / 2).toFixed(2)}" y="${Math.min(yTop, yBase).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(1, Math.abs(yBase - yTop)).toFixed(2)}" fill="#4a7dd8" rx="2"/>`);
    if (errs !== undefined && errs[i] > 0) {
      const yLo = yOf(vals[i] - errs[i]);
      const yHi = yOf(vals[i] + errs[i]);
      parts.push(`<line x1="${cx.toFixed(2)}" y1="${yLo.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${yHi.toFixed(2)}" stroke="#1f2328" stroke-width="1.5"/>`);
      for (const y of [yLo, yHi]) {
        parts.push(`<line x1="${(cx - 5).toFixed(2)}" y1="${y.toFixed(2)}" x2="${(cx + 5).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#1f2328" stroke-width="1.5"/>`);
      }
    }
    const label = String(labels[i]).length > 14 ? String(labels[i]).slice(0, 13) + '…' : String(labels[i]);
    parts.push(`<text x="${cx.toFixed(2)}" y="${plotBottom + 18}" font-size="10" fill="#1f2328" text-anchor="middle">${escapeXml(label)}</text>`);
  }
  if (x_label !== undefined && x_label !== '') {
    parts.push(`<text x="${(MARGIN.left + WIDTH - MARGIN.right) / 2}" y="${HEIGHT - 14}" font-size="12" fill="#1f2328" text-anchor="middle">${escapeXml(x_label)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** Scatter plot with optional linear fit (y = intercept + slope·x). */
export function renderScatterChart({ title, x_label, y_label, x, y, fit }) {
  const xs = validateNumbers(x, 'x');
  const ys = validateNumbers(y, 'y');
  if (xs.length !== ys.length) throw new MolbioInputError('x and y must have the same length');
  let fitLine = undefined;
  if (fit !== undefined && fit !== null && fit !== false) {
    if (typeof fit !== 'object' || typeof fit.slope !== 'number' || typeof fit.intercept !== 'number') {
      throw new MolbioInputError('fit must be { slope, intercept }');
    }
    fitLine = fit;
  }
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMax === xMin) {
    const pad = Math.abs(xMax) * 0.1 + 1;
    xMin -= pad;
    xMax += pad;
  }
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (fitLine !== undefined) {
    yMin = Math.min(yMin, fitLine.intercept + fitLine.slope * xMin, fitLine.intercept + fitLine.slope * xMax);
    yMax = Math.max(yMax, fitLine.intercept + fitLine.slope * xMin, fitLine.intercept + fitLine.slope * xMax);
  }
  if (yMax === yMin) {
    const pad = Math.abs(yMax) * 0.1 + 1;
    yMin -= pad;
    yMax += pad;
  }
  return renderScatterChartWithRange({ title, x_label, y_label, x: xs, y: ys, fit: fitLine, xMin, xMax, yMin, yMax });
}

function renderScatterChartWithRange({ title, x_label, y_label, x, y, fit, xMin, xMax, yMin, yMax }) {
  const parts = frameParts(title, x_label, y_label);
  const plotTop = MARGIN.top;
  const plotBottom = HEIGHT - MARGIN.bottom;
  const plotLeft = MARGIN.left;
  const plotRight = WIDTH - MARGIN.right;
  const xOf = (v) => plotLeft + ((v - xMin) / (xMax - xMin)) * (plotRight - plotLeft);
  const yOf = (v) => plotBottom - ((v - yMin) / (yMax - yMin)) * (plotBottom - plotTop);
  const yStep = niceStep(yMax - yMin);
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
    const py = yOf(v);
    parts.push(`<line x1="${plotLeft}" y1="${py.toFixed(2)}" x2="${plotRight}" y2="${py.toFixed(2)}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${plotLeft - 8}" y="${py.toFixed(2)}" font-size="10" fill="#57606a" text-anchor="end" dominant-baseline="middle">${Number.isInteger(v) ? v : v.toFixed(2)}</text>`);
  }
  const xStep = niceStep(xMax - xMin);
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + 1e-9; v += xStep) {
    const px = xOf(v);
    parts.push(`<line x1="${px.toFixed(2)}" y1="${plotTop}" x2="${px.toFixed(2)}" y2="${plotBottom}" stroke="#f1f2f4" stroke-width="1"/>`);
    parts.push(`<text x="${px.toFixed(2)}" y="${plotBottom + 18}" font-size="10" fill="#57606a" text-anchor="middle">${Number.isInteger(v) ? v : v.toFixed(2)}</text>`);
  }
  parts.push(`<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="#1f2328" stroke-width="1.5"/>`);
  parts.push(`<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="#1f2328" stroke-width="1.5"/>`);
  if (fit !== undefined) {
    const y1 = yOf(fit.intercept + fit.slope * xMin);
    const y2 = yOf(fit.intercept + fit.slope * xMax);
    parts.push(`<line x1="${plotLeft.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${plotRight.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#c73a3a" stroke-width="2"/>`);
  }
  for (let i = 0; i < x.length; i++) {
    parts.push(`<circle cx="${xOf(x[i]).toFixed(2)}" cy="${yOf(y[i]).toFixed(2)}" r="4" fill="#c73a3a"/>`);
  }
  if (y_label !== undefined && y_label !== '') {
    parts.push(`<text x="20" y="${(plotTop + plotBottom) / 2}" font-size="12" fill="#1f2328" text-anchor="middle" transform="rotate(-90 20 ${(plotTop + plotBottom) / 2})">${escapeXml(y_label)}</text>`);
  }
  if (x_label !== undefined && x_label !== '') {
    parts.push(`<text x="${(plotLeft + plotRight) / 2}" y="${HEIGHT - 14}" font-size="12" fill="#1f2328" text-anchor="middle">${escapeXml(x_label)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** Virutal agarose gel: deterministic ladder + sample lanes as rounded bands. */
export function renderGel({ title = 'Agarose gel', lanes, ladder = '1kb', showLadder = true }) {
  const LADDERS = {
    '1kb': [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 750, 500, 250],
    '100bp': [1500, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
  };
  const ladderSizes = LADDERS[ladder];
  if (ladderSizes === undefined) throw new Error(`unknown ladder "${ladder}"`);
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 12) {
    throw new Error('lanes must be an array of 1 to 12 lanes');
  }
  for (const lane of lanes) {
    if (lane === null || typeof lane !== 'object' || !Array.isArray(lane.fragments)) {
      throw new Error('each lane must be an object with a fragments array');
    }
    for (const size of lane.fragments) {
      if (!Number.isFinite(size) || size <= 0) throw new Error(`invalid fragment size ${size}`);
    }
  }

  const MAX_SIZE = 10000;
  const MIN_SIZE = 50;
  const TOP_MARGIN = 60;
  const RUN_LENGTH = 600;
  const BOTTOM_MARGIN = 40;
  const LANE_WIDTH = 70;
  const LEFT_GUTTER = 70;
  const RIGHT_GUTTER = 20;

  const laneCount = lanes.length + (showLadder ? 1 : 0);
  const width = LEFT_GUTTER + laneCount * LANE_WIDTH + RIGHT_GUTTER;
  const height = TOP_MARGIN + RUN_LENGTH + BOTTOM_MARGIN;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fraction = (size) =>
    (Math.log10(MAX_SIZE) - Math.log10(clamp(size, MIN_SIZE, MAX_SIZE))) /
    (Math.log10(MAX_SIZE) - Math.log10(MIN_SIZE));
  const bandY = (size) => TOP_MARGIN + fraction(size) * RUN_LENGTH;
  const bandThickness = (size) => clamp(2, 10, 2 + 2 * Math.log10(size));

  function formatLadderLabel(size) {
    if (size >= 1000) {
      return `${size / 1000} kb`;
    }
    return `${size / 1000} kb`;
  }

  const BAND_FILL = '#4a7dd8';
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif" role="img">`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  parts.push(`<text x="${(width / 2).toFixed(2)}" y="28" font-size="16" font-weight="700" fill="#1f2328" text-anchor="middle">${escapeXml(title)}</text>`);

  const laneX = (index) => LEFT_GUTTER + index * LANE_WIDTH;

  // Lane labels sit above the wells.
  for (let i = 0; i < lanes.length; i++) {
    const index = i + (showLadder ? 1 : 0);
    const label = String(lanes[i].label ?? '');
    if (label !== '') {
      parts.push(`<text x="${(laneX(index) + LANE_WIDTH / 2).toFixed(2)}" y="46" font-size="10" fill="#57606a" text-anchor="middle">${escapeXml(label)}</text>`);
    }
  }

  // Ladder lane (leftmost when shown).
  if (showLadder) {
    parts.push(`<rect x="${(laneX(0) + 5).toFixed(2)}" y="${TOP_MARGIN - 8}" width="${LANE_WIDTH - 10}" height="8" rx="2" fill="#d0d7de"/>`);
    for (const size of ladderSizes) {
      const y = bandY(size);
      const thick = bandThickness(size);
      parts.push(`<rect x="${(laneX(0) + 5).toFixed(2)}" y="${(y - thick / 2).toFixed(2)}" width="${LANE_WIDTH - 10}" height="${thick.toFixed(2)}" rx="2" fill="${BAND_FILL}"/>`);
      parts.push(`<text x="${(laneX(0) - 6).toFixed(2)}" y="${y.toFixed(2)}" font-size="10" fill="#57606a" text-anchor="end" dominant-baseline="middle">${escapeXml(formatLadderLabel(size))}</text>`);
    }
  }

  // Sample lanes: well + each fragment band.
  for (let i = 0; i < lanes.length; i++) {
    const index = i + (showLadder ? 1 : 0);
    const x = laneX(index);
    parts.push(`<rect x="${(x + 5).toFixed(2)}" y="${TOP_MARGIN - 8}" width="${LANE_WIDTH - 10}" height="8" rx="2" fill="#d0d7de"/>`);
    for (const size of lanes[i].fragments) {
      const y = bandY(size);
      const thick = bandThickness(size);
      parts.push(`<rect x="${(x + 5).toFixed(2)}" y="${(y - thick / 2).toFixed(2)}" width="${LANE_WIDTH - 10}" height="${thick.toFixed(2)}" rx="2" fill="${BAND_FILL}"/>`);
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}
