/**
 * dsh-molbio-tools/test/svgio.mjs
 *
 * The shared drawing helpers (v19) must produce documents the rasterizer can
 * actually turn into pixels — because those pixels are what `attach_image`
 * hands to the model. `svgpng.mjs` reports anything it cannot draw in
 * `unsupported` / `missing_glyphs`; this suite asserts those stay EMPTY for
 * every helper, and pins the geometry the helpers promise (scales, ticks,
 * panel insets, axis labels, series points).
 *
 * Usage: node test/svgio.mjs
 */
import assert from 'node:assert/strict';

import { renderSvgToPng } from '../svgpng.mjs';
import {
  axis,
  circle,
  escapeXml,
  formatTick,
  greyRamp,
  indexScale,
  legendRow,
  line,
  linearScale,
  niceTicks,
  panel,
  polyline,
  qualityColor,
  rect,
  round,
  series,
  svgDocument,
  textRun,
} from '../svgio.mjs';

let passed = 0;
function ok(name, run) {
  run();
  passed++;
  console.log(`  ok   ${name}`);
}

console.log('svgio checks');

ok('escapes exactly the five XML characters and nothing else', () => {
  assert.equal(escapeXml(`<a & b > c "d" 'e'`), '&lt;a &amp; b &gt; c &quot;d&quot; &apos;e&apos;');
  assert.equal(escapeXml('A1234_+:;()[]{}'), 'A1234_+:;()[]{}');
});

ok('rounds without float noise and refuses to emit NaN', () => {
  // 1.005 is stored just BELOW its decimal value, so it rounds down: that is
  // IEEE-754, not a bug in `round`, and it is harmless at pixel scale.
  assert.equal(round(1.005, 2), 1);
  assert.equal(round(2.675, 2), 2.68);
  assert.equal(round(0.1 + 0.2, 2), 0.3);
  assert.equal(round(Number.NaN), 0);
  assert.equal(round(Number.POSITIVE_INFINITY), 0);
  assert.equal(round(2.5, 0), 3);
});

ok('formats ticks as integers or short decimals', () => {
  assert.equal(formatTick(12), '12');
  assert.equal(formatTick(12.34567), '12.346');
  assert.equal(formatTick(Number.NaN), '0');
});

ok('linearScale honours an inverted pixel range', () => {
  const normal = linearScale([0, 10], [0, 100]);
  assert.equal(normal.of(0), 0);
  assert.equal(normal.of(5), 50);
  assert.equal(normal.of(10), 100);
  assert.equal(normal.invert(50), 5);
  const inverted = linearScale([0, 10], [200, 0]);
  assert.equal(inverted.of(0), 200);
  assert.equal(inverted.of(10), 0);
  assert.equal(inverted.of(2.5), 150);
  const flat = linearScale([5, 5], [0, 100]);
  assert.equal(flat.of(5), 0, 'a zero-width domain collapses to the low end rather than NaN');
});

ok('niceTicks returns round numbers that cover the domain', () => {
  assert.deepEqual(niceTicks([0, 10], 5), [0, 2, 4, 6, 8, 10], 'keeps the finer round step instead of rounding up to 5');
  assert.deepEqual(niceTicks([0, 1], 3), [0, 0.5, 1]);
  assert.deepEqual(niceTicks([1, 40], 3), [10, 20, 30, 40], 'a coarse step still lands on round values inside the domain');
  assert.deepEqual(niceTicks([0, 100], 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks([-3, 7], 4), [-2, 0, 2, 4, 6], 'negative domains tick on the same round grid');
  assert.deepEqual(niceTicks([3, 3], 5), [3], 'a degenerate domain yields one tick');
  for (const domain of [[0, 10], [0, 1], [1, 40], [0, 100], [-3, 7]]) {
    const ticks = niceTicks(domain, 5);
    assert.ok(ticks.every((tick) => tick >= domain[0] - 1e-9 && tick <= domain[1] + 1e-9), `ticks stay inside ${domain}`);
    assert.ok(ticks.length >= 2, `at least two ticks for ${domain}`);
  }
});

ok('indexScale spans the full axis edge-to-edge and inverts', () => {
  const scale = indexScale(5, [0, 100]);
  assert.equal(scale.of(0), 0);
  assert.equal(scale.of(4), 100);
  assert.equal(scale.of(2), 50);
  assert.equal(scale.width, 25);
  assert.equal(scale.invert(100), 4, 'the round trip recovers the index');
  assert.equal(scale.invert(0), 0);
  const single = indexScale(1, [0, 100]);
  assert.equal(single.of(0), 0);
  assert.equal(single.invert(0), 0, 'a one-point series has no span to invert');
});

ok('panel returns the inner plot rectangle after its insets', () => {
  const { markup, plot, bottom } = panel({ x: 10, y: 20, width: 200, height: 120, title: 'T', subtitle: 'S' });
  assert.deepEqual(plot, { x: 56, y: 54, width: 140, height: 60 });
  assert.equal(bottom, 140);
  assert.ok(markup.includes('fill="#ffffff"'));
  assert.ok(markup.includes('>T</text>'));
  assert.ok(markup.includes('>S</text>'));
  const plain = panel({ x: 0, y: 0, width: 100, height: 100 });
  assert.ok(!plain.markup.includes('<text'), 'no title means no stray empty text element');
});

ok('textRun emits anchors, rotation, weighting and textLength only when asked', () => {
  assert.ok(textRun({ x: 1, y: 2, text: 'a' }).includes('x="1" y="2"'));
  assert.ok(!textRun({ x: 1, y: 2, text: 'a' }).includes('text-anchor'));
  assert.ok(textRun({ x: 1, y: 2, text: 'a', anchor: 'end' }).includes('text-anchor="end"'));
  const rotated = textRun({ x: 5, y: 6, text: 'a', rotate: -90 });
  assert.ok(rotated.includes('transform="rotate(-90 5 6)"'), 'rotation turns about the run point');
  assert.ok(textRun({ x: 1, y: 2, text: 'a', length: 40 }).includes('textLength="40" lengthAdjust="spacingAndGlyphs"'));
});

ok('line and rect omit optional attributes instead of emitting empty ones', () => {
  assert.equal(line({ x1: 0, y1: 0, x2: 1, y2: 1 }), '<line x1="0" y1="0" x2="1" y2="1" stroke="#24292f" stroke-width="1"/>');
  const dashed = line({ x1: 0, y1: 0, x2: 10, y2: 0, dash: [3, 2] });
  assert.ok(dashed.includes('stroke-dasharray="3 2"'));
  assert.ok(rect({ x: 0, y: 0, width: 10, height: 5 }).includes('fill="none"'));
  assert.ok(!rect({ x: 0, y: 0, width: 10, height: 5 }).includes('stroke='));
  assert.ok(rect({ x: 0, y: 0, width: -4, height: 5 }).includes('width="0"'), 'negative sizes clamp');
});

ok('polyline refuses a one-point run and polygon closes the ring', () => {
  assert.equal(polyline([[0, 0]]), '');
  assert.ok(polyline([[0, 0], [1, 1]], { closed: true }).startsWith('<polygon'));
  assert.ok(polyline([[0, 0], [1, 1]]).startsWith('<polyline'));
  assert.ok(!polyline([[0, 0], [1, 1]]).includes('stroke-width="undefined"'));
});

ok('axis places tick labels under an x axis and left of a y axis', () => {
  const x = axis({ from: 0, to: 100, at: 50, ticks: [0, 50, 100], title: 'position' });
  assert.ok(x.includes('x1="0" y1="50" x2="100" y2="50"'));
  assert.ok(x.includes('text-anchor="middle"'));
  assert.ok(x.includes('>position</text>'));
  const y = axis({ from: 0, to: 40, at: 30, ticks: [0, 20, 40], orientation: 'y', title: 'Phred' });
  assert.ok(y.includes('x1="30" y1="0" x2="30" y2="40"'));
  assert.ok(y.includes('text-anchor="end"'));
  assert.ok(y.includes('transform="rotate(-90 0 20)"'), 'the y title is rotated about its anchor');
});

ok('series maps raw values through the given scales', () => {
  const xOf = indexScale(3, [0, 100]).of;
  const yOf = linearScale([0, 10], [100, 0]).of;
  const markup = series({ values: [0, 5, 10], xOf, yOf });
  assert.ok(markup.includes('points="0,100 50,50 100,0"'), 'raw data in, pixels out');
});

ok('legendRow lays entries out with a gap and a swatch', () => {
  const markup = legendRow({ x: 0, y: 20, entries: [{ fill: '#ff0000', label: 'Q30' }, { stroke: '#00ff00', label: 'mean' }], gap: 40 });
  assert.ok(markup.includes('<rect x="0" y="12" width="9" height="9" fill="#ff0000"'));
  assert.ok(markup.includes('>Q30</text>'));
  assert.ok(markup.includes('<line x1="40"'));
  assert.ok(markup.includes('>mean</text>'));
});

ok('the colour ramps are total functions with hex output', () => {
  assert.equal(qualityColor(30), '#00a878');
  assert.equal(qualityColor(22), '#e8b400');
  assert.equal(qualityColor(5), '#d1242f');
  assert.equal(greyRamp(-5), '#ffffff');
  assert.equal(greyRamp(5), '#555555');
  assert.match(greyRamp(0.5), /^#[0-9a-f]{6}$/);
});

// ── the pixels: every helper's output must rasterize cleanly ─────────────────

ok('a document using every helper rasterizes with nothing unsupported', () => {
  const frame = panel({ x: 0, y: 0, width: 400, height: 200, title: 'panel', subtitle: 'subtitle' });
  const { plot } = frame;
  const xOf = indexScale(11, [plot.x, plot.x + plot.width]).of;
  const yOf = linearScale([0, 40], [plot.y + plot.height, plot.y]).of;
  const body = [
    frame.markup,
    axis({ from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height, ticks: niceTicks([0, 10], 5).map((t) => xOf(t)), title: 'position (bp)' }),
    axis({ from: plot.y, to: plot.y + plot.height, at: plot.x, ticks: niceTicks([0, 40], 5).map((t) => yOf(t)), orientation: 'y', title: 'Phred' }),
    series({ values: Array.from({ length: 11 }, (_, i) => i * 4), xOf, yOf, stroke: qualityColor(30) }),
    circle({ cx: 100, cy: 100, r: 6, fill: '#d1242f' }),
    rect({ x: 200, y: 40, width: 60, height: 30, fill: '#e8b400', fillOpacity: 0.3 }),
    line({ x1: 0, y1: 0, x2: 400, y2: 200, stroke: '#57606a', dash: [4, 4] }),
    polyline([[10, 10], [30, 10], [30, 30]], { closed: true, fill: '#0969da' }),
    legendRow({ x: 12, y: 190, entries: [{ fill: '#00a878', label: 'Q30+' }, { stroke: '#d1242f', label: 'Q20' }], gap: 60 }),
    textRun({ x: 380, y: 20, text: 'right', anchor: 'end' }),
    textRun({ x: 8, y: 100, text: 'sideways', rotate: -90 }),
  ].join('\n');
  const svg = svgDocument({ width: 400, height: 200, title: 'helper coverage', description: 'every svgio primitive', body });
  const raster = renderSvgToPng(svg);
  assert.deepEqual(raster.unsupported, [], 'nothing in the document is outside the rasterizer subset');
  assert.deepEqual(raster.missing_glyphs, [], 'and every glyph is in the built-in font');
  assert.equal(raster.width, 400);
  assert.equal(raster.height, 200);
  assert.ok(raster.data.length > 100, 'a real PNG came out');
});

ok('a document is deterministic and carries its title and description', () => {
  const build = () => svgDocument({ width: 40, height: 20, title: 't & t', description: 'd < 1', body: circle({ cx: 10, cy: 10, r: 4, fill: '#000000' }) });
  assert.equal(build(), build());
  assert.ok(build().includes('<title>t &amp; t</title>'));
  assert.ok(build().includes('<desc>d &lt; 1</desc>'));
});

console.log(`\nsvgio checks passed: ${passed} — the shared drawing helpers rasterize cleanly`);
