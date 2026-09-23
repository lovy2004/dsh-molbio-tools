/**
 * dsh-molbio-tools/benchmark/_probe-all.mjs
 *
 * Second-stage probe: dump the RENDERED text of the tools the first task set did
 * not touch, so their assertions can be written from measured output.
 *
 * `_probe.mjs` records the original suite's ground truth; this one covers the
 * rest of the catalog. Both exist because every expected value in `tasks.json`
 * must come from the shipped tool rather than from memory.
 *
 * Run: node benchmark/_probe-all.mjs [substring]
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTools, seedFixtures, seedText } from './tools.mjs';
import { NAMED_SEQUENCES, QPCR_TEMPLATE, makeTemplate } from './sequences.mjs';
import {
  AMPHIPATHIC_PEPTIDE,
  CDS,
  CLONE_INSERT,
  CONSTRUCT,
  DIGEST_PEPTIDE,
  FASTA_TEXT,
  FASTQ_TEXT,
  GG_INSERTS,
  GG_REPLACE_REGION,
  GG_VECTOR,
  INTRON_EXONS,
  INTRON_GENOMIC,
  INTRON_OPTIONS,
  MUTAGENESIS_MUTATION,
  MUTAGENESIS_TEMPLATE,
  SANGER_TEXT,
  assertNoBsaI,
} from './fixtures.mjs';

process.env.MOLBIO_AUTO_VIEW = '0';

const here = resolve(fileURLToPath(import.meta.url), '..');
const workspaceRoot = resolve(here, '_probe-workspace');
const harness = loadTools({ workspaceRoot });
await seedFixtures(harness.memFs, { 'pUC118.dna': join(here, '..', 'test', 'fixtures', 'pUC118.dna') });
seedText(harness.memFs, 'seqs.fa', FASTA_TEXT);
seedText(harness.memFs, 'reads.fq', FASTQ_TEXT);
seedText(harness.memFs, 'read.seq', SANGER_TEXT);

const plasmid = await harness.run('molbio_parse_snapgene', { path: join(workspaceRoot, 'pUC118.dna') });
const only = process.argv[2];

console.log(`GG vector BsaI-free backbone: ${JSON.stringify(assertNoBsaI())} (expected [])`);

/** Render one call, printing the text the model would read. */
async function show(label, tool, args, max = 1400) {
  if (only !== undefined && !label.includes(only)) return;
  try {
    const value = await harness.run(tool, args);
    console.log(`===== ${label} [${tool}]`);
    console.log(harness.render(tool, args, value).slice(0, max));
    console.log('');
  } catch (error) {
    console.log(`===== ${label} [${tool}] ERROR: ${String(error)}\n`);
  }
}

// ── primers ─────────────────────────────────────────────────────────────────

await show('primer-check', 'molbio_primer_check', { primer1: 'ATTACTCCTGCTCTTCCCATAC', primer2: 'CACTACTCCTCTGTACGCAC' });
await show('primer-tm', 'molbio_primer_tm', { sequence: 'ATTACTCCTGCTCTTCCCATAC' });
await show('taqman', 'molbio_design_taqman', { sequence: QPCR_TEMPLATE, probe_tm_min: 60, probe_tm_max: 72, max_amplicons: 1, max_probes_per_amplicon: 1 }, 1400);
await show('intron', 'molbio_design_intron_primers', {
  genomic: INTRON_GENOMIC,
  exons: INTRON_EXONS,
  tm_min: 40,
  tm_max: 80,
  gc_min: 20,
  gc_max: 80,
  ...INTRON_OPTIONS,
  max_results: 1,
}, 1100);
await show('multiplex', 'molbio_multiplex_check', {
  targets: [
    { name: 'A', sequence: QPCR_TEMPLATE, forward: 'ATTACTCCTGCTCTTCCCATAC', reverse: 'CACTACTCCTCTGTACGCAC', forward_tm: 58.4, reverse_tm: 58.9 },
    { name: 'B', sequence: makeTemplate(400, 8), forward: 'GGGTTTCCCAAATTTGGGCCCA', reverse: 'TTTGGGCCCAAATTTGGGAAAC' },
  ],
}, 1500);

// ── cloning ─────────────────────────────────────────────────────────────────

const donor = `${makeTemplate(200, 61)}GAATTC${CLONE_INSERT.slice(56)}`;
void donor;
await show('extract', 'molbio_extract_region', { source_path: join(workspaceRoot, 'pUC118.dna'), feature: 'AmpR' }, 500);
await show('extract-coords', 'molbio_extract_region', { vector: CONSTRUCT, start: 101, end: 200 }, 500);
await show('mutagenesis', 'molbio_mutagenesis_primers', {
  template: MUTAGENESIS_TEMPLATE,
  mutations: [MUTAGENESIS_MUTATION],
  tm_min: 60,
  tm_max: 90,
  max_results: 1,
}, 900);
await show('clone-primers', 'molbio_clone_primers', { template: CLONE_INSERT, mode: 'restriction', enzymes: ['EcoRI', 'HindIII'] }, 1000);
await show('clone-primers-gibson', 'molbio_clone_primers', { template: CLONE_INSERT, mode: 'gibson', vector: CONSTRUCT, region_start: 101, region_end: 300, overhang: 20 }, 900);
await show('clone-simulate', 'molbio_clone_simulate', {
  vector: CONSTRUCT,
  insert: CLONE_INSERT,
  method: 'restriction',
  enzymes: ['EcoRI', 'HindIII'],
  add_flanks: true,
  verify_enzymes: ['EcoRI', 'HindIII'],
}, 1400);
await show('golden-gate', 'molbio_golden_gate', {
  vector: GG_VECTOR,
  inserts: GG_INSERTS,
  enzyme: 'BsaI',
  replace_region: GG_REPLACE_REGION,
}, 1800);
await show('pcr-sim-match', 'molbio_pcr_simulate', {
  template: CONSTRUCT,
  primer_pairs: [
    { name: 'pair1', forward: CONSTRUCT.slice(100, 120), reverse: CONSTRUCT.slice(300, 320) },
    // The reverse primer must be the reverse complement of the TOP strand, so a
    // primer written as a slice of the template can never act as one. This is
    // the mistake the first probe made ("1 forward site(s), 0 reverse site(s)").
    { name: 'pair2', forward: CONSTRUCT.slice(100, 120), reverse: revComp(CONSTRUCT.slice(281, 301)) },
  ],
}, 1200);

function revComp(sequence) {
  const pairs = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...sequence].reverse().map((base) => pairs[base]).join('');
}

// ── plasmids and maps ───────────────────────────────────────────────────────

await show('map-file', 'molbio_plasmid_map_file', { path: join(workspaceRoot, 'pUC118.dna'), enzymes: ['EcoRI', 'HindIII'] }, 600);
await show('map', 'molbio_plasmid_map', {
  sequence: CONSTRUCT,
  name: 'mini',
  circular: true,
  features: [{ type: 'CDS', start: 10, end: 200, label: 'testCDS' }],
  enzymes: ['EcoRI'],
}, 600);
await show('restriction-construct', 'molbio_restriction_sites', { sequence: CONSTRUCT, enzymes: ['EcoRI', 'HindIII'] }, 900);
await show('enzyme-lookup-seq', 'molbio_enzyme_lookup', { enzymes: ['EcoRI', 'PvuII'], sequence: plasmid.sequence, circular: true }, 900);

// ── sequencing ──────────────────────────────────────────────────────────────

await show('sanger-match', 'molbio_verify_sanger', { trace_path: join(workspaceRoot, 'read.seq'), reference: CONSTRUCT }, 800);
await show('sanger-mismatch', 'molbio_verify_sanger', {
  trace_path: join(workspaceRoot, 'read.seq'),
  reference: `${CONSTRUCT.slice(0, 149)}A${CONSTRUCT.slice(150)}`,
}, 900);

// ── protein ─────────────────────────────────────────────────────────────────

await show('protein-props', 'molbio_protein_props', { sequence: DIGEST_PEPTIDE });
await show('peptide-digest', 'molbio_peptide_digest', { sequence: DIGEST_PEPTIDE, enzyme: 'trypsin', missed: 0 }, 900);
await show('helical-wheel', 'molbio_helical_wheel', { sequence: AMPHIPATHIC_PEPTIDE, title: 'amphipathic test', output_path: join(workspaceRoot, 'wheel.svg') }, 900);
await show('hydropathy', 'molbio_hydropathy_plot', { sequence: DIGEST_PEPTIDE, output_path: join(workspaceRoot, 'hydro.svg') }, 800);

// ── bench analysis ──────────────────────────────────────────────────────────

await show('codon-optimize', 'molbio_codon_optimize', { sequence: CDS, host: 'e_coli' }, 900);
await show('codon-optimize-avoid', 'molbio_codon_optimize', { sequence: CDS, host: 'e_coli', avoid_enzymes: ['EcoRI'] }, 700);
await show('orf', 'molbio_translate', { sequence: `GGG${CDS}`, frames: 'all', min_orf_aa: 20 }, 1200);
await show('qpcr-efficiency', 'molbio_qpcr_efficiency', { dilution_factors: [1, 10, 100, 1000], ct_values: [15.0, 18.3, 21.6, 24.9] }, 900);
await show('plot-bar', 'molbio_plot', {
  kind: 'bar',
  labels: ['ctrl', 'kd'],
  values: [1, 6.65],
  errors: [0.1, 0.9],
  output_path: join(workspaceRoot, 'fold.svg'),
  title: 'fold change',
}, 700);
await show('plot-scatter', 'molbio_plot', {
  kind: 'scatter',
  x: [1, 2, 3, 4],
  y: [2.1, 3.9, 6.2, 7.8],
  fit: true,
  output_path: join(workspaceRoot, 'fit.svg'),
}, 700);

// ── alignment and composition ───────────────────────────────────────────────

await show('msa', 'molbio_msa_align', {
  sequences: [CONSTRUCT.slice(0, 60), `${CONSTRUCT.slice(0, 59)}G`, CONSTRUCT.slice(0, 58)],
}, 1000);
await show('conservation-unaligned', 'molbio_conservation', {
  sequences: ['ACGTACGTAC', 'ACGTACGTAC', 'ACGTTCGTAC'],
}, 1200);
await show('logo', 'molbio_sequence_logo', {
  sequences: ['ACGTACGTAC', 'ACGTACGTAC', 'ACGTTCGTAC'],
  title: 'conservation test',
  output_path: join(workspaceRoot, 'logo.svg'),
}, 600);
await show('fasta-stats', 'molbio_fasta_fastq', { path: join(workspaceRoot, 'seqs.fa'), action: 'stats' }, 800);
await show('fasta-extract', 'molbio_fasta_fastq', { path: join(workspaceRoot, 'seqs.fa'), action: 'extract', id: 'amp_fwd' }, 600);
await show('fasta-convert', 'molbio_fasta_fastq', { path: join(workspaceRoot, 'reads.fq'), action: 'convert', output_path: join(workspaceRoot, 'converted.fa') }, 600);
await show('fasta-qc', 'molbio_fasta_fastq', { path: join(workspaceRoot, 'reads.fq'), action: 'qc' }, 900);
await show('composition-skew', 'molbio_gc_composition', { sequence: CONSTRUCT, window: 100, step: 50 }, 1000);

// ── the ORF/translate fixture's own check ───────────────────────────────────

console.log('===== fixture sanity');
console.log(`CONSTRUCT ${CONSTRUCT.length} bp; EcoRI at ${CONSTRUCT.indexOf('GAATTC') + 1}; HindIII at ${CONSTRUCT.indexOf('AAGCTT') + 1}`);
console.log(`CDS ${CDS.length} bp; stops inside: ${(CDS.slice(0, -3).match(/TAA|TAG|TGA/g) ?? []).length}`);

process.exit(0);
