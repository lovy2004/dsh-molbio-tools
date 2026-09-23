/**
 * dsh-molbio-tools/benchmark/verifications.mjs
 *
 * The inputs that reproduce each task's `where: "tool"` expectations offline.
 *
 * A task carries the EXPECTED text; this module carries the INPUT that must
 * produce it. Both are needed, and keeping the input here (rather than inferring
 * it) is what turns "the expected value is stale" into a failing check with a
 * legible diff — the alternative, letting assertions assert on whatever the tool
 * happened to emit, would make the suite unfalsifiable.
 *
 * Two rules this table exists to enforce, both learned from a wrong result:
 *
 *  1. **The haystack is RENDERED text.** A live trace only ever carries the
 *     rendered projection, so an assertion written against the output VALUE
 *     (e.g. `"gc_percent": 50`) passes offline and can never match at runtime.
 *     `scoreSuiteOffline` renders; see `score.mjs` for the full story.
 *  2. **A `tool` assertion is only checked against the tools THIS TASK uses.**
 *     Every task names its own tools in `covers`, and only those invocations are
 *     run, so a pattern cannot be satisfied by an unrelated tool's output.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FIXTURES, NAMED_SEQUENCES, QPCR_TEMPLATE, makeTemplate, reverseComplementOf } from './sequences.mjs';

/** The committed GenBank fixture's text, read once at module scope. */
const GENBANK_TEXT = readFileSync(
  fileURLToPath(new URL(`../${FIXTURES.GENBANK_PATH}`, import.meta.url)),
  'utf8',
);



/** The plasmid sequence, loaded once per offline run. */
let puc118;

/** Bind the parsed pUC118 fixture (the offline grader loads it before scoring). */
export function usePlasmid(parsed) {
  puc118 = parsed;
}

function plasmid() {
  if (puc118 === undefined) throw new Error('benchmark: the pUC118 fixture was not loaded before this verification');
  return puc118.sequence;
}

/** Reverse complement, for building primers that act on the top strand. */
export function revComp(sequence) {
  const pairs = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...sequence].reverse().map((base) => pairs[base]).join('');
}

/**
 * Files a task's tools read from the workspace, as {relativePath: text}.
 *
 * `genbank-parse` needs the committed `.gb` text, and `verifications.mjs` cannot
 * read the disk itself (it is imported by the pure-data path too), so the file's
 * text is loaded here through `node:fs` at module scope and seeded into the
 * in-memory workspace — the tools then see it exactly as a real run would.
 */
const FILE_SETUPS = {
  'fasta-tools': { 'seqs.fa': FIXTURES.FASTA_TEXT, 'reads.fq': FIXTURES.FASTQ_TEXT },
  'sanger-verify': { 'read.seq': FIXTURES.SANGER_TEXT },
};

/**
 * The workspace files a task's tools need, plus the pUC118 fixture.
 *
 * @param {object} task a suite entry.
 * @returns {Record<string, string>} workspace-relative path → text content.
 */
export function setupFor(task) {
  return FILE_SETUPS[task.id] ?? {};
}

/** The workspace-root-relative path a tool argument should use. */
function at(relative) {
  return join(puc118Root(), relative);
}

let resolvedRoot;
/** Set the workspace root used for path-taking tools. */
export function useWorkspaceRoot(root) {
  resolvedRoot = root;
}

function puc118Root() {
  if (resolvedRoot === undefined) throw new Error('benchmark: the workspace root was not set before this verification');
  return resolvedRoot;
}

/**
 * The invocations that reproduce one task's `where: "tool"` expectations.
 *
 * @param {object} task a suite entry.
 * @returns {Array<{tool: string, args: object}>}
 */
export function invocationsFor(task) {
  const builders = {
    // core
    orientation: () => [{ tool: 'molbio_reverse_complement', args: { sequence: 'ATGCGTACGTTAGCCTAGGCAT' } }],
    'qpcr-primers': () => [
      { tool: 'molbio_design_primers', args: { template: QPCR_TEMPLATE, amplicon_min: 80, amplicon_max: 150, tm_min: 58, tm_max: 62, max_results: 1 } },
    ],
    'plasmid-single-cutter': () => [{ tool: 'molbio_unique_cutters', args: { vector: plasmid() } }],
    'fastq-qc': () => [{ tool: 'molbio_fastq_qc', args: { fastq: NAMED_SEQUENCES.qc_reads } }],
    'plasmid-digest': () => [
      { tool: 'molbio_restriction_sites', args: { sequence: plasmid(), enzymes: ['EcoRI', 'HindIII', 'PvuII'], circular: true } },
    ],
    'pcr-simulation': () => [
      {
        tool: 'molbio_pcr_simulate',
        args: {
          template: FIXTURES.CONSTRUCT,
          primer_pairs: [
            { name: 'pair1', forward: FIXTURES.CONSTRUCT.slice(100, 120), reverse: reverseComplementOf(FIXTURES.CONSTRUCT.slice(281, 301)) },
          ],
        },
      },
    ],
    'gel-preview': () => [
      { tool: 'molbio_virtual_gel', args: { lanes: [{ label: 'digest', fragments: [3111, 51] }], ladder: '1kb' } },
    ],
    'plasmid-map-file': () => [
      { tool: 'molbio_plasmid_map_file', args: { path: at('pUC118.dna'), enzymes: ['EcoRI', 'HindIII'] } },
    ],
    'plasmid-map-draw': () => [
      {
        tool: 'molbio_plasmid_map',
        args: {
          sequence: FIXTURES.CONSTRUCT,
          name: 'mini',
          circular: true,
          features: [{ type: 'CDS', start: 10, end: 200, label: 'testCDS' }],
          enzymes: ['EcoRI'],
        },
      },
    ],
    'double-digest-buffer': () => [
      { tool: 'molbio_double_digest', args: { sequence: FIXTURES.CONSTRUCT, first: 'EcoRI', second: 'HindIII', circular: false } },
    ],
    'methylation-block': () => [
      { tool: 'molbio_methylation_check', args: { sequence: plasmid(), enzymes: ['BamHI', 'KpnI'], circular: true } },
    ],
    'qpcr-ddct': () => [
      {
        tool: 'molbio_qpcr_analysis',
        args: {
          target_treated: [22.1, 22.3, 22.0],
          target_control: [25.0, 25.2, 24.9],
          reference_treated: [18.0, 18.1, 18.0],
          reference_control: [18.2, 18.1, 18.3],
        },
      },
    ],
    'align-mismatch': () => [
      // sequence1 = READ on purpose: either argument order is correct, and the
      // task's assertion accepts both. Running only one order offline would test
      // half of what the scorer allows.
      { tool: 'molbio_align', args: { sequence1: NAMED_SEQUENCES.align_read, sequence2: NAMED_SEQUENCES.align_reference } },
    ],
    'gc-cpg-islands': () => [
      { tool: 'molbio_gc_composition', args: { sequence: NAMED_SEQUENCES.puc118_cpg_region, criteria: 'gardiner', min_length: 200, gc_threshold: 50, cpg_oe_threshold: 0.6 } },
    ],
    'translate-orf': () => [
      { tool: 'molbio_translate', args: { sequence: 'GGGATGGCTGCTGCTGCTGCTGCTGCTGCTGCTTAACCC', frames: '1', min_orf_aa: 5 } },
    ],
    'enzyme-catalog': () => [{ tool: 'molbio_enzyme_lookup', args: { enzymes: ['BsaI', 'EcoRI'] } }],

    // primers
    'primer-qc': () => [
      { tool: 'molbio_primer_check', args: { primer1: 'ATTACTCCTGCTCTTCCCATAC', primer2: 'CACTACTCCTCTGTACGCAC' } },
      { tool: 'molbio_primer_tm', args: { sequence: 'ATTACTCCTGCTCTTCCCATAC' } },
    ],
    'taqman-assay': () => [
      { tool: 'molbio_design_taqman', args: { sequence: QPCR_TEMPLATE, probe_tm_min: 60, probe_tm_max: 72, max_amplicons: 1, max_probes_per_amplicon: 1 } },
    ],
    'intron-qpcr': () => [
      {
        tool: 'molbio_design_intron_primers',
        args: {
          genomic: FIXTURES.INTRON_GENOMIC,
          exons: FIXTURES.INTRON_EXONS,
          tm_min: 40,
          tm_max: 80,
          gc_min: 20,
          gc_max: 80,
          ...FIXTURES.INTRON_OPTIONS,
          max_results: 1,
        },
      },
    ],
    'multiplex-panel': () => [
      {
        tool: 'molbio_multiplex_check',
        args: {
          targets: [
            { name: 'A', sequence: QPCR_TEMPLATE, forward: 'ATTACTCCTGCTCTTCCCATAC', reverse: 'CACTACTCCTCTGTACGCAC', forward_tm: 58.4, reverse_tm: 58.9 },
            { name: 'B', sequence: makeTemplate(400, 8), forward: 'GGGTTTCCCAAATTTGGGCCCA', reverse: 'TTTGGGCCCAAATTTGGGAAAC' },
          ],
        },
      },
    ],

    // cloning
    'region-extract': () => [
      { tool: 'molbio_extract_region', args: { vector: FIXTURES.CONSTRUCT, start: 101, end: 200 } },
    ],
    mutagenesis: () => [
      { tool: 'molbio_mutagenesis_primers', args: { template: FIXTURES.MUTAGENESIS_TEMPLATE, mutations: [FIXTURES.MUTAGENESIS_MUTATION], tm_min: 60, tm_max: 90, max_results: 1 } },
    ],
    'clone-primers': () => [
      { tool: 'molbio_clone_primers', args: { template: FIXTURES.CLONE_INSERT, mode: 'restriction', enzymes: ['EcoRI', 'HindIII'] } },
    ],
    'clone-simulate': () => [
      {
        tool: 'molbio_clone_simulate',
        args: { vector: FIXTURES.CONSTRUCT, insert: FIXTURES.CLONE_INSERT, method: 'restriction', enzymes: ['EcoRI', 'HindIII'], add_flanks: true, verify_enzymes: ['EcoRI', 'HindIII'] },
      },
    ],
    'golden-gate': () => [
      { tool: 'molbio_golden_gate', args: { vector: FIXTURES.GG_VECTOR, inserts: FIXTURES.GG_INSERTS, enzyme: 'BsaI', replace_region: FIXTURES.GG_REPLACE_REGION } },
    ],

    // plasmids and maps
    'plasmid-map': () => [
      { tool: 'molbio_plasmid_map', args: { sequence: FIXTURES.CONSTRUCT, name: 'mini', circular: true, features: [{ type: 'FIXTURES.CDS', start: 10, end: 200, label: 'testCDS' }], enzymes: ['EcoRI'] } },
    ],
    'restriction-map': () => [
      { tool: 'molbio_restriction_sites', args: { sequence: plasmid(), enzymes: ['EcoRI', 'HindIII', 'PvuII'], circular: true } },
      { tool: 'molbio_enzyme_lookup', args: { enzymes: ['EcoRI', 'PvuII'], sequence: plasmid(), circular: true } },
    ],

    // sequencing
    'sanger-verify': () => [
      { tool: 'molbio_verify_sanger', args: { trace_path: at('read.seq'), reference: FIXTURES.CONSTRUCT } },
      { tool: 'molbio_verify_sanger', args: { trace_path: at('read.seq'), reference: `${FIXTURES.CONSTRUCT.slice(0, 149)}A${FIXTURES.CONSTRUCT.slice(150)}` } },
    ],

    // protein
    'protein-props': () => [{ tool: 'molbio_protein_props', args: { sequence: FIXTURES.DIGEST_PEPTIDE } }],
    'peptide-digest': () => [{ tool: 'molbio_peptide_digest', args: { sequence: FIXTURES.DIGEST_PEPTIDE, enzyme: 'trypsin', missed: 0 } }],
    'helical-wheel': () => [{ tool: 'molbio_helical_wheel', args: { sequence: FIXTURES.AMPHIPATHIC_PEPTIDE, title: 'amphipathic test' } }],
    hydropathy: () => [{ tool: 'molbio_hydropathy_plot', args: { sequence: FIXTURES.DIGEST_PEPTIDE } }],

    // bench analysis
    'codon-optimize': () => [{ tool: 'molbio_codon_optimize', args: { sequence: FIXTURES.CDS, host: 'e_coli' } }],
    'reading-frames': () => [{ tool: 'molbio_translate', args: { sequence: `GGG${FIXTURES.CDS}`, frames: 'all', min_orf_aa: 20 } }],
    'qpcr-efficiency': () => [
      { tool: 'molbio_qpcr_efficiency', args: { dilution_factors: [1, 10, 100, 1000], ct_values: [15.0, 18.3, 21.6, 24.9] } },
    ],
    plotting: () => [
      { tool: 'molbio_plot', args: { kind: 'bar', labels: ['ctrl', 'kd'], values: [1, 6.65], errors: [0.1, 0.9], output_path: join(puc118Root(), 'fold.svg') } },
      { tool: 'molbio_plot', args: { kind: 'scatter', x: [1, 2, 3, 4], y: [2.1, 3.9, 6.2, 7.8], fit: true, output_path: join(puc118Root(), 'fit.svg') } },
    ],

    // alignment and composition
    'msa-align': () => [
      { tool: 'molbio_msa_align', args: { sequences: [FIXTURES.CONSTRUCT.slice(0, 60), `${FIXTURES.CONSTRUCT.slice(0, 59)}G`, FIXTURES.CONSTRUCT.slice(0, 58)] } },
    ],
    conservation: () => [
      { tool: 'molbio_conservation', args: { sequences: ['ACGTACGTAC', 'ACGTACGTAC', 'ACGTTCGTAC'] } },
    ],
    'sequence-logo': () => [
      { tool: 'molbio_sequence_logo', args: { sequences: ['ACGTACGTAC', 'ACGTACGTAC', 'ACGTTCGTAC'], title: 'conservation test' } },
    ],
    'fasta-tools': () => [
      { tool: 'molbio_fasta_fastq', args: { path: at('seqs.fa'), action: 'stats' } },
      { tool: 'molbio_fasta_fastq', args: { path: at('reads.fq'), action: 'qc' } },
    ],
    'composition-skew': () => [
      { tool: 'molbio_gc_composition', args: { sequence: FIXTURES.CONSTRUCT, window: 100, step: 50 } },
    ],

    // crispr
    'crispr-guide': () => [
      { tool: 'molbio_grna_design', args: { sequence: plasmid(), max_guides: 3 } },
    ],
    // records
    'lab-notebook': () => [
      { tool: 'molbio_protocol_add', args: { name: 'Gibson assembly', category: 'cloning', steps: ['Mix', 'Incubate', 'Transform'] } },
      { tool: 'molbio_protocol_list', args: {} },
      { tool: 'molbio_protocol_update', args: { id: 'rec1', category: 'molecular cloning' } },
      { tool: 'molbio_experiment_log', args: { title: 'First assembly attempt', date: '2026-01-02', notes: 'colonies on plate 2' } },
      { tool: 'molbio_experiment_list', args: {} },
    ],
    'literature-library': () => [
      { tool: 'molbio_paper_add', args: { papers: [{ title: 'SPLICER: a highly efficient base editing toolbox', pmid: '39609418', year: '2024', tags: ['crispr'] }] } },
      { tool: 'molbio_paper_list', args: {} },
      // The id is the QUALIFIED form the list command reports (`pmid:39609418`),
      // not the bare PMID: update/remove accept only the former, and a model that
      // guesses the bare PMID is exactly the usability finding this task covers.
      { tool: 'molbio_paper_update', args: { id: 'pmid:39609418', note: 'read the methods' } },
      { tool: 'molbio_paper_export_bibtex', args: { output_path: join(puc118Root(), 'lib.bib') } },
      { tool: 'molbio_paper_remove', args: { id: 'pmid:39609418' } },
      { tool: 'molbio_paper_list', args: {} },
    ],

    'dilution-math': () => [
      { tool: 'molbio_lab_math', args: { operation: 'dilution', c1: 10, c2: 0.5, v2: 1000 } },
    ],
    'codon-usage': () => [
      { tool: 'molbio_codon_usage', args: { sequence: FIXTURES.CDS, host: 'e_coli' } },
    ],
    'phylogeny': () => [
      {
        tool: 'molbio_phylogenetic_tree',
        args: {
          sequences: [
            'ACGTACGTACGTACGTACGTACGTACGTACGT',
            'ACGTACGTACGTACGTACGTACGTACGTACGA',
            'TTTTGGGGCCCCAAAATTTTGGGGCCCCAAAA',
            'TTTTGGGGCCCCAAAATTTTGGGGCCCCAAAT',
          ],
          ids: ['a', 'b', 'c', 'd'],
          method: 'nj',
        },
      },
    ],
    'genbank-parse': () => [
      { tool: 'molbio_parse_genbank', args: { genbank: GENBANK_TEXT } },
      { tool: 'molbio_parse_snapgene', args: { path: at('pUC118.dna') } },
    ],

    // network (see NETWORK_TASKS: online-only assertions, `where: "answer"`)
    'literature-search': () => [
      { tool: 'molbio_pubmed_search', args: { query: 'CRISPR base editing', max_results: 5 } },
      { tool: 'molbio_pubmed_abstract', args: { pmids: ['39609418'] } },
    ],
  };

  const build = builders[task.id];
  if (build === undefined) {
    // A task with no `tool` assertions needs no invocation; anything else is an
    // authoring mistake that must fail rather than silently skip verification.
    return task.assertions.some((assertion) => assertion.where === 'tool') ? undefined : [];
  }
  return build();
}

/**
 * Tasks whose `tool` assertions cannot be verified offline.
 *
 * `molbio_pubmed_search` and `molbio_pubmed_abstract` reach the live PubMed
 * API, so what they return is whatever PubMed answers today — there is no
 * recorded value to pin. Their tasks therefore assert ONLY on the model's final
 * answer (structural facts: a PMID appears, a title appears), which is why this
 * module returns no invocations for them and why the offline gate tolerates that
 * specific case while failing every other task that forgets to declare one.
 */
export const NETWORK_TASKS = new Set(['literature-search']);
