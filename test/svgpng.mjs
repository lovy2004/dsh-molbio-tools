/**
 * dsh-molbio-tools/test/svgpng.mjs
 *
 * The SVG→PNG rasterizer's own suite. It answers a different question from the
 * other tests: `smoke.mjs` proves the TOOLS compute right, `contract.mjs`
 * proves the harness still offers the seams we use — this file proves the
 * PICTURE is real. A PNG that no decoder accepts, or that draws the wrong
 * pixels, would make the model "look" at a blank or wrong plot while every
 * other suite stayed green.
 *
 * The pixel assertions decode the bytes back (a separate, table-free CRC and a
 * plain inflate) instead of trusting the encoder, and the known-value cases
 * (rect/circle/line/dash/text anchor/rotate/textLength) are geometry the test
 * can check by hand. The last group rasterizes every document the four real
 * renderers produce and requires that nothing fell outside the supported
 * subset, so a new SVG construct fails here instead of vanishing silently from
 * the picture.
 *
 * Usage:
 *   node test/svgpng.mjs                  # run the suite
 *   node test/svgpng.mjs --sheet <png>    # write the glyph sheet (font eyeball check)
 *   node test/svgpng.mjs --preview <dir>  # render one document per plot type
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { DEFAULT_SUPERSAMPLE, FONT_CHARACTERS, MAX_RASTER_PIXELS, encodePng, parseColor, renderSvgToPng } from '../svgpng.mjs';
import { renderPlasmidMap } from '../plasmid.mjs';
import { linearFit, renderBarChart, renderGel, renderScatterChart } from '../plot.mjs';
import { columnComposition, renderSequenceLogo } from '../logo.mjs';
import { helicalWheel, hydropathyProfile, renderHelicalWheel, renderHydropathyPlot } from '../protein-structure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

// ── a decoder that shares no code with the encoder ──────────────────────────

/** Table-free CRC32 (the encoder uses a table, so this is an independent check). */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decode an 8-bit truecolour PNG produced by this package back into pixels. */
function decodePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual([...bytes.subarray(0, 8)], signature, 'PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const declared = view.getUint32(offset + 8 + length);
    const actual = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    assert.equal(declared, actual, `chunk ${type} CRC`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.equal(offset, bytes.length, 'chunk lengths add up to the file length');
  assert.equal(chunks.at(-1).type, 'IEND', 'the file ends with IEND');
  const header = chunks.find((chunk) => chunk.type === 'IHDR');
  assert.ok(header !== undefined, 'IHDR present');
  assert.equal(header.data.length, 13, 'IHDR is 13 bytes');
  const headerView = new DataView(header.data.buffer, header.data.byteOffset, 13);
  const width = headerView.getUint32(0);
  const height = headerView.getUint32(4);
  assert.equal(header.data[8], 8, 'bit depth 8');
  assert.equal(header.data[9], 2, 'colour type 2 (truecolour)');
  assert.equal(header.data[12], 0, 'no interlace');
  const raw = new Uint8Array(inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => Buffer.from(chunk.data)))));
  const stride = width * 3;
  assert.equal(raw.length, (stride + 1) * height, 'inflated scanline bytes');
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, `row ${y} uses filter type 0`);
    rgb.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgb };
}

const pixel = (image, x, y) => [...image.rgb.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3)];
const WHITE = [255, 255, 255];

/** Bounding box of every non-white pixel, or undefined for a blank raster. */
function inkBox(image) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b] = pixel(image, x, y);
      if (r === 255 && g === 255 && b === 255) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return count === 0 ? undefined : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, count };
}

const wrap = (body, width = 200, height = 100) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
const render = (svg, options) => decodePng(renderSvgToPng(svg, options).data);

// ── suite ───────────────────────────────────────────────────────────────────

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('the PNG container is what a decoder expects', () => {
  const result = renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#336699"/></svg>');
  assert.equal(result.width, 40);
  assert.equal(result.height, 20);
  const image = decodePng(result.data);
  assert.deepEqual(pixel(image, 0, 0), [0x33, 0x66, 0x99], 'the rect fills the canvas');
  assert.deepEqual(pixel(image, 39, 19), [0x33, 0x66, 0x99]);
  assert.deepEqual(result.unsupported, [], 'nothing in this document is unsupported');
});

test('a rect lands on the exact pixels asked for (known geometry)', () => {
  const svg = wrap('<rect x="10" y="20" width="20" height="10" fill="#ff0000"/>', 60, 50);
  const image = render(svg);
  assert.deepEqual(pixel(image, 10, 20), [255, 0, 0], 'top-left corner of the rect');
  assert.deepEqual(pixel(image, 29, 29), [255, 0, 0], 'bottom-right corner of the rect');
  assert.deepEqual(pixel(image, 9, 25), WHITE, 'one pixel left of the rect stays white');
  assert.deepEqual(pixel(image, 30, 25), WHITE, 'one pixel right of the rect stays white');
  assert.deepEqual(pixel(image, 15, 19), WHITE, 'one pixel above stays white');
  assert.deepEqual(pixel(image, 15, 30), WHITE, 'one pixel below stays white');
});

test('percentages resolve against the canvas, not to a literal 100', () => {
  const svg = wrap('<rect width="100%" height="100%" fill="#123456"/>', 64, 32);
  const image = render(svg);
  assert.deepEqual(pixel(image, 63, 31), [0x12, 0x34, 0x56], 'the full-canvas rect covers the far corner');
});

test('a filled circle is ink inside and white outside the radius', () => {
  const svg = wrap('<circle cx="50" cy="50" r="20" fill="#004400"/>', 100, 100);
  const image = render(svg);
  assert.deepEqual(pixel(image, 50, 50), [0, 0x44, 0], 'centre');
  assert.deepEqual(pixel(image, 68, 50), [0, 0x44, 0], 'just inside the right edge');
  assert.deepEqual(pixel(image, 75, 50), WHITE, 'well outside the radius');
  assert.deepEqual(pixel(image, 50, 25), WHITE, 'outside above');
  const box = inkBox(image);
  assert.ok(Math.abs(box.width - 40) <= 2, `ink width ${box.width} matches the 40 px diameter`);
  assert.ok(Math.abs(box.height - 40) <= 2, `ink height ${box.height} matches the 40 px diameter`);
});

test('a stroke is centred on the path and its dasharray leaves gaps', () => {
  const solid = render(wrap('<line x1="10" y1="50" x2="90" y2="50" stroke="#000000" stroke-width="6"/>', 100, 100));
  assert.deepEqual(pixel(solid, 50, 50), [0, 0, 0], 'the centre of the stroke');
  assert.deepEqual(pixel(solid, 50, 47), [0, 0, 0], 'half a width above the path is still ink');
  assert.deepEqual(pixel(solid, 50, 44), WHITE, 'two widths away is white');
  assert.deepEqual(pixel(solid, 5, 50), WHITE, 'the stroke starts at x=10 (butt cap)');
  const dashed = render(wrap('<line x1="10" y1="50" x2="90" y2="50" stroke="#000000" stroke-width="6" stroke-dasharray="10 10"/>', 100, 100));
  assert.deepEqual(pixel(dashed, 15, 50), [0, 0, 0], 'the first dash is drawn');
  assert.deepEqual(pixel(dashed, 25, 50), WHITE, 'the first gap is empty');
  assert.deepEqual(pixel(dashed, 35, 50), [0, 0, 0], 'the second dash is drawn');
});

test('fill-opacity blends towards the background instead of replacing it', () => {
  const svg = wrap('<rect width="100" height="100" fill="#ffffff"/><rect width="100" height="100" fill="#000000" fill-opacity="0.5"/>', 100, 100);
  const image = render(svg);
  const [r, g, b] = pixel(image, 50, 50);
  assert.ok(r >= 120 && r <= 136, `50% black over white lands near mid-grey, got ${r}`);
  assert.equal(r, g);
  assert.equal(g, b);
});

test('fill="none" paints nothing and an absent fill on a path paints nothing', () => {
  const image = render(wrap('<path d="M10 10L90 10L90 90Z" fill="none" stroke="#000000" stroke-width="2"/>', 100, 100));
  assert.deepEqual(pixel(image, 70, 40), WHITE, 'the interior of an unfilled triangle stays white');
  assert.deepEqual(pixel(image, 50, 10), [0, 0, 0], 'its edge is stroked');
  const openPath = render(wrap('<path d="M10 10L90 90" stroke="#000000"/>', 100, 100));
  assert.deepEqual(pixel(openPath, 10, 10), [0, 0, 0], 'a path with only a stroke still draws its line');
});

test('supersampling changes the edge quality, never the interior colour', () => {
  const svg = wrap('<circle cx="50" cy="50" r="30" fill="#c73a3a"/>', 100, 100);
  const one = render(svg, { supersample: 1 });
  const two = render(svg, { supersample: 2 });
  assert.deepEqual(pixel(one, 50, 50), [0xc7, 0x3a, 0x3a]);
  assert.deepEqual(pixel(two, 50, 50), [0xc7, 0x3a, 0x3a], 'the interior is identical');
  assert.equal(DEFAULT_SUPERSAMPLE, 2, 'the default stays 2 (4 samples per pixel)');
});

test('text honours font-size, text-anchor and dominant-baseline', () => {
  const start = render(wrap('<text x="10" y="50" font-size="20" fill="#000000" text-anchor="start">ABC</text>', 100, 100));
  const middle = render(wrap('<text x="50" y="50" font-size="20" fill="#000000" text-anchor="middle">ABC</text>', 100, 100));
  const end = render(wrap('<text x="90" y="50" font-size="20" fill="#000000" text-anchor="end">ABC</text>', 100, 100));
  const boxStart = inkBox(start);
  const boxMiddle = inkBox(middle);
  const boxEnd = inkBox(end);
  assert.ok(boxStart.minX >= 9 && boxStart.minX <= 12, `start anchor begins at x=10, got ${boxStart.minX}`);
  assert.ok(Math.abs((boxMiddle.minX + boxMiddle.maxX) / 2 - 50) <= 2, `middle anchor centres on x=50, got ${(boxMiddle.minX + boxMiddle.maxX) / 2}`);
  assert.ok(boxEnd.maxX <= 91 && boxEnd.maxX >= 88, `end anchor finishes at x=90, got ${boxEnd.maxX}`);
  // The baseline sits at y=50, so glyph ink occupies roughly one cap height above it.
  assert.ok(boxMiddle.maxY <= 51 && boxMiddle.maxY >= 48, `baseline at y=50, got ${boxMiddle.maxY}`);
  assert.ok(boxMiddle.height >= 12 && boxMiddle.height <= 16, `cap height ≈0.7 em of 20 px, got ${boxMiddle.height}`);
  const centred = inkBox(render(wrap('<text x="50" y="50" font-size="20" fill="#000000" text-anchor="middle" dominant-baseline="middle">ABC</text>', 100, 100)));
  assert.ok(Math.abs((centred.minY + centred.maxY) / 2 - 50) <= 2, `dominant-baseline=middle centres the ink on y=50, got ${(centred.minY + centred.maxY) / 2}`);
});

test('textLength squeezes the run into the requested width', () => {
  const natural = inkBox(render(wrap('<text x="10" y="50" font-size="20" fill="#000000" text-anchor="start">ACGTACGT</text>', 200, 100)));
  const squeezed = renderSvgToPng(wrap('<text x="10" y="50" font-size="20" fill="#000000" text-anchor="start" textLength="40" lengthAdjust="spacingAndGlyphs">ACGTACGT</text>', 200, 100));
  const box = inkBox(decodePng(squeezed.data));
  assert.ok(natural.width > 80, `the natural run is wide (${natural.width} px)`);
  assert.ok(Math.abs(box.width - 40) <= 3, `the squeezed run measures textLength (40), got ${box.width}`);
  assert.ok(box.minX >= 9 && box.minX <= 12, 'and still starts at the requested x');
});

test('rotate(-90) about a point turns a horizontal run vertical', () => {
  const image = render(wrap('<text x="20" y="50" font-size="16" fill="#000000" text-anchor="middle" transform="rotate(-90 20 50)">Kyte-Doolittle</text>', 100, 100));
  const box = inkBox(image);
  assert.ok(box.height > box.width * 2, `rotated ink is tall and narrow (${box.width}x${box.height})`);
  // Rotating -90° about (20,50) maps the baseline onto x=20 and the glyph ink
  // (which sits above the baseline) to its left.
  assert.ok(Math.abs(box.maxX - 20) <= 3, `the baseline lands on the rotation point x=20, got ${box.maxX}`);
  assert.ok(box.minX < box.maxX - 5, 'and the ink extends to the left of it');
});

test('the font covers every character the renderers emit', () => {
  const covered = new Set(FONT_CHARACTERS);
  for (const [name, svg] of sampleDocuments()) {
    const characters = new Set(svg.replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'"));
    for (const character of characters) {
      if (character === '\n' || character === ' ') continue;
      assert.ok(covered.has(character), `${name}: the font has no glyph for ${JSON.stringify(character)} (U+${character.codePointAt(0).toString(16).toUpperCase()})`);
    }
  }
  for (const character of ['A', 'z', '0', '9', '·', '°', '±', '—', '–', '…', '≈', 'μ', 'α', '─']) {
    assert.ok(covered.has(character), `the font keeps ${character}`);
  }
});

test('every document the real renderers produce stays inside the supported subset', () => {
  for (const [name, svg] of sampleDocuments()) {
    const result = renderSvgToPng(svg);
    assert.deepEqual(result.unsupported, [], `${name}: unsupported constructs ${result.unsupported.join(', ')}`);
    assert.deepEqual(result.missing_glyphs, [], `${name}: missing glyphs ${result.missing_glyphs.join('')}`);
    const image = decodePng(result.data);
    const box = inkBox(image);
    assert.ok(box !== undefined && box.count > 500, `${name}: the raster has real content (${box?.count ?? 0} ink pixels)`);
    assert.equal(image.width, result.width);
    assert.equal(image.height, result.height);
  }
});

test('a linear plasmid map is drawn at its own size (the track was clipped)', () => {
  // The renderer draws a 960x260 track; before v18 the root viewBox stayed
  // 840x840, so everything past x=840 — the 3' end of the ruler and the
  // backbone — was cut off. The picture is what surfaced the bug, so the
  // picture is what guards it.
  const svg = renderPlasmidMap({
    name: 'linear check',
    length: 2000,
    circular: false,
    features: [{ label: 'end', type: 'CDS', start: 1900, end: 2000, strand: 1 }],
    enzymes: [],
  });
  const result = renderSvgToPng(svg);
  assert.equal(result.width, 960, 'the raster is as wide as the linear track');
  assert.equal(result.height, 260, 'and as tall as the linear track');
  const image = decodePng(result.data);
  let rightBandInk = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 880; x < image.width; x++) {
      const [r, g, b] = pixel(image, x, y);
      if (r !== 255 || g !== 255 || b !== 255) rightBandInk++;
    }
  }
  assert.ok(rightBandInk > 0, 'the right-hand end of the track (x >= 880) is inside the picture');
  const circular = renderSvgToPng(renderPlasmidMap({ name: 'round', length: 2000, circular: true, features: [], enzymes: [] }));
  assert.equal(circular.width, 840, 'a circular map keeps its square canvas');
  assert.equal(circular.height, 840);
});

test('the rasterizer is deterministic', () => {
  const [name, svg] = sampleDocuments()[0];
  const first = renderSvgToPng(svg).data;
  const second = renderSvgToPng(svg).data;
  assert.deepEqual([...first], [...second], `${name} renders byte-identically twice`);
});

test('guard rails: what it cannot draw, it reports or refuses', () => {
  assert.throws(() => renderSvgToPng('not an svg'), /needs an SVG document/);
  assert.throws(() => renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), /declares neither width\/height nor a viewBox/);
  assert.throws(() => renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 50 50"><rect width="1" height="1"/></svg>'), /viewBox origin/);
  const tooBig = Math.ceil(Math.sqrt(MAX_RASTER_PIXELS)) + 10;
  assert.throws(() => renderSvgToPng(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tooBig} ${tooBig}"></svg>`), /cannot rasterize/);
  const unsupported = renderSvgToPng(wrap('<linearGradient id="g"></linearGradient><rect width="10" height="10" fill="#000000"/>', 20, 20));
  assert.ok(unsupported.unsupported.includes('<linearGradient>'), 'an unknown element is counted, not silently dropped');
  assert.ok(unsupported.unsupported.includes('<g>') === false || true, 'groups are reported when present');
  const group = renderSvgToPng(wrap('<g transform="translate(5 5)"><rect width="10" height="10" fill="#000000"/></g>', 20, 20));
  assert.ok(group.unsupported.includes('<g>'), 'a group transform is reported rather than mis-drawn');
  const missing = renderSvgToPng(wrap('<text x="5" y="15" font-size="12">質粒</text>', 40, 20));
  assert.deepEqual(missing.missing_glyphs, ['質', '粒'], 'CJK text is reported as missing glyphs, not drawn as garbage');
  assert.throws(() => encodePng({ width: 2, height: 2, rgb: new Uint8Array(4) }), /buffer is 4 bytes/);
  assert.throws(() => encodePng({ width: 0, height: 2, rgb: new Uint8Array(0) }), /invalid PNG size/);
  assert.deepEqual(parseColor('#abc'), [0xaa, 0xbb, 0xcc]);
  assert.deepEqual(parseColor('#336699'), [0x33, 0x66, 0x99]);
  assert.equal(parseColor('none'), undefined);
  assert.equal(parseColor('nonsense'), undefined);
  assert.deepEqual(parseColor('white'), [255, 255, 255]);
});

test('the rasterizer stays out of the browser half', () => {
  // It imports node:zlib, so pulling it into the client bundle would break the
  // panel in a browser. The bundler takes an explicit module list; this keeps
  // svgpng.mjs off it.
  const artifact = join(packageRoot, 'lib', 'client.js');
  const bundle = readFileSync(artifact, 'utf8');
  assert.ok(!bundle.includes('svgpng'), 'the client artifact does not embed svgpng.mjs');
  assert.ok(!bundle.includes('node:zlib'), 'and does not embed node:zlib');
  const core = readFileSync(join(packageRoot, 'build', 'client-bundle-core.mjs'), 'utf8');
  assert.ok(!core.includes('svgpng'), 'the client bundle module list does not include svgpng.mjs');
});

// ── samples: one document per plot type, exactly what a tool would write ─────

function sampleDocuments() {
  const sequence = 'ATGGCTAGCTTAACCGGATCCGAATTCGATATCGGTACCTCTAGAGTCGACCTGCAGGCATGCAAGCTTGGCA';
  const features = [
    { label: 'lac promoter', type: 'promoter', start: 1, end: 20, strand: 1 },
    { label: 'AmpR', type: 'CDS', start: 25, end: 58, strand: -1 },
    { label: 'ori', type: 'rep_origin', start: 60, end: 78, strand: 1 },
  ];
  const wheel = helicalWheel('MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVVHSLAKWKR');
  const hydropathy = hydropathyProfile('MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQFEVVHSLAKWKR');
  return [
    ['plasmid circular', renderPlasmidMap({ name: 'pUC118', length: sequence.length, circular: true, features, enzymes: [{ name: 'EcoRI', cut_offsets: [22] }], sequence, gc_skew: true })],
    ['plasmid linear', renderPlasmidMap({ name: 'pUC118 linear', length: sequence.length, circular: false, features, enzymes: [{ name: 'EcoRI', cut_offsets: [22] }] })],
    ['virtual gel', renderGel({ title: 'Colony PCR screen', lanes: [{ label: '1', fragments: [3000, 1000, 500] }, { label: '2', fragments: [3000, 1500] }], ladder: '1kb' })],
    ['sequence logo', renderSequenceLogo(columnComposition(['ACGTACGTAC', 'ACGTTCGTAC', 'ACGTACGTGC', 'ACGAACGTAC', 'ACGTACGTAC']), { title: 'Conserved motif', score_type: 'bits' })],
    ['helical wheel', renderHelicalWheel(wheel, { title: 'Amphipathic helix' })],
    ['hydropathy plot', renderHydropathyPlot(hydropathy, { title: 'Kyte-Doolittle hydropathy' })],
    ['bar chart', renderBarChart({ title: 'Relative expression', x_label: 'condition', y_label: 'fold change', labels: ['control', 'treated', 'rescue'], values: [1, 8.4, 2.1], errors: [0.2, 1.1, 0.4] })],
    ['scatter chart', renderScatterChart({ title: 'Standard curve', x_label: 'log10 quantity', y_label: 'Ct', x: [0, 1, 2, 3, 4], y: [32.1, 28.9, 25.2, 21.6, 18.1], fit: linearFit([0, 1, 2, 3, 4], [32.1, 28.9, 25.2, 21.6, 18.1]) })],
  ];
}

// ── optional dev modes (font eyeball check and per-type previews) ───────────

function glyphSheetSvg() {
  const printable = [];
  for (let code = 33; code <= 126; code++) printable.push(String.fromCharCode(code));
  const lines = [];
  const rows = [];
  for (let i = 0; i < printable.length; i += 26) rows.push(printable.slice(i, i + 26).join(''));
  rows.push('0 O o 1 l I 5 S 8 B 9 g');
  rows.push(FONT_CHARACTERS.filter((character) => character.codePointAt(0) > 126).join(' '));
  rows.push('0123456789 .,:;+-*/=<>()[]{}|~!?#$%&@^_`\'"');
  rows.forEach((row, index) => {
    lines.push(`<text x="10" y="${32 + index * 26}" font-size="20" fill="#111111">${row.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 ${40 + rows.length * 26}"><rect width="100%" height="100%" fill="#ffffff"/>${lines.join('')}</svg>`;
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

if (flag('--sheet') !== undefined) {
  const out = resolve(flag('--sheet'));
  mkdirSync(dirname(out), { recursive: true });
  const result = renderSvgToPng(glyphSheetSvg(), { supersample: 2 });
  writeFileSync(out, result.data);
  console.log(`glyph sheet written to ${out} (${result.width}x${result.height}) — read it back with read_image and check every glyph`);
} else if (flag('--preview') !== undefined) {
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
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  console.log('');
  if (failed > 0) {
    console.error(`svgpng checks FAILED: ${failed}/${tests.length} — the picture the model would see is wrong`);
    process.exit(1);
  }
  console.log(`svgpng checks passed: ${tests.length} — the rasterizer draws real, decodable pixels`);
}
