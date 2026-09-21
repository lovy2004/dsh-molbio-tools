/**
 * dsh-molbio-tools/svgpng.mjs
 *
 * Zero-dependency SVG → PNG rasterizer for the SVG documents THIS package
 * generates (plasmid maps, virtual gels, sequence logos, helical wheels,
 * hydropathy profiles and the generic bar/scatter charts). Host-only: the
 * browser half never imports this module (it pulls in `node:zlib`).
 *
 * ## Why this exists
 *
 * The harness filesystem seam is text-only BY CONTRACT: `dsh-fs` rejects
 * binary or non-UTF-8 content with `FS_NOT_TEXT` on both mutation operations
 * ("binary-safe mutations remain deferred"), and `dsh-fs-local` writes the
 * caller's string through `writeFileAtomic` as UTF-8. A plugin therefore
 * cannot put a PNG into the workspace through `ctx.fs` — not even by smuggling
 * bytes through a latin-1 string, because the UTF-8 encoder would replace the
 * non-conforming bytes. Bypassing the seam (direct `node:fs`, or a subprocess
 * shelling out to an image tool) would escape the session sandbox policy the
 * package follows everywhere else, so this package does not do it.
 *
 * What the harness DOES offer is a binary-safe image path plus a way to show
 * the result to the model: `ctx.attachments.saveImage({ data, mediaType })`
 * commits real image bytes, and a tool's `output.render` may return
 * `[{ type: 'text' }, { type: 'image', attachment }]` — exactly how the
 * shipped `read_image` tool hands a file to the model. This module supplies
 * the missing half between those two facts: SVG text → PNG bytes, in process,
 * with no npm dependency and no external binary.
 *
 * ## Scope
 *
 * Deliberately a *projection of the subset this package emits*, not a general
 * SVG renderer. Supported: `rect` (incl. `rx`), `line`, `circle`, `polygon`,
 * `polyline`, `path` (M/L/H/V/C/S/Q/T/A/Z, absolute and relative), `text`
 * with `<tspan>` runs (font-size, font-weight, text-anchor,
 * dominant-baseline, textLength, lengthAdjust, rotate transform, and per-run
 * `x`/`y`/`dx`/`dy` for multi-line labels), `fill`/`stroke` hex colours,
 * `fill-opacity`, `stroke-width`, `stroke-dasharray`, `stroke-linecap`.
 * Everything else — gradients, clip paths, filters, images, other transforms —
 * is *counted* and reported in `unsupported` rather than silently dropped, so a
 * test can assert that the real renderers stay inside the subset. A `<tspan>`
 * that carries a transform, or that nests another `<tspan>`, is reported the
 * same way instead of being drawn in the wrong place.
 *
 * Text is drawn with a built-in polyline font (see GLYPHS): at the sizes these
 * documents use it is legible and scales cleanly, and it keeps the module free
 * of font files. Glyphs exist for printable ASCII plus the handful of Latin-1
 * and Greek characters the renderers actually emit (`·`, `°`, `±`, `—`, `–`,
 * `…`, `≈`, `μ`, `α`, `─`); anything else is reported in `missing_glyphs` and
 * skipped without shifting the layout, so a CJK plasmid name renders as its
 * surrounding layout with the title absent (the SVG keeps the real text).
 */

import { deflateSync } from 'node:zlib';
import { MolbioInputError } from './lib.mjs';
import { FONT_UNITS_PER_EM, GLYPH_ADVANCE } from './font-metrics.mjs';

/** Hard ceiling on one raster, in pixels, before supersampling. */
export const MAX_RASTER_PIXELS = 16_000_000;

/** Default supersampling factor (2 = 4 samples per output pixel). */
export const DEFAULT_SUPERSAMPLE = 2;

// ── colour ──────────────────────────────────────────────────────────────────

const NAMED_COLORS = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

/**
 * Parse an SVG paint value into RGB.
 * @param {string|undefined} value - `#rgb`, `#rrggbb`, a few named colours, or undefined.
 * @returns {[number, number, number]|undefined} RGB, or undefined for none/unparsable.
 */
export function parseColor(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'transparent') return undefined;
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = [...hex].map((digit) => Number.parseInt(digit + digit, 16));
      return Number.isNaN(r) ? undefined : [r, g, b];
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? undefined : [r, g, b];
    }
    return undefined;
  }
  return NAMED_COLORS[text];
}

// ── PNG encoding ────────────────────────────────────────────────────────────

let crcTable;

function crc32(bytes) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * Encode an 8-bit truecolour (RGB) raster as a PNG.
 * @param {{width: number, height: number, rgb: Uint8Array}} image - row-major RGB bytes, `width * height * 3` long.
 * @returns {Uint8Array} the complete PNG file bytes.
 */
export function encodePng({ width, height, rgb }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MolbioInputError(`invalid PNG size ${width}x${height}`);
  }
  if (rgb.length !== width * height * 3) {
    throw new MolbioInputError(`PNG buffer is ${rgb.length} bytes, expected ${width * height * 3}`);
  }
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) — the rasterizer emits exact pixels
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ── raster canvas ───────────────────────────────────────────────────────────

class Canvas {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < this.pixels.length; i += 3) {
      this.pixels[i] = background[0];
      this.pixels[i + 1] = background[1];
      this.pixels[i + 2] = background[2];
    }
  }

  blend(x, y, color, alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    if (alpha >= 1) {
      this.pixels[index] = color[0];
      this.pixels[index + 1] = color[1];
      this.pixels[index + 2] = color[2];
      return;
    }
    const inverse = 1 - alpha;
    this.pixels[index] = Math.round(this.pixels[index] * inverse + color[0] * alpha);
    this.pixels[index + 1] = Math.round(this.pixels[index + 1] * inverse + color[1] * alpha);
    this.pixels[index + 2] = Math.round(this.pixels[index + 2] * inverse + color[2] * alpha);
  }

  /** Box-filter the supersampled canvas down to the requested output size. */
  downsample(factor) {
    if (factor === 1) return this.pixels;
    const outWidth = this.width / factor;
    const outHeight = this.height / factor;
    const out = new Uint8Array(outWidth * outHeight * 3);
    const samples = factor * factor;
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * this.width;
          for (let dx = 0; dx < factor; dx++) {
            const index = (row + x * factor + dx) * 3;
            r += this.pixels[index];
            g += this.pixels[index + 1];
            b += this.pixels[index + 2];
          }
        }
        const outIndex = (y * outWidth + x) * 3;
        out[outIndex] = Math.round(r / samples);
        out[outIndex + 1] = Math.round(g / samples);
        out[outIndex + 2] = Math.round(b / samples);
      }
    }
    return out;
  }
}

// ── primitives ──────────────────────────────────────────────────────────────

/** Even-odd scanline fill of one closed polygon (device coordinates). */
function fillPolygon(canvas, points, color, alpha) {
  if (points.length < 3 || color === undefined) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  const yStart = Math.max(0, Math.ceil(minY - 0.5));
  const yEnd = Math.min(canvas.height - 1, Math.floor(maxY - 0.5));
  const crossings = [];
  for (let y = yStart; y <= yEnd; y++) {
    const scan = y + 0.5;
    crossings.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [x1, y1] = points[j];
      const [x2, y2] = points[i];
      if ((y1 <= scan && y2 > scan) || (y2 <= scan && y1 > scan)) {
        crossings.push(x1 + ((scan - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const xStart = Math.max(0, Math.ceil(crossings[i] - 0.5));
      const xEnd = Math.min(canvas.width - 1, Math.floor(crossings[i + 1] - 0.5));
      for (let x = xStart; x <= xEnd; x++) canvas.blend(x, y, color, alpha);
    }
  }
}

function circlePolygon(cx, cy, r, scale) {
  const segments = Math.max(12, Math.min(256, Math.ceil((2 * Math.PI * r * scale) / 1.5)));
  const points = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * 2 * Math.PI;
    points.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
  }
  return points;
}

function fillCircle(canvas, cx, cy, r, color, alpha, scale) {
  if (r <= 0) return;
  fillPolygon(canvas, circlePolygon(cx, cy, r, scale), color, alpha);
}

/** Split one polyline into dash runs, walking the pattern in user units. */
function dashSegments(points, pattern) {
  const runs = [];
  let patternIndex = 0;
  let remaining = pattern[0];
  let drawing = true;
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    let [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    let length = Math.hypot(x2 - x1, y2 - y1);
    while (length > 1e-9) {
      const step = Math.min(remaining, length);
      const ratio = step / length;
      const nx = x1 + (x2 - x1) * ratio;
      const ny = y1 + (y2 - y1) * ratio;
      if (drawing) current.push([nx, ny]);
      length -= step;
      remaining -= step;
      x1 = nx;
      y1 = ny;
      if (remaining <= 1e-9) {
        if (drawing && current.length > 1) runs.push(current);
        drawing = !drawing;
        patternIndex = (patternIndex + 1) % pattern.length;
        remaining = pattern[patternIndex];
        current = [[x1, y1]];
      }
    }
  }
  if (drawing && current.length > 1) runs.push(current);
  return runs;
}

function strokePolyline(canvas, points, { color, width, alpha, scale, linecap, dash }) {
  if (color === undefined || width <= 0 || points.length < 2) return;
  const runs = dash === undefined ? [points] : dashSegments(points, dash);
  const half = width / 2;
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const [x1, y1] = run[i - 1];
      const [x2, y2] = run[i];
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (length < 1e-9) continue;
      const nx = (-(y2 - y1) / length) * half;
      const ny = ((x2 - x1) / length) * half;
      fillPolygon(canvas, [
        [x1 + nx, y1 + ny],
        [x2 + nx, y2 + ny],
        [x2 - nx, y2 - ny],
        [x1 - nx, y1 - ny],
      ], color, alpha);
    }
    // Round joins approximate miter joins: a disc at every interior vertex
    // keeps corners filled without the unbounded spikes a true miter can
    // produce. End caps are only added for the documented `round` linecap;
    // SVG's default is `butt`.
    for (const [x, y] of run.slice(1, -1)) fillCircle(canvas, x, y, half, color, alpha, scale);
    if (linecap === 'round') {
      fillCircle(canvas, run[0][0], run[0][1], half, color, alpha, scale);
      fillCircle(canvas, run.at(-1)[0], run.at(-1)[1], half, color, alpha, scale);
    }
  }
}

function strokeSubpaths(canvas, subpaths, paint) {
  for (const subpath of subpaths) {
    const points = subpath.closed ? [...subpath.points, subpath.points[0]] : subpath.points;
    if (points.length >= 2) strokePolyline(canvas, points, paint);
  }
}

// ── path data ───────────────────────────────────────────────────────────────

const PATH_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * Flatten SVG path data into closed/open subpaths of line segments.
 * @param {string} d - the `d` attribute.
 * @param {number} scale - device pixels per user unit (drives arc flattening).
 * @returns {Array<{points: number[][], closed: boolean}>}
 */
function pathToSubpaths(d, scale) {
  const tokens = String(d).match(PATH_TOKEN) ?? [];
  const subpaths = [];
  let current = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = '';
  let index = 0;
  let previousControl;
  const next = () => Number.parseFloat(tokens[index++]);
  const push = (px, py) => current.push([px * scale, py * scale]);
  const flush = (closed) => {
    if (current.length > 1) subpaths.push({ points: current, closed });
    current = [];
  };
  const ellipseArc = (rx, ry, rotationDeg, largeArc, sweep, ex, ey) => {
    if (rx === 0 || ry === 0) {
      push(ex, ey);
      return;
    }
    const phi = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x - ex) / 2;
    const dy = (y - ey) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      const factor = Math.sqrt(lambda);
      rx *= factor;
      ry *= factor;
    }
    const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
    const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(denominator === 0 ? 0 : numerator / denominator);
    const cxp = (coef * rx * y1p) / ry;
    const cyp = (-coef * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x + ex) / 2;
    const cy = sin * cxp + cos * cyp + (y + ey) / 2;
    const angle = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy;
      const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      const value = lengths === 0 ? 0 : Math.min(1, Math.max(-1, dot / lengths));
      const sign = ux * vy - uy * vx < 0 ? -1 : 1;
      return sign * Math.acos(value);
    };
    const ux = (x1p - cxp) / rx;
    const uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx;
    const vy = (-y1p - cyp) / ry;
    const theta1 = angle(1, 0, ux, uy);
    let delta = angle(ux, uy, vx, vy);
    if (sweep === 0 && delta > 0) delta -= 2 * Math.PI;
    if (sweep === 1 && delta < 0) delta += 2 * Math.PI;
    const steps = Math.max(6, Math.min(256, Math.ceil((Math.abs(delta) * Math.max(rx, ry) * scale) / 1.5)));
    for (let i = 1; i <= steps; i++) {
      const theta = theta1 + (delta * i) / steps;
      const px = cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin;
      const py = cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos;
      push(px, py);
    }
  };
  while (index < tokens.length) {
    const token = tokens[index];
    if (/[A-Za-z]/.test(token)) {
      command = token;
      index++;
      if (command === 'Z' || command === 'z') {
        flush(true);
        x = startX;
        y = startY;
        continue;
      }
    } else if (command === '') {
      index++;
      continue;
    }
    const relative = command === command.toLowerCase();
    const base = relative ? [x, y] : [0, 0];
    switch (command.toUpperCase()) {
      case 'M': {
        const nx = next() + base[0];
        const ny = next() + base[1];
        flush(false);
        x = startX = nx;
        y = startY = ny;
        push(x, y);
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        x = next() + base[0];
        y = next() + base[1];
        push(x, y);
        break;
      }
      case 'H': {
        x = next() + base[0];
        push(x, y);
        break;
      }
      case 'V': {
        y = next() + base[1];
        push(x, y);
        break;
      }
      case 'C': {
        const x1 = next() + base[0];
        const y1 = next() + base[1];
        const x2 = next() + base[0];
        const y2 = next() + base[1];
        const ex = next() + base[0];
        const ey = next() + base[1];
        flattenCubic(push, x, y, x1, y1, x2, y2, ex, ey, scale);
        previousControl = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'S': {
        const x2 = next() + base[0];
        const y2 = next() + base[1];
        const ex = next() + base[0];
        const ey = next() + base[1];
        const [rx1, ry1] = previousControl === undefined ? [x, y] : [2 * x - previousControl[0], 2 * y - previousControl[1]];
        flattenCubic(push, x, y, rx1, ry1, x2, y2, ex, ey, scale);
        previousControl = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'Q': {
        const qx = next() + base[0];
        const qy = next() + base[1];
        const ex = next() + base[0];
        const ey = next() + base[1];
        flattenQuadratic(push, x, y, qx, qy, ex, ey);
        previousControl = [qx, qy];
        x = ex;
        y = ey;
        break;
      }
      case 'T': {
        const ex = next() + base[0];
        const ey = next() + base[1];
        const [qx, qy] = previousControl === undefined ? [x, y] : [2 * x - previousControl[0], 2 * y - previousControl[1]];
        flattenQuadratic(push, x, y, qx, qy, ex, ey);
        previousControl = [qx, qy];
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const rx = next();
        const ry = next();
        const rotation = next();
        const largeArc = next();
        const sweep = next();
        const ex = next() + base[0];
        const ey = next() + base[1];
        ellipseArc(rx, ry, rotation, largeArc, sweep, ex, ey);
        x = ex;
        y = ey;
        previousControl = undefined;
        break;
      }
      default:
        index++;
        break;
    }
  }
  flush(false);
  return subpaths;
}

function flattenCubic(push, x0, y0, x1, y1, x2, y2, x3, y3, scale) {
  const steps = Math.max(4, Math.min(64, Math.ceil((Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)) * scale / 4)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    push(
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    );
  }
}

function flattenQuadratic(push, x0, y0, x1, y1, x2, y2) {
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
  }
}

/** Parse a `points` attribute into a coordinate array. */
function parsePoints(value) {
  const numbers = (String(value).match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  const points = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  return points;
}

function roundedRectPolygon(x, y, width, height, radius, scale) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }
  const points = [];
  const corners = [
    [x + width - r, y + r, -Math.PI / 2, 0],
    [x + width - r, y + height - r, 0, Math.PI / 2],
    [x + r, y + height - r, Math.PI / 2, Math.PI],
    [x + r, y + r, Math.PI, 1.5 * Math.PI],
  ];
  for (const [cx, cy, from, to] of corners) {
    const steps = Math.max(3, Math.ceil((r * scale) / 2));
    for (let i = 0; i <= steps; i++) {
      const theta = from + ((to - from) * i) / steps;
      points.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
    }
  }
  return points;
}

// ── built-in polyline font ──────────────────────────────────────────────────

/**
 * Glyph outlines on a 6 × 7 grid: x ∈ [0, 5] with an advance of 6, cap top at
 * y = 0, baseline at y = 7, x-height top at y = 3, descender to y = 9. Each
 * glyph is one path-data string (same commands as `path`), stroked with round
 * caps so the strokes read as a plotter font. Verify visually before editing:
 * `node test/svgpng.mjs --sheet <out.png>` renders the whole table.
 */
const GLYPHS = {
  ' ': '',
  '!': 'M2.5 0V5M2.5 6.6V7',
  '"': 'M1.6 0V2.2M3.4 0V2.2',
  '#': 'M1.6 0L0.9 7M4 0L3.3 7M0.4 2.2H4.6M0.1 4.8H4.3',
  $: 'M3.9 1.2L2.6 0.2L1.2 0.6L0.9 2L2.5 3L4.1 4L3.8 6.3L2.4 6.9L1 5.9M2.5 0V7',
  '%': 'M4.4 0.3L0.6 6.7M1.5 0.2L2.2 0.9L1.5 1.6L0.8 0.9ZM3.5 5.4L4.2 6.1L3.5 6.8L2.8 6.1Z',
  '&': 'M4.6 7L1.6 3.4L1.2 1.4L2.4 0.2L3.6 1.2L3.2 2.6L0.8 4.4L0.8 6L2.2 7L4 5.6',
  "'": 'M2.6 0V2.2',
  '(': 'M3.6 0L2.2 2V5L3.6 7',
  ')': 'M1.4 0L2.8 2V5L1.4 7',
  '*': 'M2.5 1.2V4.4M1.1 1.9L3.9 3.7M3.9 1.9L1.1 3.7',
  '+': 'M2.5 1.4V5M0.7 3.2H4.3',
  ',': 'M2.8 6.2L2.2 7.6',
  '-': 'M0.8 3.4H4.2',
  '.': 'M2.2 6.3H2.9V7H2.2Z',
  '/': 'M4.3 0L0.7 7',
  0: 'M2.5 0L4.4 1.7V5.3L2.5 7L0.6 5.3V1.7Z',
  1: 'M1.1 1.5L2.7 0V7M0.9 7H4.5',
  2: 'M0.5 1.8L1.4 0.3L3.6 0.3L4.5 1.8L0.5 7H4.7',
  3: 'M0.5 0.8L1.4 0.1L3.6 0.1L4.4 1.5L3.2 3.1H1.8M3.2 3.1L4.5 4.4L3.8 6.5L1.6 7L0.5 6.2',
  4: 'M3.7 7V0L0.3 4.8H4.8',
  5: 'M4.3 0H1L0.8 3.1L2.9 2.9L4.5 4.2L4.1 6.3L2 7L0.6 6.2',
  6: 'M4.4 1L3 0.1L1.2 0.5L0.4 2.6V5.2L1.4 6.8L3.4 7L4.5 5.6L3.9 3.7L2 3.4L0.4 4.6',
  7: 'M0.4 0H4.8L2.4 7',
  8: 'M2.5 0L4.1 0.8V2.6L2.5 3.4L0.9 2.6V0.8ZM2.5 3.4L4.4 4.4V6.2L2.5 7L0.6 6.2V4.4Z',
  9: 'M4.6 3.5L2.5 3.2L0.9 2.9L1.6 0.9L3.5 0.2L4.4 1.4V4.6L3.6 6.7L1.7 7L0.6 6.2',
  ':': 'M2.5 2.4V3M2.5 6.4V7',
  ';': 'M2.6 2.4V3M2.9 6.2L2.3 7.6',
  '<': 'M3.8 0.8L1.2 3.5L3.8 6.2',
  '=': 'M0.7 2.5H4.3M0.7 4.5H4.3',
  '>': 'M1.2 0.8L3.8 3.5L1.2 6.2',
  '?': 'M0.7 1.6L1.6 0.2L3.5 0.2L4.4 1.6L2.6 3.6V4.7M2.6 6.4V7',
  '@': 'M3.6 1.1L1.8 1.3L0.8 3L1.1 5.3L2.9 6.6L4.5 5.9M3.9 2.6L2.5 2.7L2 4L2.9 5L3.9 4.3V2.6M3.9 2.6V5.6L4.4 6.5',
  A: 'M0.2 7L2.5 0L4.8 7M1 4.7H4',
  B: 'M0.6 0V7M0.6 0H3.2L4.4 1.1L3.2 3.2H0.6M3.2 3.2L4.6 4.4L3.3 7H0.6',
  C: 'M4.6 1.4L3.4 0.2L1.8 0.2L0.6 1.6V5.4L1.8 6.8L3.4 6.8L4.6 5.6',
  D: 'M0.6 0V7M0.6 0H2.6L4.4 1.8V5.2L2.6 7H0.6',
  E: 'M4.4 0H0.6V7H4.4M0.6 3.3H3.6',
  F: 'M4.4 0H0.6V7M0.6 3.3H3.6',
  G: 'M4.6 1.4L3.4 0.2L1.8 0.2L0.6 1.6V5.4L1.8 6.8L3.6 6.8L4.6 5.8V4H3.2',
  H: 'M0.6 0V7M4.4 0V7M0.6 3.3H4.4',
  I: 'M1.5 0H3.5M2.5 0V7M1.5 7H3.5',
  J: 'M3.6 0V5.4L2.4 6.9L1 6.4L0.6 5.2',
  K: 'M0.6 0V7M4.4 0L0.6 3.6M2 2.2L4.5 7',
  L: 'M0.8 0V7H4.5',
  M: 'M0.4 7V0L2.5 4L4.6 0V7',
  N: 'M0.5 7V0L4.5 7V0',
  O: 'M2.5 0L4.4 1.7V5.3L2.5 7L0.6 5.3V1.7Z',
  P: 'M0.6 7V0H3.2L4.5 1.3L3.2 3.6H0.6',
  Q: 'M2.5 0L4.4 1.7V5.3L2.5 7L0.6 5.3V1.7ZM3.2 5.2L4.9 7.2',
  R: 'M0.6 7V0H3.2L4.5 1.3L3.2 3.5H0.6M2.6 3.5L4.6 7',
  S: 'M4.5 1.3L3.3 0.2L1.7 0.2L0.7 1.3L2.3 2.9L3.9 3.9L3.6 6.2L2.2 6.9L0.8 5.9',
  T: 'M0.3 0H4.7M2.5 0V7',
  U: 'M0.6 0V5.2L1.6 6.8L3.4 6.8L4.4 5.2V0',
  V: 'M0.2 0L2.5 7L4.8 0',
  W: 'M0.1 0L1.4 7L2.5 2.4L3.6 7L4.9 0',
  X: 'M0.5 0L4.5 7M4.5 0L0.5 7',
  Y: 'M0.3 0L2.5 3.4L4.7 0M2.5 3.4V7',
  Z: 'M0.5 0H4.5L0.5 7H4.5',
  '[': 'M3.6 0H2.2V7H3.6',
  '\\': 'M0.7 0L4.3 7',
  ']': 'M1.4 0H2.8V7H1.4',
  '^': 'M1 2.4L2.5 0.4L4 2.4',
  _: 'M0.2 7.6H4.8',
  '`': 'M1.8 0L3 1.4',
  a: 'M4.3 3.3V7M4.3 4.4L3 3.2L1.3 3.6L0.6 5.2L1.5 6.8L3 6.7L4.3 5.4',
  b: 'M0.7 0V7M0.7 4.2L2 3.2L3.6 3.7L4.4 5.2L3.5 6.8L1.9 6.6L0.7 5.4',
  c: 'M4.3 4L3.2 3.2L1.6 3.4L0.7 5L1.6 6.8L3.2 6.8L4.2 6',
  d: 'M4.3 0V7M4.3 4.2L3 3.2L1.4 3.7L0.6 5.2L1.5 6.8L3 6.6L4.3 5.4',
  e: 'M0.6 5.1H4.4L4.2 3.9L2.8 3.1L1.4 3.5L0.6 5.1L1.4 6.8L3.1 6.8L4.2 6',
  f: 'M3.9 0.6L3.2 0.2L2.2 0.6L2 2V7M0.9 3.3H3.6',
  g: 'M4.3 3.3V7.4L3.4 9L1.7 8.8L0.8 7.8M4.3 4.3L3 3.2L1.4 3.7L0.6 5.2L1.5 6.7L3 6.5L4.3 5.3',
  h: 'M0.7 0V7M0.7 4.2L2.1 3.2L3.6 3.7L4.2 5.2V7',
  i: 'M2.5 0.5V1.1M2.5 3.3V7',
  j: 'M3.3 0.5V1.1M3.3 3.3V7.6L2.6 9L1.2 8.8',
  k: 'M0.7 0V7M3.9 3.3L0.7 5.8M2 4.4L4 7',
  l: 'M2.2 0L2.5 0.6V7',
  m: 'M0.3 7V3.3M0.3 4.3L1.3 3.3L2.2 3.7L2.4 5V7M2.4 4.3L3.4 3.3L4.4 3.8L4.6 5.2V7',
  n: 'M0.7 7V3.3M0.7 4.3L2.1 3.2L3.6 3.7L4.2 5.2V7',
  o: 'M2.5 3.2L4 4L4.3 5.6L3.1 6.8L1.6 6.5L0.7 5L1.5 3.4Z',
  p: 'M0.7 9V3.3M0.7 4.3L2 3.2L3.6 3.7L4.4 5.2L3.5 6.8L2 6.6L0.7 5.4',
  q: 'M4.3 9V3.3M4.3 4.3L3 3.2L1.4 3.7L0.6 5.2L1.5 6.8L3 6.6L4.3 5.4',
  r: 'M0.9 7V3.3M0.9 4.6L2.2 3.3L3.8 3.4',
  s: 'M4.2 4L3.1 3.2L1.6 3.4L1 4.5L2.4 5.4L3.9 5.7L3.4 6.8L1.8 6.9L0.8 6.1',
  t: 'M2.2 0.9V5.8L3 6.9L4.1 6.5M0.9 3.3H3.9',
  u: 'M0.7 3.3V5.4L1.6 6.9L3.1 6.7L4.2 5.3M4.2 3.3V7',
  v: 'M0.3 3.3L2.5 7L4.7 3.3',
  w: 'M0.2 3.3L1.3 7L2.5 4.4L3.7 7L4.8 3.3',
  x: 'M0.6 3.3L4.4 7M4.4 3.3L0.6 7',
  y: 'M0.3 3.3L2.5 7M4.7 3.3L1.4 9',
  z: 'M0.7 3.3H4.3L0.7 7H4.3',
  '{': 'M3.9 0L2.9 1V2.6L2 3.5L2.9 4.4V6L3.9 7',
  '|': 'M2.5 0V7',
  '}': 'M1.6 0L2.6 1V2.6L3.5 3.5L2.6 4.4V6L1.6 7',
  '~': 'M0.5 4.6L1.4 3.4L3 4.6L4.2 3.6',
  '\u00b1': 'M2.5 0.8V4.4M0.7 2.6H4.3M0.7 6H4.3',
  '\u00b7': 'M2.2 3.3H2.9V4H2.2Z',
  '\u00b0': 'M2.6 0.1L3.6 0.9L2.6 1.8L1.6 0.9Z',
  '\u2013': 'M0.8 3.4H4.2',
  '\u2014': 'M0.2 3.4H4.8',
  '\u2026': 'M0.6 6.3H1.3V7H0.6ZM2.2 6.3H2.9V7H2.2ZM3.8 6.3H4.5V7H3.8Z',
  '\u2248': 'M0.5 3.2L1.4 2.2L3 3.4L4.2 2.4M0.5 5.4L1.4 4.4L3 5.6L4.2 4.6',
  '\u03b1': 'M4.4 3.4L3 3.2L1.4 3.8L0.6 5.3L1.6 6.8L3.1 6.6M3.4 3.3L4.6 7',
  '\u03bc': 'M0.7 3.3V6.9M0.7 4.3L2 3.2L3.5 3.7L4.2 5.2M4.2 3.3V9M4.2 9H4.6',
  '\u2500': 'M0.2 3.5H4.8',
};

// `GLYPH_ADVANCE` / `FONT_UNITS_PER_EM` come from `font-metrics.mjs` (imported
// above) so the SVG-emitting helpers lay text out with the SAME advance this
// rasterizer draws it with. Importing `svgpng.mjs` from the browser half is not
// an option — this file imports `node:zlib`.

/**
 * Every character the built-in font can draw, in code-point order. Exported so
 * a test can prove that what the renderers emit stays inside it.
 */
export const FONT_CHARACTERS = Object.freeze(Object.keys(GLYPHS).filter((character) => character !== ' ').sort());

/**
 * Lay out one text run as strokable subpaths.
 * @returns {{subpaths: Array, missing: string[], advance: number}}
 */
function layoutText(text, scale, options) {
  const { x, y, fontSize, anchor, baseline, textLength } = options;
  const unit = (fontSize / FONT_UNITS_PER_EM) * scale;
  const advance = GLYPH_ADVANCE * unit;
  const capHeight = 7 * unit;
  const characters = [...String(text)];
  const natural = characters.length * advance;
  const stretch = textLength !== undefined && natural > 0 ? textLength / (natural / scale) : 1;
  let startX = x * scale;
  if (anchor === 'middle') startX -= (natural * stretch) / 2;
  else if (anchor === 'end') startX -= natural * stretch;
  const top = baseline === 'middle' ? y * scale - capHeight / 2 : y * scale - capHeight;
  const strokeWidth = Math.max(0.7, fontSize * 0.11) * scale;
  const subpaths = [];
  const missing = [];
  for (let i = 0; i < characters.length; i++) {
    const glyph = GLYPHS[characters[i]];
    const originX = startX + i * advance * stretch;
    if (glyph === undefined) {
      missing.push(characters[i]);
      continue;
    }
    if (glyph === '') continue;
    for (const subpath of pathToSubpaths(glyph, unit)) {
      subpaths.push({
        closed: subpath.closed,
        points: subpath.points.map(([gx, gy]) => [originX + gx * stretch, top + gy]),
      });
    }
  }
  return { subpaths, missing, advance: natural * stretch, strokeWidth };
}

// ── SVG document parsing ────────────────────────────────────────────────────

const SELF_CLOSING = new Set(['rect', 'line', 'circle', 'ellipse', 'polygon', 'polyline', 'path', 'use', 'image']);
const NON_DRAWING = new Set(['title', 'desc', 'metadata', 'defs', 'style', 'g', 'svg']);

function parseAttributes(raw) {
  const attributes = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) attributes[match[1]] = match[2];
  return attributes;
}

function decodeEntities(text) {
  return String(text)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Flatten one `<text>` element into positioned runs.
 *
 * A run is `{text, attributes, x, y}`. With no `<tspan>` children the whole
 * element body is a single run that inherits the element's own x/y (the common
 * case, and what every renderer emitted before v20). With `<tspan>` children
 * each span is its own run: its `x`/`y` win, and otherwise it stays on the
 * element's baseline, with `dy` (and `dx`) applied as a relative offset — the
 * mechanism this subset uses to stack a wrapped label onto several lines.
 *
 * Deliberately NOT implemented, and reported instead: `rotate` on a tspan, and
 * a tspan that itself contains another tspan. Drawing them approximately would
 * put glyphs in the wrong place while looking fine, which this module never
 * does.
 *
 * @returns {{runs: Array, unsupported: string[]}}
 */
function flattenSpanRuns(element) {
  const spans = element.spans ?? [];
  if (spans.length === 0) {
    return {
      runs: [{ text: element.text ?? '', attributes: {}, x: finiteOr(element.attributes?.x, 0), y: finiteOr(element.attributes?.y, 0) }],
      unsupported: [],
    };
  }
  const unsupported = [];
  const baseX = (value) => (value === undefined ? finiteOr(element.attributes?.x, 0) : finiteOr(value, 0));
  const baseY = (value) => (value === undefined ? finiteOr(element.attributes?.y, 0) : finiteOr(value, 0));
  let cursorX = baseX(undefined);
  let cursorY = baseY(undefined);
  const runs = [];
  for (const span of spans) {
    const dx = finiteOr(span.attributes?.dx, 0);
    const dy = finiteOr(span.attributes?.dy, 0);
    if (span.children !== undefined) unsupported.push('<tspan> nested in <tspan>');
    if (span.attributes?.transform !== undefined) unsupported.push('transform on <tspan>');
    // An explicit x/y restarts the cursor (absolute placement); otherwise the
    // cursor advances by dx/dy (relative placement). This mirrors SVG's own
    // rule closely enough for the layouts this subset supports, and the two
    // forms the renderers emit — absolute per line, or dy steps — both land
    // where they should.
    cursorX = span.attributes?.x === undefined ? cursorX + dx : baseX(span.attributes.x);
    cursorY = span.attributes?.y === undefined ? cursorY + dy : baseY(span.attributes.y);
    runs.push({
      text: span.text ?? '',
      attributes: span.attributes ?? {},
      x: cursorX,
      y: cursorY,
    });
  }
  return { runs, unsupported };
}

/**
 * Parse the SVG document into its root geometry and a flat element stream.
 * The documents this package emits have no nested groups, so a flat scan is
 * both sufficient and simpler than a full XML tree. `<text>` is the one place
 * nesting is supported (`<tspan>` runs), because that is how a long label is
 * broken over several lines.
 */
function parseSvgDocument(svg) {
  const tagPattern = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const root = { attributes: {}, viewBox: undefined };
  const elements = [];
  const unsupported = [];
  let pendingText;
  let match;
  /**
   * Capture the body between `contentStart` and `end` as a run of the pending
   * span. An element body that is entirely whitespace is skipped UNLESS it is
   * the only run — that keeps the indentation of a hand-written `<text>` from
   * becoming a leading blank line, while still emitting `''` for an empty
   * element.
   */
  const flushPending = (end) => {
    if (pendingText === undefined || pendingText.spans === undefined || pendingText.contentStart === undefined) return;
    const raw = svg.slice(pendingText.contentStart, end);
    if (raw.trim() !== '' || pendingText.spans.length === 0) {
      pendingText.spans.push({ attributes: undefined, text: decodeEntities(raw) });
    }
    pendingText.contentStart = end;
  };
  while ((match = tagPattern.exec(svg)) !== null) {
    const closing = match[1] === '/';
    const rawName = match[2];
    const name = rawName.toLowerCase();
    // A `<tspan>` opens a new run inside the enclosing `<text>`. It is handled
    // before the generic closing logic so that both `<tspan>text</tspan>` and
    // the self-closing `<tspan .../>` (an empty run, which can carry a dy and
    // so matters for line breaks) become runs.
    if (name === 'tspan' && !closing && pendingText?.spans !== undefined) {
      flushPending(match.index);
      const span = { attributes: parseAttributes(match[3]), text: '', children: undefined };
      pendingText.spans.push(span);
      pendingText.currentSpan = span;
      if (match[4] === '/') pendingText.currentSpan = undefined;
      // Advance the cursor past this opening tag in both forms, so the next
      // flush measures from the right place.
      pendingText.contentStart = tagPattern.lastIndex;
      continue;
    }
    if (closing && name === 'tspan' && pendingText?.currentSpan !== undefined) {
      flushPending(match.index);
      pendingText.currentSpan = undefined;
      // CRITICAL: move the cursor past `</tspan>`. Without this the next
      // flush would slice from inside the tag it just consumed and capture the
      // literal "</tspan>" as the next run's text.
      pendingText.contentStart = tagPattern.lastIndex;
      continue;
    }
    if (closing) {
      if (name === 'text' && pendingText?.spans !== undefined && pendingText.attributes !== undefined) {
        flushPending(match.index);
        elements.push({ name: 'text', attributes: pendingText.attributes, text: '', spans: pendingText.spans });
        pendingText = undefined;
      }
      continue;
    }
    if (pendingText !== undefined && pendingText.attributes !== undefined && pendingText.name === 'text') {
      // Any other tag inside <text> (e.g. a nested <text>): refuse to guess.
      unsupported.push(`<${rawName}> in <text>`);
    }
    const attributes = parseAttributes(match[3]);
    if (name === 'svg') {
      root.attributes = attributes;
      continue;
    }
    if (name === 'text') {
      pendingText = { name, attributes, contentStart: tagPattern.lastIndex, spans: [], currentSpan: undefined };
      continue;
    }
    if (name === 'g') {
      // The renderers in this package emit flat documents; a group would carry
      // a transform this subset does not compose, so say so instead of drawing
      // its children in the wrong place.
      unsupported.push('<g>');
      pendingText = { name, attributes: undefined, contentStart: tagPattern.lastIndex };
      continue;
    }
    if (NON_DRAWING.has(name)) {
      pendingText = { name, attributes: undefined, contentStart: tagPattern.lastIndex };
      continue;
    }
    if (match[4] === '/' || SELF_CLOSING.has(name)) {
      elements.push({ name, attributes });
      continue;
    }
    // Report the original spelling: a `<linearGradient>` is easier to find than
    // a lower-cased `<lineargradient>`.
    unsupported.push(`<${rawName}>`);
    pendingText = { name, attributes: undefined, contentStart: tagPattern.lastIndex };
  }
  return { root, elements, unsupported };
}

function resolveCanvasSize(root) {
  const viewBox = (root.viewBox ?? root.attributes.viewBox)?.trim().split(/[\s,]+/).map(Number);
  const parseLength = (value) => {
    if (value === undefined) return undefined;
    const text = String(value).trim();
    if (text.endsWith('%')) return undefined;
    const number = Number.parseFloat(text);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };
  const boxWidth = viewBox !== undefined && viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : undefined;
  const boxHeight = viewBox !== undefined && viewBox.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : undefined;
  const width = parseLength(root.attributes.width) ?? boxWidth;
  const height = parseLength(root.attributes.height) ?? boxHeight;
  if (width === undefined || height === undefined) {
    throw new MolbioInputError('cannot rasterize this SVG: it declares neither width/height nor a viewBox');
  }
  return { width: Math.round(width), height: Math.round(height), viewBox };
}

function parseTransform(value) {
  if (value === undefined) return undefined;
  const rotate = /rotate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+))?\s*\)/.exec(value);
  if (rotate !== null) {
    return {
      angle: (Number.parseFloat(rotate[1]) * Math.PI) / 180,
      cx: rotate[2] === undefined ? 0 : Number.parseFloat(rotate[2]),
      cy: rotate[3] === undefined ? 0 : Number.parseFloat(rotate[3]),
    };
  }
  return undefined;
}

function applyTransform(points, transform, scale) {
  if (transform === undefined) return points;
  const cos = Math.cos(transform.angle);
  const sin = Math.sin(transform.angle);
  return points.map(([x, y]) => {
    const dx = x - transform.cx * scale;
    const dy = y - transform.cy * scale;
    return [transform.cx * scale + dx * cos - dy * sin, transform.cy * scale + dx * sin + dy * cos];
  });
}

function finiteOr(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Resolve an SVG length, honouring the `%` forms the renderers use for
 * full-canvas rectangles (`width="100%"`).
 */
function resolveLength(value, reference) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (text.endsWith('%')) {
    const percent = Number.parseFloat(text);
    return Number.isFinite(percent) ? (percent / 100) * reference : undefined;
  }
  return finiteOr(text, undefined);
}

function paintFor(attributes) {
  const fill = parseColor(attributes.fill ?? 'black');
  const stroke = parseColor(attributes.stroke);
  const strokeWidth = Number.parseFloat(attributes['stroke-width'] ?? '1');
  const dash = attributes['stroke-dasharray'] === undefined || attributes['stroke-dasharray'] === 'none'
    ? undefined
    : (attributes['stroke-dasharray'].match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number).filter((value) => Number.isFinite(value));
  return {
    fill,
    fillAlpha: finiteOr(attributes['fill-opacity'], 1),
    stroke,
    strokeAlpha: finiteOr(attributes['stroke-opacity'], 1),
    strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 1,
    hasStroke: attributes.stroke !== undefined,
    hasFill: attributes.fill !== undefined,
    dash: dash !== undefined && dash.length > 0 && dash.some((value) => value > 0) ? dash : undefined,
    linecap: attributes['stroke-linecap'],
  };
}

function drawElement(context, element) {
  const { canvas, scale, missingGlyphs } = context;
  const attributes = element.attributes;
  const paint = paintFor(attributes);
  const number = (key, fallback = 0) => finiteOr(attributes[key], fallback);
  const dash = paint.dash?.map((value) => value * scale);
  // A paint this subset cannot express (`url(#gradient)`, `currentColor`, …)
  // must be reported: drawing nothing and saying nothing is how a picture
  // quietly loses a feature.
  for (const key of ['fill', 'stroke']) {
    const value = attributes[key];
    if (value === undefined || paint[key] !== undefined) continue;
    const text = String(value).trim().toLowerCase();
    if (text === 'none' || text === 'transparent') continue;
    context.unsupported.push(`${key}="${value}"`);
  }
  switch (element.name) {
    case 'rect': {
      const x = number('x');
      const y = number('y');
      const width = resolveLength(attributes.width, canvas.width / scale);
      const height = resolveLength(attributes.height, canvas.height / scale);
      if (!(width > 0) || !(height > 0)) return;
      const polygon = roundedRectPolygon(x * scale, y * scale, width * scale, height * scale, number('rx') * scale, scale);
      if (paint.fill !== undefined) fillPolygon(canvas, polygon, paint.fill, paint.fillAlpha);
      if (paint.hasStroke && paint.stroke !== undefined) {
        strokePolyline(canvas, [...polygon, polygon[0]], { color: paint.stroke, alpha: paint.strokeAlpha, width: paint.strokeWidth * scale, scale, linecap: paint.linecap, dash });
      }
      return;
    }
    case 'line': {
      strokePolyline(canvas, [[number('x1') * scale, number('y1') * scale], [number('x2') * scale, number('y2') * scale]], {
        color: paint.stroke,
        alpha: paint.strokeAlpha,
        width: paint.strokeWidth * scale,
        scale,
        linecap: paint.linecap,
        dash,
      });
      return;
    }
    case 'circle': {
      const cx = number('cx') * scale;
      const cy = number('cy') * scale;
      const r = number('r') * scale;
      if (paint.fill !== undefined) fillCircle(canvas, cx, cy, r, paint.fill, paint.fillAlpha, scale);
      if (paint.hasStroke && paint.stroke !== undefined) {
        const ring = circlePolygon(cx, cy, r, scale);
        strokePolyline(canvas, [...ring, ring[0]], { color: paint.stroke, alpha: paint.strokeAlpha, width: paint.strokeWidth * scale, scale, linecap: paint.linecap, dash });
      }
      return;
    }
    case 'polygon':
    case 'polyline': {
      const points = parsePoints(attributes.points).map(([x, y]) => [x * scale, y * scale]);
      if (points.length < 2) return;
      if (element.name === 'polygon' && paint.fill !== undefined) fillPolygon(canvas, points, paint.fill, paint.fillAlpha);
      // A polyline is never filled (SVG would only fill it if closed); it is
      // stroked only when the document actually declares a stroke.
      if (paint.hasStroke && paint.stroke !== undefined) {
        const line = element.name === 'polygon' ? [...points, points[0]] : points;
        strokePolyline(canvas, line, { color: paint.stroke, alpha: paint.strokeAlpha, width: paint.strokeWidth * scale, scale, linecap: paint.linecap, dash });
      }
      return;
    }
    case 'path': {
      const subpaths = pathToSubpaths(attributes.d ?? '', scale);
      // Only an explicit fill paints the interior: an open path with no fill
      // attribute would otherwise smear an implicit closing wedge across the
      // figure.
      if (paint.hasFill && paint.fill !== undefined) fillPolygon(canvas, subpaths.flatMap((subpath) => subpath.points), paint.fill, paint.fillAlpha);
      if (paint.hasStroke && paint.stroke !== undefined) {
        strokeSubpaths(canvas, subpaths, { color: paint.stroke, alpha: paint.strokeAlpha, width: paint.strokeWidth * scale, scale, linecap: paint.linecap, dash });
      }
      return;
    }
    case 'text': {
      // A `<text>` is one or more runs: its own body, or one run per `<tspan>`.
      // Each run is drawn on its own baseline, which is what makes a multi-line
      // label possible (a long leaf name in a tree, broken to fit its column).
      const { runs, unsupported: spanUnsupported } = flattenSpanRuns(element);
      context.unsupported.push(...spanUnsupported);
      const transform = parseTransform(attributes.transform);
      for (const run of runs) {
        // tspan attributes override the parent element's, one property at a
        // time; a missing one falls through to the element default.
        const merged = { ...attributes, ...run.attributes };
        const fontSize = finiteOr(merged['font-size'], 16);
        const textLength = merged.textLength === undefined ? undefined : finiteOr(merged.textLength, undefined);
        const layout = layoutText(run.text, scale, {
          x: run.x,
          y: run.y,
          fontSize,
          anchor: merged['text-anchor'],
          baseline: merged['dominant-baseline'],
          textLength,
        });
        for (const character of layout.missing) missingGlyphs.add(character);
        const subpaths = transform === undefined ? layout.subpaths : layout.subpaths.map((subpath) => ({ closed: subpath.closed, points: applyTransform(subpath.points, transform, scale) }));
        // A tspan may carry its own `fill` (a highlighted label line); the
        // element's paint is the fallback.
        const runPaint = run.attributes?.fill === undefined ? paint : paintFor(merged);
        strokeSubpaths(canvas, subpaths, { color: runPaint.fill, alpha: runPaint.fillAlpha, width: layout.strokeWidth, scale, linecap: 'round' });
      }
      return;
    }
    default:
      context.unsupported.push(`<${element.name}>`);
  }
}

// ── public entry ────────────────────────────────────────────────────────────

/**
 * Rasterize one SVG document produced by this package into PNG bytes.
 * @param {string} svg - the SVG document text.
 * @param {{supersample?: number}} [options] - supersampling factor (default 2).
 * @returns {{data: Uint8Array, width: number, height: number, unsupported: string[], missing_glyphs: string[]}}
 */
export function renderSvgToPng(svg, options = {}) {
  if (typeof svg !== 'string' || !svg.includes('<svg')) {
    throw new MolbioInputError('renderSvgToPng needs an SVG document');
  }
  const supersample = Math.max(1, Math.min(4, Math.round(options.supersample ?? DEFAULT_SUPERSAMPLE)));
  const parsed = parseSvgDocument(svg);
  const { width, height, viewBox } = resolveCanvasSize(parsed.root);
  if (width * height > MAX_RASTER_PIXELS) {
    throw new MolbioInputError(`cannot rasterize a ${width}x${height} SVG (limit ${MAX_RASTER_PIXELS} pixels)`);
  }
  const originX = viewBox !== undefined && viewBox.length === 4 ? finiteOr(viewBox[0], 0) : 0;
  const originY = viewBox !== undefined && viewBox.length === 4 ? finiteOr(viewBox[1], 0) : 0;
  if (originX !== 0 || originY !== 0) {
    // Every document this package emits uses a zero-origin viewBox; a shifted
    // window would need a translation this subset deliberately does not carry.
    throw new MolbioInputError(`cannot rasterize this SVG: viewBox origin ${originX},${originY} is not supported`);
  }
  const canvas = new Canvas(width * supersample, height * supersample, [255, 255, 255]);
  const context = {
    canvas,
    scale: supersample,
    unsupported: [...parsed.unsupported],
    missingGlyphs: new Set(),
  };
  for (const element of parsed.elements) drawElement(context, element);
  return {
    data: encodePng({ width, height, rgb: canvas.downsample(supersample) }),
    width,
    height,
    unsupported: context.unsupported,
    missing_glyphs: [...context.missingGlyphs],
  };
}
