/**
 * dsh-molbio-tools/svgio.mjs
 *
 * Shared drawing helpers for the v19 plots (FASTQ report, phylogenetic tree,
 * virtual PCR gel panels, GC/CpG composition).
 *
 * WHY THIS EXISTS
 * ---------------
 * `plasmid.mjs`, `plot.mjs`, `logo.mjs` and `protein-structure.mjs` each grew
 * their own `escapeXml` / `round` / tick formatting / Y-scaling. Four more
 * pictures should not become a fifth copy of that, so the primitives live here
 * once.
 *
 * THE ONE HARD RULE
 * -----------------
 * Everything here emits the SVG subset `svgpng.mjs` can rasterize — `rect`,
 * `line`, `circle`, `polygon`, `polyline`, `path`, `text` (including `<tspan>`
 * runs, up to one level of nesting), hex colours, plain numeric attributes. No
 * `<g>`, no `transform`, no `url(#…)`, no gradients, no CSS classes. That is not
 * a style preference: `test/svgpng.mjs` asserts on REAL renderer output that
 * `unsupported` and `missing_glyphs` are both EMPTY, and `attach_image` hands
 * those pixels to the model. A new construct must therefore fail in the test
 * suite rather than vanish from the picture.
 *
 * Host side only: like `svgpng.mjs` this module is not part of the client
 * bundle.
 */

import { textWidth, wrapText } from './font-metrics.mjs';

/** Escape the five XML characters that cannot appear raw in text/attributes. */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Round to `digits` decimals without accumulating float noise in the output. */
export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Format one axis tick compactly (integers plain, fractions to 3 digits). */
export function formatTick(value, digits = 3) {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return String(round(value, digits));
}

/**
 * Map a value from a data domain onto a pixel range.
 * `range` may be given low-to-high (normal) or high-to-low (inverted, useful
 * for screen Y axes) — the scale honours whichever order it is given.
 *
 * @returns {{of: (value: number) => number, invert: (px: number) => number, domain: number[], range: number[]}}
 */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const of = (value) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
  const invert = (px) => (r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span);
  return { of, invert, domain: [d0, d1], range: [r0, r1] };
}

/**
 * Human-friendly tick values covering `domain` (steps of 1/2/5 × 10ⁿ).
 *
 * Rather than rounding the naive step up (which loses ticks — [0,10] would get
 * 0/5/10 instead of 0/2/4/6/8/10), this collects every candidate step at the
 * right magnitude and picks the one whose resulting tick count is closest to
 * the requested count. A slight over-count wins ties, because a readable axis
 * gains more from a few extra round labels than from empty space.
 */
export function niceTicks(domain, count = 5) {
  const [d0, d1] = domain;
  if (!(d1 > d0) || count < 2) return [d0];
  const span = d1 - d0;
  const magnitude = 10 ** Math.floor(Math.log10(span / Math.max(1, count - 1)));
  const candidates = [];
  for (const factor of [1, 2, 5, 10]) {
    const step = factor * magnitude;
    const ticks = [];
    for (let value = Math.ceil(d0 / step - 1e-9) * step; value <= d1 + step * 1e-9; value += step) {
      // `+ 0` normalises -0: it renders as "-0" in SVG and is a different
      // value to assert against, for no benefit.
      ticks.push(round(value, 10) + 0);
    }
    if (ticks.length >= 2) candidates.push({ step, ticks });
  }
  if (candidates.length === 0) return [d0, d1];
  candidates.sort((a, b) => {
    const distance = Math.abs(a.ticks.length - count) - Math.abs(b.ticks.length - count);
    if (distance !== 0) return distance;
    return b.ticks.length - a.ticks.length;
  });
  return candidates[0].ticks;
}

/**
 * A complete, standalone SVG document.
 *
 * `body` is raw SVG markup produced by the helpers below (or by an existing
 * renderer); `title` goes into a `<title>` element and, for accessibility and
 * "what am I looking at", is repeated as a visible caption when `caption` is
 * true.
 *
 * @returns {string}
 */
export function svgDocument({ width, height, title = '', description = '', background = '#ffffff', body = '', extra = '' }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}">`,
    title === '' ? '' : `<title>${escapeXml(title)}</title>`,
    description === '' ? '' : `<desc>${escapeXml(description)}</desc>`,
    extra,
    background === '' ? '' : `<rect x="0" y="0" width="${round(width)}" height="${round(height)}" fill="${background}"/>`,
    body,
    '</svg>',
  ].filter((line) => line !== '').join('\n');
}

/**
 * One titled panel: a white card with a border, a title line and optional
 * subtitle. Returns the frame markup plus the inner plot rectangle, so callers
 * can draw inside without recomputing insets.
 *
 * @returns {{markup: string, plot: {x: number, y: number, width: number, height: number}, bottom: number}}
 */
export function panel({ x, y, width, height, title = '', subtitle = '', fill = '#ffffff', border = '#d0d7de', inset = { top: 34, right: 14, bottom: 26, left: 46 } }) {
  const parts = [
    `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="${fill}" stroke="${border}" stroke-width="1"/>`,
  ];
  if (title !== '') parts.push(textRun({ x: x + 12, y: y + 18, text: title, size: 12, weight: 'bold', fill: '#24292f' }));
  if (subtitle !== '') parts.push(textRun({ x: x + 12, y: y + 30, text: subtitle, size: 9, fill: '#57606a' }));
  return {
    markup: parts.join('\n'),
    plot: {
      x: x + inset.left,
      y: y + inset.top,
      width: Math.max(1, width - inset.left - inset.right),
      height: Math.max(1, height - inset.top - inset.bottom),
    },
    bottom: y + height,
  };
}

/** One text run. `anchor` is start/middle/end; `rotate` turns about (x, y). */
export function textRun({ x, y, text, size = 11, fill = '#24292f', anchor = 'start', weight = '', rotate = 0, baseline = '', family = 'sans-serif', length = undefined, spacing = undefined }) {
  const attributes = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-size="${round(size)}"`,
    `font-family="${family}"`,
    `fill="${fill}"`,
    anchor === 'start' ? '' : `text-anchor="${anchor}"`,
    weight === '' ? '' : `font-weight="${weight}"`,
    rotate === 0 ? '' : `transform="rotate(${round(rotate)} ${round(x)} ${round(y)})"`,
    baseline === '' ? '' : `dominant-baseline="${baseline}"`,
    length === undefined ? '' : `textLength="${round(length)}" lengthAdjust="spacingAndGlyphs"`,
    spacing === undefined ? '' : `letter-spacing="${round(spacing)}"`,
  ].filter((value) => value !== '');
  return `<text ${attributes.join(' ')}>${escapeXml(text)}</text>`;
}

/**
 * A MULTI-LINE text run: one `<tspan>` per line, each on its own baseline.
 *
 * Why this exists: a single-line label cannot be clipped or shrunk without
 * either losing characters or becoming illegible, and v19's tree drew a long
 * leaf name straight through its neighbours. Breaking it over several lines is
 * the honest fix, and `<tspan>` is the SVG mechanism for it.
 *
 * `lines` may be pre-broken by the caller, or produced by `wrapTextLines`.
 * `anchor` applies identically to every line, so a centred or end-anchored
 * multi-line block stays aligned as a block.
 *
 * Host side only. `svgpng.mjs` rasterizes this form; the browser half never
 * sees it (see this module's header).
 */
export function textSpanLines({ x, y, lines, size = 11, fill = '#24292f', anchor = 'start', weight = '', baseline = '', lineHeight = undefined, family = 'sans-serif' }) {
  const step = lineHeight ?? size * 1.2;
  const body = lines
    .map((line, index) => {
      const attributes = [
        `x="${round(x)}"`,
        `y="${round(y + index * step)}"`,
        index === 0 ? '' : `font-size="${round(size)}"`,
        index === 0 ? '' : `fill="${fill}"`,
      ].filter((value) => value !== '');
      return `<tspan ${attributes.join(' ')}>${escapeXml(line)}</tspan>`;
    })
    .join('');
  const attributes = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-size="${round(size)}"`,
    `font-family="${family}"`,
    `fill="${fill}"`,
    anchor === 'start' ? '' : `text-anchor="${anchor}"`,
    weight === '' ? '' : `font-weight="${weight}"`,
    baseline === '' ? '' : `dominant-baseline="${baseline}"`,
  ].filter((value) => value !== '');
  return `<text ${attributes.join(' ')}>${body}</text>`;
}

/**
 * Break `text` into lines that fit `maxWidth` pixels, using the SAME advance
 * metric the rasterizer draws with (`font-metrics.mjs` — imported here so the
 * two cannot drift apart).
 *
 * Returns the lines AND their block height, because a caller laying out rows
 * (the tree) has to know how much vertical room the label needs.
 *
 * @returns {{lines: string[], width: number, height: number, step: number}}
 */
export function wrapTextLines(text, maxWidth, size, { lineHeight = undefined } = {}) {
  const lines = wrapText(text, maxWidth, size);
  const step = lineHeight ?? size * 1.2;
  const width = Math.max(...lines.map((line) => textWidth(line, size)));
  return { lines, width, height: step * lines.length, step };
}

/** One straight line segment. */
export function line({ x1, y1, x2, y2, stroke = '#24292f', width = 1, dash = undefined, cap = undefined, opacity = undefined }) {
  const attributes = [
    `x1="${round(x1)}"`, `y1="${round(y1)}"`, `x2="${round(x2)}"`, `y2="${round(y2)}"`,
    `stroke="${stroke}"`, `stroke-width="${round(width)}"`,
    dash === undefined ? '' : `stroke-dasharray="${dash.map((value) => round(value)).join(' ')}"`,
    cap === undefined ? '' : `stroke-linecap="${cap}"`,
    opacity === undefined ? '' : `stroke-opacity="${round(opacity)}"`,
  ].filter((value) => value !== '');
  return `<line ${attributes.join(' ')}/>`;
}

/** One axis-aligned rectangle (optionally rounded, optionally translucent). */
export function rect({ x, y, width, height, fill = 'none', stroke = undefined, strokeWidth = 1, rx = undefined, fillOpacity = undefined }) {
  const attributes = [
    `x="${round(x)}"`, `y="${round(y)}"`,
    `width="${round(Math.max(0, width))}"`, `height="${round(Math.max(0, height))}"`,
    `fill="${fill}"`,
    stroke === undefined ? '' : `stroke="${stroke}"`,
    stroke === undefined ? '' : `stroke-width="${round(strokeWidth)}"`,
    rx === undefined ? '' : `rx="${round(rx)}"`,
    fillOpacity === undefined ? '' : `fill-opacity="${round(fillOpacity)}"`,
  ].filter((value) => value !== '');
  return `<rect ${attributes.join(' ')}/>`;
}

/** One circle. */
export function circle({ cx, cy, r, fill = 'none', stroke = undefined, strokeWidth = 1, fillOpacity = undefined }) {
  const attributes = [
    `cx="${round(cx)}"`, `cy="${round(cy)}"`, `r="${round(Math.max(0, r))}"`,
    `fill="${fill}"`,
    stroke === undefined ? '' : `stroke="${stroke}"`,
    stroke === undefined ? '' : `stroke-width="${round(strokeWidth)}"`,
    fillOpacity === undefined ? '' : `fill-opacity="${round(fillOpacity)}"`,
  ].filter((value) => value !== '');
  return `<circle ${attributes.join(' ')}/>`;
}

/** A polyline (never filled) or polygon (fillable) from [x, y] pairs. */
export function polyline(points, { fill = 'none', stroke = '#24292f', width = 1, closed = false, opacity = undefined } = {}) {
  if (points.length < 2) return '';
  const tag = closed ? 'polygon' : 'polyline';
  const attributes = [
    `points="${points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ')}"`,
    `fill="${fill}"`,
    stroke === undefined ? '' : `stroke="${stroke}"`,
    stroke === undefined ? '' : `stroke-width="${round(width)}"`,
    opacity === undefined ? '' : `stroke-opacity="${round(opacity)}"`,
  ].filter((value) => value !== '');
  return `<${tag} ${attributes.join(' ')}/>`;
}

/**
 * A horizontal or vertical axis: the line, its ticks and their labels.
 * `orientation: 'x'` puts labels under the axis, 'y' puts them left of it.
 */
export function axis({ from, to, at, ticks, orientation = 'x', label = '', tickLabel = formatTick, size = 9, color = '#57606a', tickLength = 3, title = '' }) {
  const parts = [];
  if (orientation === 'x') {
    parts.push(line({ x1: from, y1: at, x2: to, y2: at, stroke: color, width: 1 }));
    for (const tick of ticks) {
      parts.push(line({ x1: tick, y1: at, x2: tick, y2: at + tickLength, stroke: color, width: 1 }));
      parts.push(textRun({ x: tick, y: at + tickLength + size + 1, text: tickLabel(tick), size, fill: color, anchor: 'middle' }));
    }
    if (title !== '') parts.push(textRun({ x: (from + to) / 2, y: at + tickLength + (size + 1) * 2 + 2, text: title, size, fill: color, anchor: 'middle' }));
  } else {
    parts.push(line({ x1: at, y1: from, x2: at, y2: to, stroke: color, width: 1 }));
    for (const tick of ticks) {
      parts.push(line({ x1: at - tickLength, y1: tick, x2: at, y2: tick, stroke: color, width: 1 }));
      parts.push(textRun({ x: at - tickLength - 2, y: tick + size / 3, text: tickLabel(tick), size, fill: color, anchor: 'end' }));
    }
    if (title !== '') parts.push(textRun({ x: at - 30, y: (from + to) / 2, text: title, size, fill: color, anchor: 'middle', rotate: -90 }));
  }
  return parts.join('\n');
}

/**
 * One labelled data series drawn as a polyline.
 *
 * `values` are RAW data values: `xOf(index)` and `yOf(value)` are the mapping
 * functions. That direction (raw in, scales applied here) avoids the
 * double-mapping bug where a caller pre-maps and the helper maps again.
 */
export function series({ values, xOf, yOf, stroke = '#0969da', width = 1.5, dash = undefined }) {
  const points = values.map((value, index) => [xOf(index), yOf(value)]);
  return polyline(points, { stroke, width, dash });
}

/**
 * Where a data index sits on a pixel axis of `width`, for a series of `count`
 * points that must span the full axis (edge-to-edge, not point-centred).
 * `invert` is the round trip, so axis labels can be derived from tick pixels
 * exactly as `linearScale` allows.
 */
export function indexScale(count, range) {
  const [r0, r1] = range;
  const span = Math.max(1, count - 1);
  return {
    of: (index) => r0 + (index / span) * (r1 - r0),
    invert: (pixel) => (r1 === r0 ? 0 : ((pixel - r0) / (r1 - r0)) * span),
    width: (r1 - r0) / span,
  };
}

/**
 * A legend row: a colour swatch plus text, laid out left to right.
 * Returns the markup; callers stack rows themselves.
 */
export function legendRow({ x, y, entries, size = 9, swatch = 9, gap = 46 }) {
  const parts = [];
  entries.forEach((entry, index) => {
    const left = x + index * gap;
    if (entry.fill !== undefined) {
      parts.push(rect({ x: left, y: y - swatch + 1, width: swatch, height: swatch, fill: entry.fill, rx: 1 }));
    } else {
      parts.push(line({ x1: left, y1: y - swatch / 2 + 1, x2: left + swatch, y2: y - swatch / 2 + 1, stroke: entry.stroke, width: entry.width ?? 2 }));
    }
    parts.push(textRun({ x: left + swatch + 3, y, text: entry.label, size, fill: '#57606a' }));
  });
  return parts.join('\n');
}

/**
 * Quality/phred → colour, in the three-band spirit of FastQC's report
 * (green = good, amber = the conventional "careful" zone, red = poor).
 * Bands are stated in the legend of the report itself, not implied.
 */
export function qualityColor(phred) {
  if (phred >= 28) return '#00a878';
  if (phred >= 20) return '#e8b400';
  return '#d1242f';
}

/** Grey ramp for density-ish fills, `t` in 0..1. */
export function greyRamp(t) {
  const value = Math.max(0, Math.min(1, t));
  const channel = Math.round(255 - value * 170);
  const hex = channel.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}
