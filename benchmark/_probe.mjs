/**
 * dsh-molbio-tools/benchmark/_probe.mjs
 *
 * Derive the ground truth a task asserts, from the SHIPPED tools.
 *
 * A benchmark whose expected values were typed in by hand from memory stops
 * being true the moment a model or a table changes. Every value this script
 * prints is produced by the same `execute()` the model reaches, in memory, so
 * `tasks/*.json` records what the plugin actually answers — and a later change in
 * a tool shows up as a failing task rather than as a silent pass.
 *
 * Run: node benchmark/_probe.mjs [probe-name]
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTools, seedFixtures } from './tools.mjs';
import { NAMED_SEQUENCES } from './sequences.mjs';

process.env.MOLBIO_AUTO_VIEW = '0';

const here = resolve(fileURLToPath(import.meta.url), '..');
const fixture = (name) => join(here, '..', 'test', 'fixtures', name);

const workspaceRoot = resolve(here, '_probe-workspace');
const harness = loadTools({ workspaceRoot });
await seedFixtures(harness.memFs, { 'pUC118.dna': fixture('pUC118.dna') });

const only = process.argv[2];
const results = {};

/** Record one probe's output, printing a compact line. */
async function probe(name, tool, args, pick = (value) => value) {
  if (only !== undefined && name !== only) return;
  try {
    const value = await harness.run(tool, args);
    results[name] = { tool, args, value: pick(value) };
    console.log(`--- ${name} [${tool}]`);
    console.log(JSON.stringify(results[name].value, null, 2));
  } catch (error) {
    results[name] = { tool, args, error: String(error) };
    console.log(`--- ${name} [${tool}] ERROR ${String(error)}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Deterministic pseudo-random DNA, the same generator the smoke suite uses. */
function makeTemplate(n, seed = 42) {
  let s = seed;
  const bases = 'ACGT';
  let out = '';
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += bases[(s >> 16) % 4];
  }
  return out;
}

// A 60 bp core with one EcoRI site (GAATTC) placed so the digest is asymmetric.
const ecoTemplate = `TTGCAAGCTTG${'A'.repeat(10)}GAATTC${'T'.repeat(10)}GGATCCTTAAGGCC`;
void ecoTemplate;

// ── C1: orientation ─────────────────────────────────────────────────────────

const ORIENTATION_SEQ = 'ATGCGTACGTTAGCCTAGGCAT';
await probe('orientation', 'molbio_reverse_complement', { sequence: ORIENTATION_SEQ }, (v) => ({
  reverse_complement: v.reverse_complement,
  gc_percent: v.gc_percent,
}));

// ── P1: qPCR primer design ──────────────────────────────────────────────────

const QPCR_TEMPLATE = makeTemplate(400, 7);
await probe(
  'qpcr_primers',
  'molbio_design_primers',
  { template: QPCR_TEMPLATE, amplicon_min: 80, amplicon_max: 150, tm_min: 58, tm_max: 62, max_results: 3 },
  (v) => ({
    count: Array.isArray(v.pairs) ? v.pairs.length : undefined,
    top: v.pairs?.[0],
    keys: Object.keys(v),
  }),
);

// ── R1: single digest on the real plasmid ───────────────────────────────────

await probe(
  'puc118_ecori',
  'molbio_restriction_sites',
  { sequence: 'A'.repeat(0), enzymes: ['EcoRI'] },
  (v) => v,
).catch(() => {});

// The plasmid tools take a path; read the fixture through the seam instead.
const dnaValue = await harness.run('molbio_parse_snapgene', { path: join(workspaceRoot, 'pUC118.dna') });
console.log('--- pUC118 summary');
console.log(
  JSON.stringify(
    { length: dnaValue.length, topology: dnaValue.topology, name: dnaValue.name, features: dnaValue.features?.length },
    null,
    2,
  ),
);

await probe(
  'puc118_restriction',
  'molbio_restriction_sites',
  { sequence: dnaValue.sequence, enzymes: ['EcoRI', 'HindIII', 'BamHI'], circular: true },
  (v) => ({ sites: v.sites, fragments: v.fragments }),
);

await probe(
  'puc118_unique_cutters',
  'molbio_unique_cutters',
  { vector: dnaValue.sequence },
  (v) => ({
    keys: Object.keys(v),
    idealCount: v.ideal?.length,
    firstIdeal: v.ideal?.slice(0, 12),
    doubleCount: v.double_cutters?.length ?? v.double?.length,
  }),
);

await probe(
  'puc118_methylation',
  'molbio_methylation_check',
  { sequence: dnaValue.sequence, enzymes: ['EcoRI', 'HindIII', 'BamHI', 'ClaI', 'XbaI', 'TaqI'], circular: true },
  (v) => ({ per_enzyme: v.per_enzyme, recommended: v.recommended, siteCount: v.methylation_sites?.length }),
);

await probe(
  'puc118_double_digest',
  'molbio_double_digest',
  { sequence: dnaValue.sequence, first: 'EcoRI', second: 'HindIII', circular: true },
  (v) => ({
    keys: Object.keys(v),
    shared_buffer: v.buffer?.shared ?? v.shared_buffer,
    fragments: v.combined?.fragments ?? v.fragments,
  }),
);

// ── S1: qPCR ΔΔCt ───────────────────────────────────────────────────────────

await probe(
  'qpcr_ddct',
  'molbio_qpcr_analysis',
  {
    target_treated: [22.1, 22.3, 22.0],
    target_control: [25.0, 25.2, 24.9],
    reference_treated: [18.0, 18.1, 18.0],
    reference_control: [18.2, 18.1, 18.3],
  },
  (v) => v,
);

// ── A1: local alignment ─────────────────────────────────────────────────────

const REF_A1 = makeTemplate(200, 11);
const READ_A1 = REF_A1.slice(50, 110);
const MUT_A1 = `${READ_A1.slice(0, 30)}A${READ_A1.slice(31)}`;
await probe('align_mismatch', 'molbio_align', { sequence1: REF_A1, sequence2: MUT_A1 }, (v) => v);

// ── G1: GC composition ──────────────────────────────────────────────────────

const CPG_SEQ = `${'ACGT'.repeat(20)}CGCGCGCGCGCGCGCGCGCG${'ACGT'.repeat(20)}`;
await probe(
  'gc_composition',
  'molbio_gc_composition',
  { sequence: CPG_SEQ, criteria: 'gardiner', min_length: 200, gc_threshold: 50, cpg_oe_threshold: 0.6 },
  (v) => ({ islands: v.islands, gc_percent: v.gc_percent, keys: Object.keys(v) }),
);

// ── F1: FASTQ QC ────────────────────────────────────────────────────────────

const FASTQ = [
  '@r1',
  'ACGTACGTACGTACGTACGT',
  '+',
  'IIIIIIIIIIIIIIIIIIII',
  '@r2',
  'TTTTTTTTTTTTTTTTTTTT',
  '+',
  '!!!!!!!!!!!!!!!!!!!!',
  '@r3',
  'GGGGCCCCAAAATTTTGGGG',
  '+',
  'IIIIIHHHHH#####IIIII',
  '',
].join('\n');
await probe('fastq_qc', 'molbio_fastq_qc', { fastq: FASTQ }, (v) => v);

// ── T1: translation and ORF ─────────────────────────────────────────────────

await probe(
  'translate_orf',
  'molbio_translate',
  { sequence: `GGG${'ATG'}${'GCT'.repeat(10)}TAA${'CCC'}`, frames: '1', min_orf_aa: 5 },
  (v) => v,
);

// ── E1: enzyme catalogue (no sequence) ──────────────────────────────────────

await probe('enzyme_lookup', 'molbio_enzyme_lookup', { enzymes: ['BsaI', 'EcoRI'] }, (v) => v);

// ── L1: lab math, dilution ──────────────────────────────────────────────────

await probe('lab_math', 'molbio_lab_math', { operation: 'dilution', c1: 10, c2: 0.5, v2: 1000 }, (v) => v);

// ── C2: virtual gel levels ──────────────────────────────────────────────────

await probe(
  'gel',
  'molbio_virtual_gel',
  { lanes: [{ label: 'digest', sizes: [3162] }, { label: 'marker', sizes: [1000, 2000, 3000, 4000] }], ladder: '1kb' },
  (v) => v,
);

// ── P1: alignment post-processing ───────────────────────────────────────────
//
// The rendered TEXT is what a `where: "tool"` assertion sees, so this probe
// prints both the value and the projection. The four rows are the committed
// fixture (`benchmark/sequences.mjs`): a reference, a mutant with eight
// substitutions, a row with two of those substitutions plus gap stretches, and a
// 200 bp amplicon padded to 300 columns.
{
  const args = {
    alignment: [
      NAMED_SEQUENCES.align_post_reference,
      NAMED_SEQUENCES.align_post_mutant,
      NAMED_SEQUENCES.align_post_deleted,
      NAMED_SEQUENCES.align_post_partial,
    ],
  };
  if (only === undefined || only === 'alignment_post') {
    const value = await harness.run('molbio_alignment_postprocess', args);
    console.log('--- alignment_post [molbio_alignment_postprocess]');
    console.log('RENDERED:');
    console.log(harness.render('molbio_alignment_postprocess', args, value));
    console.log('VALUE:');
    console.log(JSON.stringify({
      consensus_mode: value.consensus_mode,
      consensus_length: value.consensus.length,
      conserved_columns: value.conserved_columns,
      mean_column_identity: value.mean_column_identity,
      columns_before_trim: value.columns_before_trim,
      columns_after_trim: value.columns_after_trim,
      trimmed_columns: value.trimmed_columns,
      mean_coverage: value.mean_coverage,
      min_coverage: value.min_coverage,
      fully_covered_columns: value.fully_covered_columns,
      low_coverage_count: value.low_coverage_columns.length,
      low_coverage_first: value.low_coverage_columns[0],
      low_coverage_last: value.low_coverage_columns.at(-1),
      identity_matrix: value.identity_matrix,
      pairwise_identity_percent: value.pairwise_identity_percent,
    }, null, 2));
  }
}

process.exit(0);
