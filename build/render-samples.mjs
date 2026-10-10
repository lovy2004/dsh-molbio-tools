/**
 * Render one SVG per figure kind, so the typography can be reviewed in a viewer.
 *
 *   node build/render-samples.mjs <output-dir>
 *
 * Two sources are used on purpose:
 *  - the PLASMID map goes through `molbio_plasmid_map`'s real execute path (mock
 *    ctx + in-memory fs), so what lands on disk is exactly what the tool writes;
 *  - the rest call the renderers directly, because several of them are only
 *    reachable through tools that need heavy inputs (an .ab1 trace, a FASTQ
 *    file) that would not make a useful font sample.
 *
 * These files are for EYEBALLING typography. They are not a test fixture and
 * nothing asserts on them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { renderHistogram, renderBoxPlot, renderViolinPlot, renderLineChart, renderVolcanoPlot, renderHeatmap } from '../charts.mjs';
import { linearFit, renderBarChart, renderScatterChart, renderGel } from '../plot.mjs';
import { renderPlasmidMap } from '../plasmid.mjs';
import { columnComposition, renderSequenceLogo } from '../logo.mjs';
import { renderCompositionSvg, gcComposition } from '../composition.mjs';
import { renderFastqQcReport, fastqQcReport } from '../fastq-qc.mjs';
import { renderTreeSvg, distanceMatrix, neighbourJoiningTree } from '../phylo.mjs';
import { renderHydropathyPlot, renderHelicalWheel, hydropathyProfile, helicalWheel } from '../protein-structure.mjs';

const out = resolve(process.argv[2] ?? 'test/_svg-preview');
mkdirSync(out, { recursive: true });

const written = [];
const write = (name, svg) => {
  if (typeof svg !== 'string' || !svg.startsWith('<svg')) throw new Error(`${name}: not an SVG document`);
  writeFileSync(join(out, `${name}.svg`), svg);
  written.push({ name, bytes: Buffer.byteLength(svg, 'utf8') });
};

// ── charts (all eight kinds) ────────────────────────────────────────────────
write('chart-bar', renderBarChart({
  title: 'Relative expression',
  x_label: 'condition', y_label: 'fold change',
  labels: ['control', 'treated', 'rescue'],
  values: [1, 8.4, 2.1], errors: [0.2, 1.1, 0.4],
}));

write('chart-scatter', renderScatterChart({
  title: 'qPCR standard curve',
  x_label: 'log10 quantity', y_label: 'Ct',
  x: [0, 1, 2, 3, 4], y: [32.1, 28.9, 25.2, 21.6, 18.1],
  fit: linearFit([0, 1, 2, 3, 4], [32.1, 28.9, 25.2, 21.6, 18.1]),
}));

write('chart-line', renderLineChart({
  title: 'Growth curve',
  x_label: 'time (h)', y_label: 'OD600',
  series: [
    { label: 'wt', x: [0, 2, 4, 6, 8], y: [0.05, 0.21, 0.82, 1.41, 1.5] },
    { label: 'mutA', x: [0, 2, 4, 6, 8], y: [0.04, 0.11, 0.31, 0.52, 0.55] },
    { label: 'rescue', x: [0, 2, 4, 6, 8], y: [0.05, 0.19, 0.74, 1.28, 1.36] },
  ],
}).svg);

write('chart-histogram', renderHistogram({
  title: 'Insert size distribution',
  x_label: 'fragment size (bp)', y_label: 'reads',
  values: [100, 110, 120, 120, 130, 130, 130, 140, 140, 150, 150, 150, 150, 160, 170, 180, 200, 220, 260, 300, 380],
}).svg);

write('chart-box', renderBoxPlot({
  title: 'Ct by strain',
  x_label: 'strain', y_label: 'Ct',
  series: [
    { label: 'wt', values: [22.1, 22.4, 23.9, 22.8, 22.2, 22.6] },
    { label: 'ko', values: [19.4, 19.1, 19.8, 34.5, 19.3, 19.6] },
  ],
}).svg);

write('chart-violin', renderViolinPlot({
  title: 'Ct by strain (distribution shape)',
  x_label: 'strain', y_label: 'Ct',
  series: [
    { label: 'wt', values: [22.1, 22.4, 23.9, 22.8, 22.2, 22.6] },
    { label: 'ko', values: [19.4, 19.1, 19.8, 34.5, 19.3, 19.6] },
  ],
}).svg);

write('chart-volcano', renderVolcanoPlot({
  title: 'Differential expression',
  points: [
    { label: 'KRAS', log2fc: 2.5, p: 0.0001 },
    { label: 'EGFR', log2fc: 1.8, p: 0.01 },
    { label: 'MYC', log2fc: 0.3, p: 0.6 },
    { label: 'PTEN', log2fc: -0.2, p: 0.9 },
    { label: 'TP53', log2fc: -2.2, p: 0.002 },
    { label: 'BRCA1', log2fc: -1.9, p: 0.004 },
  ],
  label_top: 3,
}).svg);

write('chart-heatmap', renderHeatmap({
  title: 'Expression by gene (row z-score)',
  rows: ['KRAS', 'EGFR', 'MYC', 'TP53'],
  columns: ['ctrl1', 'ctrl2', 'ctrl3', 'kd1', 'kd2', 'kd3'],
  matrix: [
    [0.10, 0.20, 0.05, 2.10, 1.90, 2.30],
    [-0.30, -0.10, -0.20, 1.40, 1.20, 1.50],
    [0.05, -0.10, 0.10, 0.20, 0.10, 0.30],
    [-1.20, -1.10, -1.30, 0.40, 0.50, 0.30],
  ],
  scale: 'row_zscore',
  value_label: 'row z',
}).svg);

// ── other figures ───────────────────────────────────────────────────────────
write('gel', renderGel({
  title: 'Colony PCR screen',
  lanes: [
    { label: '1', fragments: [3000, 1000, 500] },
    { label: '2', fragments: [3000, 1500] },
    { label: '3', fragments: [4500] },
  ],
  ladder: '1kb',
}));

write('plasmid-map', renderPlasmidMap({
  name: 'pUC118-derived',
  length: 3162,
  circular: true,
  features: [
    { label: 'lacZ alpha', type: 'CDS', start: 1, end: 400, strand: 1 },
    { label: 'AmpR', type: 'CDS', start: 1000, end: 1860, strand: -1 },
    { label: 'ori', type: 'rep_origin', start: 2100, end: 2700, strand: 1 },
  ],
  enzymes: [
    { name: 'EcoRI', cut_offsets: [926] },
    { name: 'HindIII', cut_offsets: [875] },
  ],
  marks: [],
}));

write('sequence-logo', renderSequenceLogo(columnComposition([
  'ACGTACGTACGT',
  'ACGTACGTACGT',
  'ACGTTCGTACGT',
  'ACGTACGTACGA',
  'ACGTACGTTCGT',
]), { title: 'Splice acceptor consensus' }));

write('gc-composition', renderCompositionSvg(gcComposition(
  'ATGGCGCGCTATATATCGCGCGCGATATATCGCGCGCGATATATCGATCGGCTAGCTAGCTAGCATCGATCGATCGGCTAGCTAGCATCGATCGATATCGATCGCGCGCGATATATCGATCGGCTAGCATCGATCGATCGCGCGCGATATATCGATCG',
)));

write('hydropathy', renderHydropathyPlot(hydropathyProfile(
  'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQALKKLLKKLLKKLLKLLLLLLLLLLVVVVVVVVVVLLLLLLLLLLLLKKKKKKKK',
), { title: 'Kyte-Doolittle hydropathy' }));

write('helical-wheel', renderHelicalWheel(
  helicalWheel('LKKLLKKLLKKLLKKLLKKLLK'),
  { title: 'Amphipathic helix' },
));

// ── a phylogeny and a FASTQ report, which need derived inputs ────────────────
const sequences = [
  'ACGTACGTACGTACGTACGT',
  'ACGTACGTACGTACGTACGA',
  'ACGTACGTTCGTACGTACGT',
  'ACGTACGTACGTTCGTACGT',
  'ACGTACGAACGTACGTACGT',
];
// `distanceMatrix` takes {id, sequence} rows and returns {matrix, ...};
// `neighbourJoiningTree` takes the bare matrix plus the names.
const named = sequences.map((sequence, index) => ({ id: `sample_${index + 1}`, sequence }));
const { matrix } = distanceMatrix(named, { model: 'jukes-cantor' });
const tree = neighbourJoiningTree(matrix, named.map((entry) => entry.id));
write('phylogenetic-tree', renderTreeSvg(tree, { title: 'Five samples (neighbour joining)', layout: 'rectangular' }));

const reads = [];
for (let index = 0; index < 200; index++) {
  const seed = index * 2654435761 % 4294967296;
  const bases = 'ACGT';
  let sequence = '';
  for (let position = 0; position < 100; position++) sequence += bases[(seed >> (position % 24)) & 3];
  const quality = Array.from({ length: 100 }, (_, position) => {
    const phred = Math.max(2, Math.min(40, 38 - Math.floor(position / 12) + ((index + position) % 5) - 2));
    return String.fromCharCode(33 + phred);
  }).join('');
  reads.push({ id: `read_${index + 1}`, sequence, quality });
}
write('fastq-qc', renderFastqQcReport(fastqQcReport(reads, { max_plot_bases: 40 })));

write('virtual-gel', renderGel({
  title: 'Expected restriction digest',
  lanes: [
    { label: 'uncut', fragments: [4361] },
    { label: 'EcoRI', fragments: [4361] },
    { label: 'EcoRI+HindIII', fragments: [3000, 1000, 361] },
    { label: 'BsaI', fragments: [2500, 1200, 661] },
  ],
  ladder: '1kb',
}));

// ── index page ──────────────────────────────────────────────────────────────
const rows = written.map(({ name, bytes }) =>
  `  <section><h2>${name}</h2><p class="meta">${(bytes / 1024).toFixed(1)} KB</p><img src="${name}.svg" alt="${name}"></section>`).join('\n');
writeFileSync(join(out, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>dsh-molbio-tools — figure samples</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px; background: #f6f7f9; font: 14px/1.5 'Times New Roman', 'Liberation Serif', Times, serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .note { color: #57606a; margin: 0 0 24px; max-width: 70ch; }
  section { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; margin: 0 0 20px; }
  h2 { font-size: 15px; margin: 0 0 2px; font-family: ui-monospace, monospace; }
  .meta { color: #8c959f; margin: 0 0 10px; font-size: 12px; font-family: ui-monospace, monospace; }
  img { max-width: 100%; height: auto; }
</style>
<h1>dsh-molbio-tools — figure samples</h1>
<p class="note">
  Every figure declares <code>'Times New Roman', 'Liberation Serif', 'Nimbus Roman', Times, serif</code>.
  If what you see IS a serif face, the stack resolved. Compare a couple of figures side by side:
  they should look like the same typeface at different sizes.<br>
  The <code>attach_image</code> PNG is a different path — the rasterizer ignores <code>font-family</code>
  and draws its own built-in stroke font, so a PNG of these same figures will NOT be Times.
</p>
${rows}
`);

console.log(`${written.length} SVG + index.html written to ${out}`);
for (const { name, bytes } of written) console.log(`  ${name.padEnd(22)} ${(bytes / 1024).toFixed(1)} KB`);
