/**
 * dsh-molbio-tools/benchmark/_probe-v28.mjs
 *
 * Reproducible record of the INPUTS behind the v0.28.0 benchmark tasks, and of
 * what the shipped tools render for them. `tasks/*.json` carries the expected
 * text; this file carries the invocation that must still produce it, so a tool
 * change shows up as a failing task rather than as a silently rewritten
 * expectation.
 *
 * Run: node benchmark/_probe-v28.mjs
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTools } from './tools.mjs';

process.env.MOLBIO_AUTO_VIEW = '0';

const here = resolve(fileURLToPath(import.meta.url), '..');
const workspaceRoot = resolve(here, '_probe-v28-workspace');
const harness = loadTools({ workspaceRoot });

const ASSEMBLY_REF = 'GCGTGGTTATAATACAAGTTGAGCATATAAGGTTTGACAGCCTCTGACGCCTGCGGCGAAGGCCCATAATGGTACCGGAAGACTTCCGCCTCGATGCATCACTCACATCGGTGTCACCTGTTGTCGTCCGTTAACAAGTAGCAGGTTAGATCCGATCCGCGTCTAGGAGTGATCCTTATCAAATTGACTCAAAGGCGATATACAGCGAAAACATCAACCGTGGACTTCAGGAACACGGTGTGAGGGTTGGTCTCTTTTGAGAGATATTACAGACACTTTCTGGAGGACAACCGTGGTTTGGAACTGAATTGTCAAGGCGACATTACCTTAAAGCGTAGTTGGGTGGTGACTTTGAGCTGATGATAACGTAGGGACCAGCAATGTTTATACCGAACATGGA';
const ASSEMBLY_READS = [
  { name: 'r1', sequence: ASSEMBLY_REF.slice(0, 220) },
  { name: 'r2', sequence: ASSEMBLY_REF.slice(150, 370) },
  { name: 'r3', sequence: 'TCCATGTTCGGTATAAACATTGCTGGTCCCTACGTTATCATCAGCTCAAAGTCACCACCCAACTACGCTTTAAGGTAATGTCGCCTTGACAATTCAGTTCCAAACCACGGTTGTCCTCCA' },
];
const EDIT_REF = 'ATG' + 'GCT'.repeat(30) + 'TAA';
const EDIT_READS = [
  { name: 'wt1', sequence: EDIT_REF },
  { name: 'wt2', sequence: EDIT_REF },
  { name: 'del', sequence: EDIT_REF.slice(0, 3) + EDIT_REF.slice(6) },
  { name: 'sub', sequence: EDIT_REF.slice(0, 3) + 'A' + EDIT_REF.slice(4) },
];
const INSULIN = 'MALWMRLLPLLALLALWGPDPAAAFVNQHLCGSHLVEALYLVCGERGFFYTPKTRREAEDLQVGQVELGGGPGAGSLQPLALEGSLQKRGIVEQCCTSICSLYQLENYCN';

const probes = [
  ['protein-features', 'molbio_protein_features', { sequence: 'AANASWAAWGEASTALKAERRASAAE' + 'A'.repeat(16) }],
  ['signal-peptide', 'molbio_signal_peptide', { sequence: INSULIN.slice(0, 40) }],
  ['antigenicity', 'molbio_antigenicity', { sequence: INSULIN }],
  ['feature-export', 'molbio_feature_export', { sequence: 'ACGTACGTAC', features: [{ type: 'CDS', start: 2, end: 6, strand: 1, label: 'gene1' }], format: 'gff3' }],
  ['sequence-edit', 'molbio_sequence_edit', { sequence: 'AACCGGTT', operation: 'rotate', position: 3 }],
  ['sanger-assemble', 'molbio_sanger_assemble', { reads: ASSEMBLY_READS, min_overlap: 40, trim_quality: 0 }],
  ['editing-outcome', 'molbio_editing_outcome', { reads: EDIT_READS, reference: EDIT_REF, circular: false, cds_start: 1, cds_end: EDIT_REF.length }],
];

for (const [name, tool, args] of probes) {
  try {
    const value = await harness.run(tool, args);
    const text = harness.render(tool, args, value);
    console.log(`===== ${name} [${tool}]`);
    console.log(text);
  } catch (error) {
    console.log(`===== ${name} ERROR ${String(error)}`);
  }
}

void join;