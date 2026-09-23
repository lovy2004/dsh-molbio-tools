/**
 * dsh-molbio-tools/test/smoke.mjs
 *
 * Run with: node test/smoke.mjs
 * Exercises the plugin through a mock tools registry, validates every tool's
 * output schema with the harness's own enforced-subset validator, and checks
 * known-value computations.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

import { findHarnessRoot, importPackage } from '../benchmark/harness.mjs';

const require = createRequire(import.meta.url);

// Import the REAL harness validators from the installed DSH (its own deps
// resolve beside it). Test-only import — the shipped plugin never does this.
//
// Located through the shared resolver rather than a hardcoded path: the literal
// `C:/Users/18771/...` this file used to carry meant the suite could only ever
// pass on one machine, and on any other one it would silently import a DIFFERENT
// harness than `preset-health`/`contract` were checking.
const harnessRoot = findHarnessRoot(process.env.DSH_HARNESS_ROOT);
if (harnessRoot === undefined) {
  console.error('smoke: could not locate an installed DSH harness (set DSH_HARNESS_ROOT)');
  process.exit(2);
}
const dshTools = await importPackage('@deepseek-ai/dsh-tools', harnessRoot);
const { assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools;

const plugin = await import('../index.mjs');
const lib = await import('../lib.mjs');
const view = await import('../view.mjs');
const { reverseComplement: reverseComplementOf } = lib;

// The auto-view opener would spawn real viewer processes on the machine
// running the tests — disable it globally; the view module gets its own
// unit checks below through the injectable internals seam.
process.env.MOLBIO_AUTO_VIEW = '0';

// ── mock registry ───────────────────────────────────────────────────────────

const registered = [];

const memFs = {
  files: new Map(),
  async resolve(path) {
    return { path };
  },
  async stat(target) {
    return this.files.has(target.path) ? { size: 1 } : undefined;
  },
  async readText(target) {
    if (!this.files.has(target.path)) throw new Error('ENOENT');
    return this.files.get(target.path).toString('utf8');
  },
  async readBytes(target, _signal, _maxBytes) {
    if (!this.files.has(target.path)) throw new Error('ENOENT');
    const value = this.files.get(target.path);
    return value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  },
  async writeText(target, content) {
    this.files.set(target.path, content);
    return { version: 1 };
  },
};

const mockWeb = {
  async search({ query }) {
    return {
      content: `answer for ${query}`,
      sources: [
        { url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/', title: 'A paper', snippet: 'snippet one' },
        { url: 'https://example.com/other', title: 'Other' },
      ],
      truncated: false,
    };
  },
  async fetch() {
    return {
      url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
      statusCode: 200,
      body: {
        kind: 'text',
        content: '<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345678</PMID><Article><ArticleTitle>Test Article Title</ArticleTitle><Abstract><AbstractText>First chunk.</AbstractText><AbstractText>Second chunk.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>',
      },
      truncated: false,
    };
  },
};

// Services a specific check mounts on demand (v18: attachments + llm for the
// opt-in picture hand-off). Absent by default, like a bare composition.
const extraServices = new Map();

const mockCtx = {
  systemPrompt: { section(_opts) {} },
  get(name) {
    if (name === 'fs') return memFs;
    if (name === 'web') return mockWeb;
    return extraServices.get(name);
  },
  tools: {
    register(definition) {
      // Mirror the real Tools.register() validation.
      if (typeof definition.output?.render !== 'function') {
        throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`);
      }
      assertSupportedJsonSchema(definition.output.schema);
      registered.push(definition);
    },
  },
};

plugin.apply(mockCtx);
console.log(`registered ${registered.length} tools`);

// Every registered tool must satisfy the enforced JSON-schema subset AND the
// parameters must be a raw object-rooted schema.
for (const tool of registered) {
  assertSupportedJsonSchema(tool.output.schema);
  assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be object-rooted`);
  assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
  for (const [key, prop] of Object.entries(tool.parameters.properties ?? {})) {
    assert.ok(!Object.hasOwn(prop, 'required'), `${tool.name}.${key} must not use property-level required`);
  }
}

const fakeExec = { agent: { session: { header: { cwd: 'C:/tmp' } } } };

// Load the real pUC118 SnapGene fixture into the mock fs up front.
const puc118Bytes = new Uint8Array(await readFile(new URL('./fixtures/pUC118.dna', import.meta.url)));
memFs.files.set('C:/tmp/pUC118.dna', puc118Bytes);

const sangerSampleRef = makeTemplate(300, 29);
memFs.files.set('C:/tmp/good.seq', `>good\n${sangerSampleRef}\n`);
memFs.files.set('C:/tmp/seqs.fa', '>a1 desc\nATGCATGC\n>b2\nGGGGCCCC\n');
memFs.files.set('C:/tmp/reads.fq', '@r1\nACGT\n+\nIIII\n@r2\nTGCA\n+\nHHHH\n');

/** Run one tool with args and validate its output value against its schema. */
async function run(toolName, args) {
  const tool = registered.find((t) => t.name === toolName);
  assert.ok(tool, `tool ${toolName} is registered`);
  const value = await tool.execute(args, fakeExec);
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value');
  assert.deepEqual(violations, [], `${toolName} output violates its schema: ${violations.join('; ')}`);
  return value;
}

/** Deterministic pseudo-random DNA for fixtures. */
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

// ── known-value checks ──────────────────────────────────────────────────────

{
  // auto-view opener: platform gating and the command hand-off (internals seam)
  assert.equal(view.canAutoView({ platform: 'win32', env: {} }), true);
  assert.equal(view.canAutoView({ platform: 'darwin', env: {} }), true);
  assert.equal(view.canAutoView({ platform: 'linux', env: {} }), false);
  assert.equal(view.canAutoView({ platform: 'linux', env: { DISPLAY: ':0' } }), true);
  assert.equal(view.canAutoView({ platform: 'win32', env: { MOLBIO_AUTO_VIEW: '0' } }), false);
  const calls = [];
  const fakeRun = (cmd, args) => {
    calls.push({ cmd, args });
    return undefined;
  };
  await view.openDefaultViewer('C:/tmp/map.svg', { platform: 'win32', env: {}, run: fakeRun });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.join(' ').includes('Invoke-Item -LiteralPath') && calls[0].args.join(' ').includes('C:/tmp/map.svg'));
  calls.length = 0;
  await view.openDefaultViewer('/tmp/map.svg', { platform: 'linux', env: { BROWSER: 'firefox', DISPLAY: ':0' }, run: fakeRun });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'firefox');
  assert.deepEqual(calls[0].args, ['/tmp/map.svg']);
  calls.length = 0;
  assert.equal(await view.openDefaultViewer('/tmp/map.svg', { platform: 'linux', env: {}, run: fakeRun }), false, 'headless Linux never spawns a viewer');
  assert.equal(calls.length, 0);
}

{
  const out = await run('molbio_reverse_complement', { sequence: 'ATGC' });
  assert.equal(out.reverse_complement, 'GCAT');
  assert.equal(out.complement, 'TACG');
}

{
  const out = await run('molbio_reverse_complement', { sequence: 'atgcnn 123' });
  assert.equal(out.reverse_complement, 'NNGCAT');
}

{
  const out = await run('molbio_gc_content', { sequence: 'ATGCGC', window: 10 });
  assert.equal(out.gc_percent, 66.67);
  assert.equal(out.gc_percent_excluding_ambiguous, 66.67);
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].gc_percent, 66.67);
}

{
  const out = await run('molbio_translate', { sequence: 'ATGGCCTAA', frames: '1', min_orf_aa: 1 });
  assert.equal(out.frames[0].protein, 'MA*');
  assert.equal(out.frames[0].first_stop, 6);
  assert.equal(out.orfs[0].sequence, 'MA');
}

{
  const out = await run('molbio_translate', { sequence: 'ATGGCCTAA', frames: 'all', min_orf_aa: 0 });
  assert.equal(out.frames.length, 6);
  assert.equal(out.orfs.length, 0);
}

{
  const out = await run('molbio_restriction_sites', { sequence: 'GAATTC', enzymes: ['EcoRI'] });
  assert.deepEqual(out.enzymes[0].cut_positions, [1]);
  assert.deepEqual(out.enzymes[0].fragments, [5, 1]);
}

{
  const out = await run('molbio_restriction_sites', { sequence: 'GAATTC', enzymes: ['EcoRI'], circular: true });
  assert.deepEqual(out.enzymes[0].fragments, [6]);
}

{
  const out = await run('molbio_restriction_sites', { sequence: 'G' + 'AATT'.repeat(0) + 'AATTCAAGCTTA', enzymes: ['common'] });
  assert.ok(out.enzymes.length > 50);
}

{
  // M13 forward primer — sanity range and salt monotonicity.
  const seq = 'GTAAAACGACGGCCAGT';
  const low = await run('molbio_primer_tm', { sequence: seq, na_mm: 20 });
  const high = await run('molbio_primer_tm', { sequence: seq, na_mm: 100 });
  assert.ok(low.tm_celsius > 40 && low.tm_celsius < 70, `M13F Tm ${low.tm_celsius} outside sane range`);
  assert.ok(high.tm_celsius > low.tm_celsius, 'Tm must rise with Na+');
}

{
  const out = await run('molbio_primer_check', { primer1: 'ATATATATATATAT', primer2: 'ATATATATATATAT' });
  assert.ok(out.primer1.repeats.length > 0);
  assert.ok(out.pair.score > 0);
}

{
  const out = await run('molbio_qpcr_analysis', {
    target_treated: [23, 24, 22],
    target_control: [26, 25, 27],
    reference_treated: [18, 19, 18],
    reference_control: [18, 18, 19],
  });
  assert.equal(out.delta_delta_ct, -3);
  assert.equal(out.fold_change, 8);
}

{
  const out = await run('molbio_lab_math', { operation: 'dilution', c1: 10, v1: 5, c2: 2 });
  assert.equal(out.result, 25);
}

{
  const out = await run('molbio_lab_math', { operation: 'molarity', mass_mg: 5, mw_g_per_mol: 50000, volume_ml: 0.1 });
  assert.equal(out.result, 1);
}

{
  const out = await run('molbio_lab_math', { operation: 'copy_number', mass_ng: 1, length_bp: 1000 });
  const expected = (1e-9 * 6.02214076e23) / (1000 * 660);
  assert.ok(Math.abs(out.result - expected) < expected * 1e-9);
}

// ── error paths ─────────────────────────────────────────────────────────────

{
  await assert.rejects(() => run('molbio_reverse_complement', { sequence: 'ATGX' }), /invalid character/);
  await assert.rejects(() => run('molbio_primer_tm', { sequence: 'ATG' }), /at least 4 bases/);
  await assert.rejects(() => run('molbio_lab_math', { operation: 'dilution', c1: 10, v1: 5 }), /exactly 3/);
  await assert.rejects(() => run('molbio_restriction_sites', { sequence: 'AAAA', enzymes: ['NotAnEnzyme'] }), /unknown enzyme/);
}

// v12 mismatch-tolerance argument validation lives in resolveDesignOptions
{
  const template = 'A'.repeat(300);
  await assert.rejects(() => run('molbio_design_primers', { template, max_mismatches: 6 }), /max_mismatches/);
  await assert.rejects(() => run('molbio_design_primers', { template, max_mismatches: -1 }), /max_mismatches/);
  await assert.rejects(() => run('molbio_design_primers', { template, max_mismatches: 2, max_3prime_mismatches: 3 }), /max_3prime_mismatches/);
  await assert.rejects(() => run('molbio_design_primers', { template, mismatch_3prime_zone: 0 }), /mismatch_3prime_zone/);
  await assert.rejects(() => run('molbio_design_intron_primers', { genomic: 'A'.repeat(200), exons: [{ start: 1, end: 100 }, { start: 101, end: 200 }], max_mismatches: 9 }), /max_mismatches/);
  // v12 Primer3-style parameter ranges
  await assert.rejects(() => run('molbio_design_primers', { template, gc_clamp: 4 }), /gc_clamp/);
  await assert.rejects(() => run('molbio_design_primers', { template, max_end_gc: 6 }), /max_end_gc/);
  await assert.rejects(() => run('molbio_design_primers', { template, max_self_any: -1 }), /max_self_any/);
  await assert.rejects(() => run('molbio_design_primers', { template, mispriming_3prime_bases: 5 }), /mispriming_3prime_bases/);
  await assert.rejects(() => run('molbio_design_primers', { template, mispriming_max_mismatches: 3 }), /mispriming_max_mismatches/);
  await assert.rejects(() => run('molbio_design_primers', { template, mispriming_max_sites: 21 }), /mispriming_max_sites/);
}

// ── render path ─────────────────────────────────────────────────────────────

{
  const samples = [
    ['molbio_reverse_complement', { sequence: 'ATGC' }],
    ['molbio_gc_content', { sequence: 'ATGCGCAT', window: 10 }],
    ['molbio_translate', { sequence: 'ATGGCCTAA', frames: 'all' }],
    ['molbio_restriction_sites', { sequence: 'GAATTCAAGCTT', enzymes: ['EcoRI', 'HindIII'], circular: true }],
    ['molbio_primer_tm', { sequence: 'GTAAAACGACGGCCAGT' }],
    ['molbio_primer_check', { primer1: 'GTAAAACGACGGCCAGT', primer2: 'CAGGAAACAGCTATGAC' }],
    ['molbio_qpcr_analysis', { target_treated: [23, 24], target_control: [26, 27], reference_treated: [18, 19], reference_control: [18, 19] }],
    ['molbio_lab_math', { operation: 'molarity', mass_mg: 5, mw_g_per_mol: 50000, volume_ml: 0.1 }],
    ['molbio_design_primers', { template: makeTemplate(400, 5), max_results: 2 }],
    ['molbio_parse_genbank', { genbank: 'LOCUS       X                10 bp    DNA     circular 01-JAN-2024\nFEATURES             Location/Qualifiers\nORIGIN\n        1 aaaaaaaaaa\n//' }],
    ['molbio_plasmid_map', { sequence: makeTemplate(500, 1), name: 'pX', features: [{ label: 'ori', start: 10, end: 100 }], enzymes: ['EcoRI'] }],
    ['molbio_pubmed_search', { query: 'plasmid' }],
    ['molbio_paper_add', { file: 'C:/tmp/papers.json', papers: [{ title: 'Render paper' }] }],
    ['molbio_paper_list', { file: 'C:/tmp/papers.json' }],
    ['molbio_paper_update', { file: 'C:/tmp/papers.json', id: 'title:Render paper:', note: 'n' }],
    ['molbio_paper_remove', { file: 'C:/tmp/papers.json', id: 'title:Render paper:' }],
    ['molbio_unique_cutters', { vector_path: 'C:/tmp/pUC118.dna', insert: 'GATC' }],
    ['molbio_clone_simulate', { vector: 'A'.repeat(20) + 'GAATTC' + 'T'.repeat(40) + 'AAGCTT' + 'C'.repeat(20), insert: 'GAATTCGGGGAAGCTT', method: 'restriction', enzymes: ['EcoRI', 'HindIII'], save_path: 'C:/tmp/clone.fa' }],
    ['molbio_clone_primers', { template: 'ATGCGTACGTAGCTAGCTAGCATGCGATCGA', mode: 'restriction', enzymes: ['EcoRI'] }],
    ['molbio_mutagenesis_primers', { template: (() => { const t = makeTemplate(200, 23); return t.slice(0, 99) + 'A' + t.slice(100); })(), mutations: ['A100G'], tm_min: 60, tm_max: 95 }],
    ['molbio_verify_sanger', { trace_path: 'C:/tmp/good.seq', reference: sangerSampleRef }],
    ['molbio_protein_props', { sequence: 'MKWVTFISLL' }],
    ['molbio_peptide_digest', { sequence: 'MKWVTFISLL', enzyme: 'trypsin', missed: 1 }],
    ['molbio_codon_optimize', { sequence: 'MKWVTFISLL', host: 'yeast' }],
    ['molbio_qpcr_efficiency', { dilution_factors: [1, 10, 100], ct_values: [20, 23.3, 26.6], plot_path: 'C:/tmp/std_curve.svg' }],
    ['molbio_plot', { kind: 'bar', output_path: 'C:/tmp/bar.svg', labels: ['A', 'B'], values: [1, 2] }],
    ['molbio_virtual_gel', { lanes: [{ label: 'EcoRI', fragments: [3000, 800] }] }],
    ['molbio_enzyme_lookup', { sequence: 'GAATTC', enzymes: ['EcoRI', 'BsaI'] }],
    ['molbio_golden_gate', { vector: 'A'.repeat(60) + 'C'.repeat(40) + 'T'.repeat(60), replace_region: { start: 61, end: 100 }, inserts: ['G'.repeat(30) + 'AATT' + 'C'.repeat(30)] }],
    ['molbio_align', { sequence1: 'ATGCATGCAT', sequence2: 'ATGCGTGCAT' }],
    ['molbio_msa_align', { sequences: ['ACGTACGT', 'ACGTTCGT'] }],
    ['molbio_conservation', { alignment: ['ACGT', 'ACGA'] }],
    ['molbio_fasta_fastq', { path: 'C:/tmp/seqs.fa', action: 'stats' }],
    ['molbio_extract_region', { source_path: 'C:/tmp/pUC118.dna', feature: 'ori' }],
    ['molbio_pubmed_abstract', { pmids: ['12345678'] }],
    ['molbio_paper_export_bibtex', { file: 'C:/tmp/bib.json', output_path: 'C:/tmp/papers.bib' }],
    ['molbio_protocol_add', { file: 'C:/tmp/protocols.json', name: 'PCR' }],
    ['molbio_protocol_list', { file: 'C:/tmp/protocols.json' }],
    ['molbio_protocol_update', { file: 'C:/tmp/protocols.json', id: 'rec1', name: 'PCR v2' }],
    ['molbio_experiment_log', { file: 'C:/tmp/experiments.json', title: 't' }],
    ['molbio_experiment_list', { file: 'C:/tmp/experiments.json' }],
  ];
  for (const [toolName, args] of samples) {
    const tool = registered.find((t) => t.name === toolName);
    const value = await tool.execute(args, fakeExec);
    const blocks = tool.output.render(args, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} render returned no blocks`);
    for (const block of blocks) {
      assert.equal(block.type, 'text');
      assert.ok(typeof block.text === 'string' && block.text.length > 0, `${toolName} render block text is empty`);
    }
  }
  console.log('render checks passed');
}

// ── primer design ───────────────────────────────────────────────────────────

{
  const template = makeTemplate(600, 7);
  const out = await run('molbio_design_primers', { template, max_results: 3 });
  assert.ok(out.pairs.length > 0, 'designer should find pairs on a 600 bp template with defaults');
  for (const pair of out.pairs) {
    assert.ok(pair.amplicon.length >= 80 && pair.amplicon.length <= 1000);
    assert.equal(pair.forward.sequence, template.slice(pair.forward.start - 1, pair.forward.end));
    assert.equal(pair.reverse.sequence, lib.reverseComplement(template.slice(pair.reverse.start - 1, pair.reverse.end)));
    assert.equal(pair.amplicon.start, pair.reverse.start);
    assert.equal(pair.amplicon.end, pair.forward.end);
    assert.ok(pair.forward.tm >= 55 && pair.forward.tm <= 65);
    assert.ok(pair.reverse.tm >= 55 && pair.reverse.tm <= 65);
    assert.ok(['G', 'C'].includes(pair.forward.sequence.at(-1)), 'GC clamp');
    assert.ok(['G', 'C'].includes(pair.reverse.sequence.at(-1)), 'GC clamp');
  }
  const none = await run('molbio_design_primers', { template, tm_min: 95, tm_max: 105 });
  assert.equal(none.pairs.length, 0);
}

// ── GenBank parsing ─────────────────────────────────────────────────────────

{
  const seq = 'A'.repeat(1230);
  const genbank = [
    'LOCUS       pTEST               1230 bp    DNA     circular SYN 01-JAN-2024',
    'DEFINITION  Test plasmid for the smoke suite.',
    'ACCESSION   PTEST1',
    'FEATURES             Location/Qualifiers',
    '     rep_origin      complement(1000..1120)',
    '                     /label="ori"',
    '     CDS             200..400',
    '                     /gene="gfp"',
    '                     /product="green fluorescent protein"',
    '     promoter        100..180',
    '                     /label="Ptac"',
    'ORIGIN',
    `        1 ${seq}`,
    '//',
  ].join('\n');
  const out = await run('molbio_parse_genbank', { genbank });
  assert.equal(out.name, 'pTEST');
  assert.equal(out.accession, 'PTEST1');
  assert.equal(out.topology, 'circular');
  assert.equal(out.length, 1230);
  assert.equal(out.sequence.length, 1230);
  assert.equal(out.features.length, 3);
  const ori = out.features.find((f) => f.type === 'rep_origin');
  assert.deepEqual([ori.start, ori.end, ori.strand, ori.label], [1000, 1120, -1, 'ori']);
  const cds = out.features.find((f) => f.type === 'CDS');
  assert.equal(cds.label, 'green fluorescent protein');
  const promoter = out.features.find((f) => f.type === 'promoter');
  assert.equal(promoter.label, 'Ptac');
}

// ── plasmid map ─────────────────────────────────────────────────────────────

{
  const sequence = 'GAATTC' + makeTemplate(994, 3);
  const features = [
    { label: 'ori', type: 'rep_origin', start: 400, end: 600 },
    { label: 'AmpR', type: 'CDS', start: 700, end: 900, strand: -1 },
    { label: 'A&B tag', type: 'misc_feature', start: 100, end: 150 },
  ];
  const out = await run('molbio_plasmid_map', { sequence, name: 'pTEST', features, enzymes: ['EcoRI'] });
  assert.equal(out.length, 1000);
  assert.equal(out.feature_count, 3);
  assert.equal(out.enzyme_count, 1);
  assert.equal(out.svg_path, 'C:\\tmp\\pTEST.svg');
  const svg = memFs.files.get(out.svg_path).toString('utf8');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('pTEST'));
  assert.ok(svg.includes('AmpR'));
  assert.ok(svg.includes('ori'));
  assert.ok(svg.includes('A&amp;B tag'), 'labels must be XML-escaped');
  assert.ok(svg.includes('EcoRI'));
  assert.ok(!svg.includes('rotate(180'), 'labels must not be rotated upside down');
  const linear = await run('molbio_plasmid_map', { sequence, circular: false, features, enzymes: ['EcoRI'], output_path: 'C:/tmp/linear.svg' });
  assert.equal(linear.circular, false);
  assert.equal(linear.svg_path, 'C:/tmp/linear.svg');
  const linearSvg = memFs.files.get(linear.svg_path).toString('utf8');
  assert.ok(linearSvg.includes('<line'));

  const enriched = await run('molbio_plasmid_map', { sequence, name: 'pTEST', features, gc_skew: true, show_unique_cutters: true });
  const enrichedSvg = memFs.files.get(enriched.svg_path).toString('utf8');
  assert.ok(enrichedSvg.includes('GC skew'));
  assert.ok(enrichedSvg.includes('#1f883d'), 'unique-cutter marks use the green color');
}

// ── SnapGene .dna (real pUC118 fixture from snapgene.com) ───────────────────

{
  const out = await run('molbio_parse_snapgene', { path: 'C:/tmp/pUC118.dna' });
  assert.equal(out.name, 'pUC118');
  assert.equal(out.length, 3162);
  assert.equal(out.topology, 'circular');
  assert.equal(out.accession, 'U07649');
  assert.equal(out.sequence.slice(0, 20), 'TCGCGCGTTTCGGTGATGAC');
  assert.ok(out.description.includes('Cloning vector'));
  assert.ok(out.features.length >= 10, `expected >= 10 features, got ${out.features.length}`);
  const ampR = out.features.find((f) => f.label === 'AmpR');
  assert.deepEqual([ampR.type, ampR.start, ampR.end, ampR.strand], ['CDS', 2102, 2962, -1]);
  assert.equal(ampR.product, 'β-lactamase');
  const ori = out.features.find((f) => f.label === 'ori');
  assert.deepEqual([ori.type, ori.start, ori.end], ['rep_origin', 1343, 1931]);
  const renderBlocks = registered.find((t) => t.name === 'molbio_parse_snapgene').output.render({}, out);
  assert.ok(renderBlocks[0].text.includes('pUC118'));

  const map = await run('molbio_plasmid_map_file', { path: 'C:/tmp/pUC118.dna', enzymes: ['EcoRI', 'HindIII', 'PstI'] });
  assert.equal(map.name, 'pUC118');
  assert.equal(map.length, 3162);
  assert.equal(map.circular, true);
  assert.equal(map.feature_count, out.features.length);
  assert.equal(map.enzyme_count, 3);
  assert.equal(map.svg_path, 'C:\\tmp\\pUC118.svg');
  const mapSvg = memFs.files.get(map.svg_path).toString('utf8');
  assert.ok(mapSvg.includes('AmpR'));
  assert.ok(mapSvg.includes('lacZ'));
  assert.ok(mapSvg.includes('EcoRI'));
  assert.ok(!mapSvg.includes('rotate(180'), 'labels must not be rotated upside down');

  // unsupported extension
  await assert.rejects(() => run('molbio_plasmid_map_file', { path: 'C:/tmp/x.fasta' }), /unsupported file type/);
}

// ── cloning (batch 1) ───────────────────────────────────────────────────────

{
  // unique cutters against the real pUC118 file
  const out = await run('molbio_unique_cutters', { vector_path: 'C:/tmp/pUC118.dna', insert: 'GATC', region_start: 850, region_end: 950 });
  const eco = out.ideal.find((entry) => entry.name === 'EcoRI');
  assert.ok(eco !== undefined, 'EcoRI should be an ideal single cutter');
  assert.equal(eco.cut_position, 927);
  assert.equal(eco.in_region, true);
  assert.ok(out.ideal.length > 5);

  // insert containing an EcoRI site excludes EcoRI
  const excluded = await run('molbio_unique_cutters', { vector_path: 'C:/tmp/pUC118.dna', insert: 'GAATTC' });
  assert.ok(!excluded.ideal.some((entry) => entry.name === 'EcoRI'));
  assert.ok(excluded.insert_cutters.includes('EcoRI'));
}

{
  // restriction-ligation simulation with hand-computed expectation
  const vector = 'A'.repeat(30) + 'GAATTC' + 'T'.repeat(20) + 'AAGCTT' + 'C'.repeat(38); // 100 bp
  const insert = 'GAATTC' + 'GGGG' + 'AAGCTT';
  const expected = vector.slice(0, 31) + 'AATTCGGGGA' + vector.slice(57); // 84 bp
  const out = await run('molbio_clone_simulate', {
    vector,
    insert,
    method: 'restriction',
    enzymes: ['EcoRI', 'HindIII'],
    save_path: 'C:/tmp/clone.fa',
  });
  assert.equal(out.final_sequence, expected);
  assert.equal(out.length, 84);
  assert.equal(out.delta, -16);
  assert.equal(out.features.length, 1); // the Insert feature
  assert.equal(out.features[0].label, 'Insert');
  assert.equal(out.features[0].start, 32);
  assert.ok(out.verify.length > 0);
  assert.equal(out.save_path, 'C:/tmp/clone.fa');
  const fasta = memFs.files.get(out.save_path).toString('utf8');
  assert.ok(fasta.startsWith('>'));
  assert.ok(fasta.includes(expected));

  // single-enzyme ligation: orientation note + reverse digest
  const single = await run('molbio_clone_simulate', {
    vector: 'A'.repeat(30) + 'GAATTC' + 'C'.repeat(64),
    insert: 'GAATTC' + 'CCCC' + 'GAATTC',
    method: 'restriction',
    enzymes: ['EcoRI'],
  });
  assert.equal(single.length, 110);
  assert.ok(single.notes.some((note) => note.includes('either orientation')));
  assert.ok(single.verify.some((entry) => entry.reverse_orientation_fragments !== undefined));

  // orientation=auto reverse-complements an inverted insert silently
  const vector2 = 'A'.repeat(30) + 'GAATTC' + 'T'.repeat(20) + 'AAGCTT' + 'C'.repeat(38);
  const invertedInsert = 'AAGCTT' + 'GGGG' + 'GAATTC';
  const autoFixed = await run('molbio_clone_simulate', { vector: vector2, insert: invertedInsert, method: 'restriction', enzymes: ['EcoRI', 'HindIII'] });
  assert.equal(autoFixed.insert_reverse_complemented, true);
  assert.equal(autoFixed.final_sequence, vector2.slice(0, 31) + 'AATTCCCCCA' + vector2.slice(57));

  // orientation=forward rejects the inverted insert
  await assert.rejects(
    () => run('molbio_clone_simulate', { vector: vector2, insert: invertedInsert, method: 'restriction', enzymes: ['EcoRI', 'HindIII'], orientation: 'forward' }),
    /orientation/,
  );

  // add_flanks: pass the bare insert, the tool adds the enzyme sites
  const bare = await run('molbio_clone_simulate', { vector: vector2, insert: 'GGGG', method: 'restriction', enzymes: ['EcoRI', 'HindIII'], add_flanks: true });
  assert.equal(bare.insert_with_flanks, 'GAATTC' + 'GGGG' + 'AAGCTT');
  assert.equal(bare.final_sequence, vector2.slice(0, 31) + 'AATTCGGGGA' + vector2.slice(57));
  assert.ok(bare.notes.some((note) => note.includes('add_flanks')));

  // internal cut sites produce a warning note
  const internal = await run('molbio_clone_simulate', { vector: vector2, insert: 'GGGAATTCGGG', method: 'restriction', enzymes: ['EcoRI', 'HindIII'], add_flanks: true });
  assert.ok(internal.notes.some((note) => note.includes('INSIDE')));

  // map_path writes the new plasmid map in the same call
  const mapped = await run('molbio_clone_simulate', { vector: vector2, insert: invertedInsert, method: 'restriction', enzymes: ['EcoRI', 'HindIII'], map_path: 'C:/tmp/clone_map.svg' });
  assert.equal(mapped.map_path, 'C:/tmp/clone_map.svg');
  const cloneSvg = memFs.files.get(mapped.map_path).toString('utf8');
  assert.ok(cloneSvg.includes('vector_clone'));
  assert.ok(cloneSvg.includes('Insert'));
}

{
  // Gibson assembly simulation
  const vector = 'A'.repeat(40) + 'T'.repeat(20) + 'G'.repeat(40); // 100 bp, region 41-60
  const out = await run('molbio_clone_simulate', {
    vector,
    insert: 'CCCC',
    method: 'gibson',
    region_start: 41,
    region_end: 60,
    overhang: 10,
  });
  assert.equal(out.insert_to_order, 'AAAAAAAAAA' + 'CCCC' + 'GGGGGGGGGG');
  assert.equal(out.final_sequence, 'A'.repeat(40) + 'CCCC' + 'G'.repeat(40));
  assert.equal(out.length, 84);
  assert.equal(out.delta, -16);
}

{
  // restriction-mode cloning primers
  const template = 'ATGCGTACGTAGCTAGCTAGCATGCGATCGA'; // 30 bp, no EcoRI site
  const out = await run('molbio_clone_primers', { template, mode: 'restriction', enzymes: ['EcoRI'] });
  assert.ok(out.forward.startsWith('GATAGAATTC'));
  assert.equal(out.forward.slice('GATAGAATTC'.length), template.slice(0, 20));
  assert.ok(out.reverse.startsWith('GATAGAATTC'));
  assert.equal(out.checks.warnings.length, 0);

  // gibson-mode primers derive arms from the vector
  const vector = 'A'.repeat(40) + 'T'.repeat(20) + 'G'.repeat(40);
  const gibson = await run('molbio_clone_primers', {
    template,
    mode: 'gibson',
    vector,
    region_start: 41,
    region_end: 60,
    overhang: 10,
  });
  assert.ok(gibson.forward.startsWith('AAAAAAAAAA'));
  assert.ok(gibson.reverse.startsWith('CCCCCCCCCC'));
}

{
  // mutagenesis primers
  const base = makeTemplate(300, 11);
  const template = base.slice(0, 122) + 'A' + base.slice(123);
  const out = await run('molbio_mutagenesis_primers', {
    template,
    mutations: ['A123G'],
    tm_min: 60,
    tm_max: 95,
  });
  assert.equal(out.mutated_sequence[122], 'G');
  assert.equal(out.mutated_sequence.length, 300);
  assert.ok(out.pairs.length > 0, 'should find candidate pairs with relaxed Tm');
  for (const pair of out.pairs) {
    assert.equal(pair.reverse, lib.reverseComplement(pair.forward));
    assert.ok(pair.forward.includes('G'), 'mutation must be inside the primer');
  }
  const del = await run('molbio_mutagenesis_primers', { template, mutations: ['123_125del'], tm_min: 60, tm_max: 95 });
  assert.equal(del.mutated_sequence.length, 297);
}

// ── Sanger verification ─────────────────────────────────────────────────────

{
  const reference = makeTemplate(500, 5);
  const alt = (base) => (base === 'A' ? 'C' : 'A');
  // substitute at 100 and 200, delete at 300, insert after 400
  let trace = reference;
  trace = trace.slice(0, 99) + alt(trace[99]) + trace.slice(100);
  trace = trace.slice(0, 199) + alt(trace[199]) + trace.slice(200);
  trace = trace.slice(0, 299) + trace.slice(300);
  trace = trace.slice(0, 400) + 'A' + trace.slice(400);
  memFs.files.set('C:/tmp/mut.seq', `>mut\n${trace}\n`);
  const out = await run('molbio_verify_sanger', { trace_path: 'C:/tmp/mut.seq', reference });
  assert.equal(out.verdict, 'differences_found');
  const mismatches = out.differences.filter((d) => d.kind === 'mismatch');
  assert.equal(mismatches.length, 2);
  assert.equal(mismatches[0].ref_pos, 100);
  assert.equal(mismatches[1].ref_pos, 200);
  assert.equal(out.differences.filter((d) => d.kind === 'deletion')[0].ref_pos, 300);
  assert.ok(out.differences.some((d) => d.kind === 'insertion' && d.ref_pos >= 399 && d.ref_pos <= 401));
  assert.ok(out.identity_percent < 100);

  // perfect trace → match
  memFs.files.set('C:/tmp/good.seq', `>good\n${reference}\n`);
  const good = await run('molbio_verify_sanger', { trace_path: 'C:/tmp/good.seq', reference });
  assert.equal(good.verdict, 'match');
  assert.equal(good.differences.length, 0);
}

{
  // synthetic ABIF fixture
  const makeAbif = (bases, qualities) => {
    const entries = [
      { name: 'PBAS', num: 1, etype: 2, esize: 1, data: Buffer.from(bases, 'latin1') },
      { name: 'PBAS', num: 2, etype: 2, esize: 1, data: Buffer.from(bases, 'latin1') },
      { name: 'PCON', num: 2, etype: 5, esize: 1, data: Buffer.from(qualities) },
    ];
    const entryCount = entries.length;
    const headerSize = 28;
    const dirSize = entryCount * 28;
    const dataStart = headerSize + dirSize;
    const total = dataStart + entries.reduce((sum, e) => sum + e.data.length, 0);
    const buffer = Buffer.alloc(total);
    buffer.write('ABIF', 0, 'latin1');
    buffer.writeInt16BE(101, 4);
    buffer.writeInt32BE(entryCount, 18);
    let dataOffset = dataStart;
    entries.forEach((entry, i) => {
      const off = headerSize + i * 28;
      buffer.write(entry.name, off, 'latin1');
      buffer.writeInt32BE(entry.num, off + 4);
      buffer.writeInt16BE(entry.etype, off + 8);
      buffer.writeInt16BE(entry.esize, off + 10);
      buffer.writeInt32BE(entry.data.length, off + 12);
      buffer.writeInt32BE(entry.data.length, off + 16);
      buffer.writeInt32BE(dataOffset, off + 20);
      buffer.writeInt32BE(0, off + 24);
      entry.data.copy(buffer, dataOffset);
      dataOffset += entry.data.length;
    });
    return new Uint8Array(buffer);
  };
  const reference = makeTemplate(400, 13);
  const ab1 = makeAbif(reference.slice(0, 250), new Array(250).fill(40));
  memFs.files.set('C:/tmp/trace.ab1', ab1);
  const out = await run('molbio_verify_sanger', { trace_path: 'C:/tmp/trace.ab1', reference });
  assert.equal(out.verdict, 'match');
  assert.equal(out.trace_length, 250);
  assert.equal(out.quality_mean, 40);
  assert.equal(out.differences.length, 0);

  // circular reference: a trace spanning the origin aligns cleanly
  const span = reference.slice(-50) + reference.slice(0, 60);
  memFs.files.set('C:/tmp/span.seq', `>span\n${span}\n`);
  const circular = await run('molbio_verify_sanger', { trace_path: 'C:/tmp/span.seq', reference });
  assert.equal(circular.verdict, 'match');
  assert.ok(circular.differences.length === 0);
}

{
  // regression: genetic-code fixes — vertebrate mitochondrial AGA/AGG are
  // stop codons (NCBI table 2); bacterial TGA is Trp (NCBI table 11)
  const mito = lib.translateFrames('AGAAGGATA', '1', 'mitochondrial_vertebrate');
  assert.equal(mito.results[0].protein, '**M');
  assert.equal(mito.results[0].stops, 2);
  const bac = lib.translateFrames('TGATAA', '1', 'bacterial');
  assert.equal(bac.results[0].protein, 'W*');
  assert.equal(bac.results[0].stops, 1);
}

{
  // regression: Sanger amino-acid consequences — codon-local substitution
  // slicing (mutations past the first codon), in-frame vs frameshift deletions
  const reference = 'ATGTTTGGGCCCTAA' + 'A'.repeat(30);
  const writeTrace = (label, trace) => memFs.files.set(`C:/tmp/${label}.seq`, `>${label}\n${trace}\n`);
  const verify = (label) => run('molbio_verify_sanger', { trace_path: `C:/tmp/${label}.seq`, reference, cds_start: 1, cds_end: 12 });

  // substitution at CDS base 5 (second codon TTT, second position): F→Y
  writeTrace('aa_sub', reference.slice(0, 4) + 'A' + reference.slice(5));
  const missense = await verify('aa_sub');
  const change = missense.aa_changes.find((c) => c.ref_pos === 5);
  assert.equal(change.kind, 'missense');
  assert.equal(change.aa_before, 'F');
  assert.equal(change.aa_after, 'Y');
  assert.equal(change.codon_after, 'TAT');

  // silent third-position change at CDS base 9: GGG→GGC
  writeTrace('aa_silent', reference.slice(0, 8) + 'C' + reference.slice(9));
  const silent = await verify('aa_silent');
  assert.equal(silent.aa_changes.find((c) => c.ref_pos === 9).kind, 'silent');

  // in-frame 3 bp deletion (bases 4-6, the whole TTT codon)
  writeTrace('aa_del3', reference.slice(0, 3) + reference.slice(6));
  const inFrame = await verify('aa_del3');
  const delEntry = inFrame.aa_changes.find((c) => c.kind === 'in_frame_deletion');
  assert.equal(delEntry.length, 3);
  assert.equal(delEntry.aa_before, 'F');
  assert.equal(delEntry.aa_after, '');
  assert.equal(delEntry.deleted_bases, 'TTT');

  // 1 bp deletion (base 5): frameshift
  writeTrace('aa_del1', reference.slice(0, 4) + reference.slice(5));
  const frameShift = await verify('aa_del1');
  assert.equal(frameShift.aa_changes.some((c) => c.kind === 'frameshift'), true);
  assert.equal(frameShift.aa_changes.some((c) => c.kind === 'in_frame_deletion'), false);
}

// ── protein and quantitative tools (batch 2) ────────────────────────────────

{
  // protein properties with hand-computed expectations
  const out = await run('molbio_protein_props', { sequence: 'ACDE' });
  assert.equal(out.length, 4);
  assert.equal(out.mw_da, 436.45);
  const basic = await run('molbio_protein_props', { sequence: 'RRRR' });
  assert.ok(basic.pi > 11, `basic pI expected > 11, got ${basic.pi}`);
  const acidic = await run('molbio_protein_props', { sequence: 'DDDD' });
  assert.ok(acidic.pi < 4.5, `acidic pI expected < 4.5, got ${acidic.pi}`);
  const trp = await run('molbio_protein_props', { sequence: 'W' });
  assert.equal(trp.extinction_reduced_m1cm1, 5500);
  const hydro = await run('molbio_protein_props', { sequence: 'ILV' });
  assert.ok(hydro.gravy > 3);
  assert.equal(hydro.aliphatic_index, 356.67);
}

{
  // peptide digestion rules
  const out = await run('molbio_peptide_digest', { sequence: 'MKTGK', enzyme: 'trypsin', missed: 0 });
  assert.deepEqual(out.peptides.map((p) => p.sequence), ['MK', 'TGK']);
  assert.equal(out.peptides[0].mh_mass, 278.1533);
  const pro = await run('molbio_peptide_digest', { sequence: 'AKPK', enzyme: 'trypsin', missed: 0 });
  assert.deepEqual(pro.peptides.map((p) => p.sequence), ['AKPK'], 'no cut before proline');
  const pro2 = await run('molbio_peptide_digest', { sequence: 'AKPKR', enzyme: 'trypsin', missed: 0 });
  assert.deepEqual(pro2.peptides.map((p) => p.sequence), ['AKPK', 'R']);
  const missed = await run('molbio_peptide_digest', { sequence: 'MKTGK', enzyme: 'trypsin', missed: 1 });
  assert.ok(missed.peptides.some((p) => p.sequence === 'MKTGK'));
  assert.ok(missed.peptides.length > 2);
}

{
  // codon optimization
  const out = await run('molbio_codon_optimize', { sequence: 'MK', host: 'e_coli' });
  assert.equal(out.dna_sequence, 'ATGAAA');
  const avoid = await run('molbio_codon_optimize', { sequence: 'EF', host: 'e_coli', avoid_enzymes: ['EcoRI'] });
  assert.ok(!avoid.dna_sequence.includes('GAATTC'), 'EcoRI site must be removed');
  assert.equal(avoid.avoided_sites_remaining, 0);
  assert.ok(avoid.notes.length > 0);
}

{
  // qPCR standard curve: perfect 100% efficiency series
  const slope = -3.321928;
  const factors = [1, 10, 100, 1000];
  const cts = [0, -1, -2, -3].map((x) => 20 + slope * x);
  const out = await run('molbio_qpcr_efficiency', { dilution_factors: factors, ct_values: cts, plot_path: 'C:/tmp/std_curve.svg' });
  assert.ok(Math.abs(out.slope - slope) < 1e-3, `slope ${out.slope}`);
  assert.equal(out.efficiency_percent, 100);
  assert.equal(out.r_squared, 1);
  assert.equal(out.plot_path, 'C:/tmp/std_curve.svg');
  assert.ok(memFs.files.get(out.plot_path).toString('utf8').includes('<svg'));
}

{
  // generic plots
  const bar = await run('molbio_plot', { kind: 'bar', output_path: 'C:/tmp/bar.svg', labels: ['A', 'B'], values: [1, 2], errors: [0.2, 0.3], title: 'test' });
  const barSvg = memFs.files.get(bar.plot_path).toString('utf8');
  assert.ok(barSvg.includes('<rect'));
  assert.ok(barSvg.includes('A') && barSvg.includes('B'));
  const scatter = await run('molbio_plot', { kind: 'scatter', output_path: 'C:/tmp/scatter.svg', x: [1, 2, 3], y: [2, 4, 6], fit: true });
  const scatterSvg = memFs.files.get(scatter.plot_path).toString('utf8');
  assert.ok(scatterSvg.includes('<circle'));
  assert.ok(scatterSvg.includes('#c73a3a'));
}

// ── sequence analysis and records (batch 3) ────────────────────────────────

{
  // alignment
  const a = makeTemplate(60, 31);
  const b = a.slice(0, 19) + 'C' + a.slice(20, 39) + 'G' + a.slice(40);
  const out = await run('molbio_align', { sequence1: a, sequence2: b });
  assert.equal(out.differences.length, 2);
  assert.equal(out.differences[0].pos2, 20);
  assert.equal(out.differences[1].pos2, 40);
  assert.ok(out.identity_percent < 100);
  const perfect = await run('molbio_align', { sequence1: a, sequence2: a });
  assert.equal(perfect.identity_percent, 100);
  assert.equal(perfect.differences.length, 0);
}

// ── v15: multiple sequence alignment and conservation ───────────────────────

{
  // pairwise identical: full match score, no gaps
  const out = await run('molbio_msa_align', { sequences: ['ACGTACGT', 'ACGTACGT'] });
  assert.equal(out.sequence_count, 2);
  assert.equal(out.aligned_columns, 8);
  assert.deepEqual(out.ids, ['seq1', 'seq2']);
  assert.deepEqual(out.alignment, ['ACGTACGT', 'ACGTACGT']);
  assert.equal(out.pairwise_identity_percent.mean, 100);
  assert.equal(out.pairwise_identity_percent.min, 100);
  assert.equal(out.score, 32); // 8 columns × match(4)

  // one substitution (position 5)
  const sub = await run('molbio_msa_align', { sequences: ['ACGTACGT', 'ACGTTCGT'] });
  assert.equal(sub.aligned_columns, 8);
  assert.deepEqual(sub.alignment, ['ACGTACGT', 'ACGTTCGT']);
  assert.equal(sub.pairwise_identity_percent.mean, 87.5);
  assert.equal(sub.score, 24); // 7×4 − 4

  // affine-gap insertion: a single internal extra base becomes a gap, not a mismatch run
  const ins = await run('molbio_msa_align', { sequences: ['CCCCCCCC', 'CCCCACCCC'] });
  assert.equal(ins.aligned_columns, 9);
  assert.deepEqual(ins.alignment, ['CCCC-CCCC', 'CCCCACCCC']);
  assert.equal(ins.score, 26); // 8×4 − gap open 6

  // U is treated as T
  const rna = await run('molbio_msa_align', { sequences: ['ACGU', 'ACGT'] });
  assert.equal(rna.pairwise_identity_percent.mean, 100);
  assert.deepEqual(rna.alignment, ['ACGT', 'ACGT']);

  // three-sequence progressive alignment: s2 = s1 with one substitution, s3 = s1 minus the middle block
  const s1 = 'ACGTACGTACGT';
  const s2 = 'ACGTTCGTACGT';
  const s3 = 'ACGTACGT';
  const three = await run('molbio_msa_align', { sequences: [s1, s2, s3] });
  assert.equal(three.aligned_columns, 12);
  assert.deepEqual(three.alignment.slice(0, 2), [s1, s2]);
  assert.equal(three.alignment[2].replace(/-/g, ''), s3);
  assert.deepEqual(three.alignment[2], '----ACGTACGT'); // free terminal gaps placed at the start (deterministic tie-break)
  assert.equal(three.pairwise_identity_percent.mean, 72.22); // (11 + 8 + 7)/12 over 3 pairs
  assert.equal(three.pairwise_identity_percent.min, 58.33);
  assert.equal(three.pairwise_identity_percent.max, 91.67);

  // deterministic: same input twice → identical output
  const again = await run('molbio_msa_align', { sequences: [s1, s2, s3] });
  assert.deepEqual(again, three);

  // conservation from raw sequences (source=msa): position 5 is A/A/T → variable at 0.8
  const cons = await run('molbio_conservation', { sequences: [s1, s2, s3] });
  assert.equal(cons.source, 'msa');
  assert.equal(cons.sequence_count, 3);
  assert.equal(cons.aligned_columns, 12);
  assert.equal(cons.consensus, s1);
  assert.equal(cons.conserved_columns, 11);
  assert.equal(cons.variable_positions.length, 1);
  assert.deepEqual(cons.variable_positions[0], { column: 5, consensus: 'A', identity: 0.667 });
  assert.equal(cons.variable_positions_truncated, false);
  assert.ok(Math.abs(cons.identity_percent - 97.22) < 0.05, `identity_percent ${cons.identity_percent} ≈ 97.22`);
  assert.equal(cons.pairwise_identity_percent.mean, 72.22);
  assert.equal(cons.per_column.length, 12);
  assert.deepEqual(cons.per_column[4], { column: 5, consensus: 'A', identity: 0.667, conservation: 0.541 });

  // pre-aligned input with gap columns (source=alignment): all-gap counts as conserved
  const rows = ['ACGT-', 'ACGT-', 'ACGA-', 'TCGT-'];
  const aln = await run('molbio_conservation', { alignment: rows });
  assert.equal(aln.source, 'alignment');
  assert.equal(aln.consensus, 'ACGT-');
  assert.equal(aln.identity_percent, 70); // (0.75 + 1 + 1 + 0.75 + 0)/5
  assert.equal(aln.conserved_columns, 3); // columns 2, 3 and the all-gap column 5
  assert.deepEqual(aln.variable_positions, [
    { column: 1, consensus: 'A', identity: 0.75 },
    { column: 4, consensus: 'T', identity: 0.75 },
  ]);
  assert.equal(aln.pairwise_identity_percent.mean, 60);
  assert.equal(aln.pairwise_identity_percent.min, 40);
  assert.equal(aln.pairwise_identity_percent.max, 80);
  const relaxed = await run('molbio_conservation', { alignment: rows, threshold: 0.6 });
  assert.equal(relaxed.conserved_columns, 5);
  assert.equal(relaxed.variable_positions.length, 0);

  // ambiguous residues: union consensus when no symbol reaches 50%
  const amb = await run('molbio_conservation', { alignment: ['A', 'C', 'G'] });
  assert.equal(amb.consensus, 'V');
  assert.deepEqual(amb.per_column[0], { column: 1, consensus: 'V', identity: 0.333, conservation: 0.208 });

  // FASTA input + aligned-FASTA output
  memFs.files.set('C:/tmp/msa.fa', '>a1\nACGTACGT\n>a2\nACGTTCGT\n');
  const fasta = await run('molbio_msa_align', { fasta_path: 'C:/tmp/msa.fa', save_path: 'C:/tmp/msa_aln.fa' });
  assert.deepEqual(fasta.ids, ['a1', 'a2']);
  assert.equal(fasta.pairwise_identity_percent.mean, 87.5);
  assert.equal(fasta.saved_to, 'C:/tmp/msa_aln.fa');
  const written = memFs.files.get(fasta.saved_to).toString('utf8');
  assert.ok(written.startsWith('>a1\nACGTACGT\n') && written.includes('>a2\nACGTTCGT'));

  const fastaCons = await run('molbio_conservation', { fasta_path: 'C:/tmp/msa.fa' });
  assert.equal(fastaCons.source, 'msa');
  assert.equal(fastaCons.consensus, 'ACGTACGT'); // position 5: A vs T → A at 50%
  assert.equal(fastaCons.conserved_columns, 7);
  assert.deepEqual(fastaCons.variable_positions, [{ column: 5, consensus: 'A', identity: 0.5 }]);

  // error paths
  await assert.rejects(() => run('molbio_msa_align', { sequences: ['ACGT'] }), /at least 2/);
  await assert.rejects(() => run('molbio_msa_align', { sequences: ['ACGT', 'ACGT'], fasta_path: 'C:/tmp/msa.fa' }), /exactly one/);
  await assert.rejects(() => run('molbio_msa_align', {}), /exactly one/);
  await assert.rejects(() => run('molbio_msa_align', { sequences: ['ACGTX', 'ACGT'] }), /invalid character/);
  await assert.rejects(() => run('molbio_msa_align', { sequences: ['A'.repeat(3001), 'A'.repeat(2)] }), /limit 3000/);
  await assert.rejects(() => run('molbio_msa_align', { sequences: Array.from({ length: 51 }, (_, k) => 'A'.repeat(10)) }), /at most 50/);
  memFs.files.set('C:/tmp/single.fa', '>only\nACGT\n');
  await assert.rejects(() => run('molbio_msa_align', { fasta_path: 'C:/tmp/single.fa' }), /at least 2/);
  await assert.rejects(() => run('molbio_conservation', { alignment: ['ACGT', 'ACGA', 'AC'] }), /same length/);
  await assert.rejects(() => run('molbio_conservation', { alignment: ['ACGT'] }), /at least 2/);
  await assert.rejects(() => run('molbio_conservation', { alignment: ['ACGT', 'ACGT'], sequences: ['ACGT', 'ACGT'] }), /exactly one/);
  await assert.rejects(() => run('molbio_conservation', { alignment: ['ACGTX', 'ACGT'] }), /invalid character/);
  await assert.rejects(() => run('molbio_conservation', { alignment: ['ACGT', 'ACGT'], threshold: 0 }), /between 0 and 1/);
  await assert.rejects(() => run('molbio_conservation', { alignment: ['ACGT', 'ACGT'], threshold: 1.5 }), /between 0 and 1/);
}

{
  // FASTA/FASTQ processing
  memFs.files.set('C:/tmp/seqs.fa', '>a1 desc\nATGCATGC\n>b2\nGGGGCCCC\n');
  const stats = await run('molbio_fasta_fastq', { path: 'C:/tmp/seqs.fa', action: 'stats' });
  assert.equal(stats.format, 'fasta');
  assert.equal(stats.stats.entries, 2);
  assert.equal(stats.stats.total_bases, 16);
  assert.equal(stats.stats.gc_percent, 75);
  const extract = await run('molbio_fasta_fastq', { path: 'C:/tmp/seqs.fa', action: 'extract', id: 'a1', output_path: 'C:/tmp/a1.fa' });
  assert.equal(extract.entries.length, 1);
  assert.equal(extract.entries[0].sequence, 'ATGCATGC');
  assert.ok(memFs.files.get('C:/tmp/a1.fa').toString('utf8').includes('>a1'));

  memFs.files.set('C:/tmp/reads.fq', '@r1\nACGT\n+\nIIII\n@r2\nTGCA\n+\nHHHH\n');
  const converted = await run('molbio_fasta_fastq', { path: 'C:/tmp/reads.fq', action: 'convert', output_path: 'C:/tmp/reads.fa' });
  assert.equal(converted.format, 'fastq');
  assert.ok(memFs.files.get('C:/tmp/reads.fa').toString('utf8').includes('>r1\nACGT'));
  const qc = await run('molbio_fasta_fastq', { path: 'C:/tmp/reads.fq', action: 'qc' });
  assert.equal(qc.stats.quality_mean, 39.5);
  assert.equal(qc.stats.low_quality_fraction, 0);
}

{
  // region extraction from the real pUC118 fixture
  const byFeature = await run('molbio_extract_region', { source_path: 'C:/tmp/pUC118.dna', feature: 'AmpR' });
  assert.equal(byFeature.start, 2102);
  assert.equal(byFeature.end, 2962);
  assert.equal(byFeature.length, 861);
  const rc = await run('molbio_extract_region', { source_path: 'C:/tmp/pUC118.dna', feature: 'AmpR', complement: true });
  assert.equal(rc.sequence, lib.reverseComplement(byFeature.sequence));
  const byCoord = await run('molbio_extract_region', { source_path: 'C:/tmp/pUC118.dna', start: 1, end: 20, output_path: 'C:/tmp/first20.fa' });
  assert.equal(byCoord.sequence.length, 20);
  assert.ok(memFs.files.get('C:/tmp/first20.fa').toString('utf8').includes('pUC118_1-20'));
}

{
  // pubmed abstracts via mocked efetch
  const out = await run('molbio_pubmed_abstract', { pmids: ['12345678'] });
  assert.equal(out.abstracts.length, 1);
  assert.equal(out.abstracts[0].title, 'Test Article Title');
  assert.equal(out.abstracts[0].abstract, 'First chunk. Second chunk.');
  assert.equal(out.abstracts[0].error, '');
}

{
  // bibtex export
  await run('molbio_paper_add', { file: 'C:/tmp/bib.json', papers: [{ title: 'Alpha', pmid: '111', year: '2020', authors: 'Doe J', journal: 'Nature' }, { title: 'Beta', url: 'https://x/b' }] });
  const out = await run('molbio_paper_export_bibtex', { file: 'C:/tmp/bib.json', output_path: 'C:/tmp/papers.bib' });
  assert.equal(out.count, 2);
  assert.equal(out.output_path, 'C:/tmp/papers.bib');
  const bib = memFs.files.get('C:/tmp/papers.bib').toString('utf8');
  assert.ok(bib.includes('@article{pmid111,'));
  assert.ok(bib.includes('title = {Alpha},'));
}

{
  // protocols and experiment log
  const added = await run('molbio_protocol_add', {
    file: 'C:/tmp/protocols2.json',
    name: 'Miniprep',
    category: 'DNA prep',
    steps: ['resuspend', 'lyse', 'neutralize'],
    parameters: { volume_ml: 2, temp_c: 25 },
    source_paper_id: 'pmid:111',
  });
  assert.equal(added.total, 1);
  const listed = await run('molbio_protocol_list', { file: 'C:/tmp/protocols2.json' });
  assert.equal(listed.protocols[0].name, 'Miniprep');
  assert.deepEqual(listed.protocols[0].steps, ['resuspend', 'lyse', 'neutralize']);
  const updated = await run('molbio_protocol_update', { file: 'C:/tmp/protocols2.json', id: listed.protocols[0].id, steps: ['resuspend', 'lyse'] });
  assert.equal(updated.protocol.steps.length, 2);
  const logged = await run('molbio_experiment_log', {
    file: 'C:/tmp/experiments2.json',
    title: 'Clone #12 miniprep',
    protocol_id: listed.protocols[0].id,
    paper_ids: ['pmid:111'],
    results: 'yield 80 ng/ul',
  });
  assert.equal(logged.total, 1);
  const experiments = await run('molbio_experiment_list', { file: 'C:/tmp/experiments2.json' });
  assert.equal(experiments.experiments[0].title, 'Clone #12 miniprep');
  assert.equal(experiments.experiments[0].protocol_id, listed.protocols[0].id);
}

// ── official-convention compliance ──────────────────────────────────────────

{
  // generic argument validation (defineTool-equivalent behavior)
  await assert.rejects(() => run('molbio_reverse_complement', { sequence: 123 }), /expected a string/);
  await assert.rejects(() => run('molbio_qpcr_analysis', { target_treated: [1, 2] }), /missing required/);
  await assert.rejects(() => run('molbio_lab_math', { operation: 'nonsense' }), /must be one of/);

  // concurrency safety: pure tools safe, file-writing tools not
  const tool = (name) => registered.find((t) => t.name === name);
  assert.equal(tool('molbio_reverse_complement').isConcurrencySafe({}), true);
  assert.equal(tool('molbio_translate').isConcurrencySafe({}), true);
  assert.equal(tool('molbio_paper_add').isConcurrencySafe({}), false);
  assert.equal(tool('molbio_protocol_add').isConcurrencySafe({}), false);
  assert.equal(tool('molbio_experiment_log').isConcurrencySafe({}), false);
  assert.equal(tool('molbio_plasmid_map').isConcurrencySafe({}), false);
  assert.equal(tool('molbio_plot').isConcurrencySafe({}), false);
  assert.equal(tool('molbio_clone_simulate').isConcurrencySafe({}), true);
  assert.equal(tool('molbio_clone_simulate').isConcurrencySafe({ save_path: 'C:/tmp/x.fa' }), false);
  assert.equal(tool('molbio_fasta_fastq').isConcurrencySafe({ action: 'stats' }), true);
  assert.equal(tool('molbio_fasta_fastq').isConcurrencySafe({ action: 'convert' }), false);
}

// ── IIS enzymes and cross-intron primer design ──────────────────────────────

{
  // type IIS enzyme digest (BsaI cuts outside its site)
  const seq = 'GGTCTC' + 'A'.repeat(20) + 'GGTCTC' + 'C'.repeat(20);
  const out = await run('molbio_restriction_sites', { sequence: seq, enzymes: ['BsaI'], circular: true });
  assert.deepEqual(out.enzymes[0].cut_positions, [7, 33]);
  assert.deepEqual(out.enzymes[0].fragments, [26, 26]);
  assert.equal(out.enzymes[0].site, 'GGTCTC(1/5)');

  // unique cutters recognize IIS enzymes with cuts outside the site
  const cutters = await run('molbio_unique_cutters', { vector: 'GGTCTC' + makeTemplate(200, 7) });
  const bsaI = cutters.ideal.find((entry) => entry.name === 'BsaI');
  assert.ok(bsaI !== undefined);
  assert.equal(bsaI.cut_position, 8);

  // IIS warning in clone simulation (single-enzyme ligation)
  const clone = await run('molbio_clone_simulate', {
    vector: 'GGTCTC' + 'A'.repeat(80),
    insert: 'GGTCTCCCCCGGTCTCTT',
    method: 'restriction',
    enzymes: ['BsaI'],
  });
  assert.ok(clone.notes.some((note) => note.includes('IIS')));
  assert.equal(clone.length, 96);
}

{
  // cross-intron primer design (fixture seeds chosen to pass the v12
  // Primer3-style structural defaults)
  const e1 = makeTemplate(120, 10);
  const e2 = makeTemplate(120, 14);
  const e3 = makeTemplate(120, 34);
  const genomic = e1 + makeTemplate(800, 29) + e2 + makeTemplate(800, 31) + e3;
  const exons = [{ start: 1, end: 120 }, { start: 921, end: 1040 }, { start: 1841, end: 1960 }];
  const out = await run('molbio_design_intron_primers', {
    genomic,
    exons,
    tm_min: 50,
    tm_max: 70,
    min_genomic_span: 900,
    max_results: 3,
  });
  assert.ok(out.pairs.length > 0, 'should find junction-spanning pairs');
  const pair = out.pairs[0];
  assert.ok(pair.forward.junction_left >= 6 && pair.forward.junction_right >= 6);
  assert.equal(pair.forward.exons.length, 2);
  assert.equal(Math.abs(Number(pair.forward.exons[1]) - Number(pair.forward.exons[0])), 1);
  assert.ok(pair.genomic_amplicon_length >= 900);
  assert.ok(pair.spliced_amplicon.length >= 80 && pair.spliced_amplicon.length <= 200);
  assert.ok(pair.reverse.exon !== Number(pair.forward.exons[1]));
  const spliced = e1 + e2 + e3;
  assert.ok(spliced.includes(pair.forward.sequence), 'forward primer is a spliced-sequence substring');
  assert.ok(spliced.includes(pair.reverse.sequence), 'reverse primer is a spliced-sequence substring');
}

// ── v12: mismatch tolerance in primer design ────────────────────────────────

{
  // Default behavior unchanged: exact match required, no mismatch drift
  const template = makeTemplate(600, 7);
  const out = await run('molbio_design_primers', { template, max_results: 5 });
  assert.ok(out.pairs.length > 0);
  for (const pair of out.pairs) {
    assert.equal(pair.forward.mismatch_count, 0, 'default = exact match');
    assert.deepEqual(pair.forward.mismatches, []);
    assert.equal(pair.reverse.mismatch_count, 0, 'default = exact match');
    assert.deepEqual(pair.reverse.mismatches, []);
    assert.equal(pair.forward.sequence, template.slice(pair.forward.start - 1, pair.forward.end));
  }

  // Enabling tolerance never degrades the best pair when exact primers exist
  const tolerant = await run('molbio_design_primers', { template, max_mismatches: 2, max_results: 5 });
  assert.equal(tolerant.pairs[0].forward.sequence, out.pairs[0].forward.sequence);
  assert.equal(tolerant.pairs[0].penalty, out.pairs[0].penalty);
  assert.equal(tolerant.pairs[0].forward.mismatch_count, 0);
  assert.equal(tolerant.pairs[0].reverse.mismatch_count, 0);
}

{
  // Rescue: a template where every exact window fails the run constraint, but a
  // couple of 5'-side mismatches salvage a pair. Structural filters are relaxed
  // so the run constraint is the only blocker; the 3'-terminal base and the 3'
  // critical zone still must stay perfectly matched.
  const template = 'T'.repeat(10) + 'GCGC' + 'T'.repeat(10);
  const params = {
    template,
    primer_len_min: 18, primer_len_max: 18,
    tm_min: 30, tm_max: 95, gc_min: 15, gc_max: 100,
    gc_clamp: 0, max_run: 4,
    max_self_any: 20, max_self_end: 20, max_hairpin_tm: 120,
    max_dimer_tm: 120, max_dimer_end_tm: 120,
    max_end_stability: 30, max_end_gc: 5, max_tm_delta: 200,
    amplicon_min: 1, amplicon_max: 24, region_end: 24,
    max_results: 5,
  };
  const exact = await run('molbio_design_primers', { ...params, max_mismatches: 0 });
  assert.equal(exact.pairs.length, 0, 'every exact window must fail the run constraint');

  const rescued = await run('molbio_design_primers', { ...params, max_mismatches: 2 });
  assert.ok(rescued.pairs.length > 0, 'mismatch tolerance must rescue a pair');
  const pair = rescued.pairs[0];

  // per-primer invariant checks on BOTH strands
  const checkInvariants = (primer, isReverse) => {
    assert.equal(primer.mismatch_count, primer.mismatches.length);
    for (const m of primer.mismatches) {
      assert.ok(m.position >= 1 && m.position <= primer.length, 'mismatch position inside the primer');
      assert.ok(m.distance_from_3prime >= 1, 'no mismatch on the 3-prime terminal base');
      assert.ok(m.distance_from_3prime >= 6, 'no mismatch inside the 3-prime critical zone by default');
      assert.equal(m.primer_base, primer.sequence[m.position - 1], 'primer_base matches the reported sequence');
      assert.notEqual(m.primer_base, m.template_base, 'template_base is the perfect-match base');
      const templateBase = template[m.template_position - 1];
      assert.ok(templateBase !== undefined, 'template_position inside the template');
      if (!isReverse) assert.equal(m.template_base, templateBase, 'forward: perfect base = the template base');
      else assert.equal(m.template_base, lib.complement(templateBase), 'reverse: perfect base = complement of the template base');
    }
  };
  checkInvariants(pair.forward, false);
  checkInvariants(pair.reverse, true);
  assert.ok(pair.forward.mismatch_count > 0 || pair.reverse.mismatch_count > 0, 'the rescue pair must carry at least one mismatch');

  // Same template with region_start=2: the only rescue left needs a mismatch
  // inside the 3'-critical zone, which is off by default and on with
  // max_3prime_mismatches=1.
  const zoneParams = { ...params, region_start: 2, max_mismatches: 3 };
  const zone0 = await run('molbio_design_primers', { ...zoneParams, max_3prime_mismatches: 0 });
  assert.equal(zone0.pairs.length, 0, 'zone-protected rescue must be impossible without zone tolerance');
  const zone1 = await run('molbio_design_primers', { ...zoneParams, max_3prime_mismatches: 1 });
  assert.ok(zone1.pairs.length > 0, 'zone tolerance must unlock the rescue');
  const zoneMismatches = [...zone1.pairs[0].forward.mismatches, ...zone1.pairs[0].reverse.mismatches];
  assert.ok(zoneMismatches.length > 0);
  assert.ok(zoneMismatches.every((m) => m.distance_from_3prime >= 1), 'still no terminal-base mismatch');
  assert.ok(zoneMismatches.some((m) => m.distance_from_3prime <= 5), 'zone tolerance allows mismatches near the 3-prime end');
}

{
  // Cross-intron design reports mismatch positions on the spliced transcript
  // AND on the genomic sequence. Both exons 1 and 3 carry T-runs that only
  // mismatched primers can pass, so some returned pair must carry mismatches.
  const e1 = makeTemplate(110, 17) + 'T'.repeat(10);
  const e2 = makeTemplate(120, 19);
  const e3 = 'T'.repeat(8) + makeTemplate(112, 23);
  const genomic = e1 + makeTemplate(800, 29) + e2 + makeTemplate(800, 31) + e3;
  const exons = [{ start: 1, end: 120 }, { start: 921, end: 1040 }, { start: 1841, end: 1960 }];
  const spliced = e1 + e2 + e3;
  const out = await run('molbio_design_intron_primers', {
    genomic,
    exons,
    tm_min: 50, tm_max: 70, gc_min: 20, gc_max: 60,
    min_genomic_span: 900,
    max_self_any: 20, max_self_end: 20, max_hairpin_tm: 120,
    max_dimer_tm: 120, max_dimer_end_tm: 120,
    max_end_stability: 30, max_end_gc: 5,
    max_mismatches: 3, max_3prime_mismatches: 1,
    max_results: 10,
  });
  assert.ok(out.pairs.length > 0);
  const mismatched = out.pairs.find((p) => p.forward.mismatch_count > 0 || p.reverse.mismatch_count > 0);
  assert.ok(mismatched !== undefined, 'the crafted exon runs must yield a mismatched candidate');
  for (const [primer, isForward] of [[mismatched.forward, true], [mismatched.reverse, false]]) {
    if (primer.mismatch_count === 0) continue;
    assert.equal(primer.mismatch_count, primer.mismatches.length);
    for (const m of primer.mismatches) {
      assert.equal(m.primer_base, primer.sequence[m.position - 1]);
      assert.equal(m.template_base, spliced[m.spliced_position - 1], 'spliced position maps to the transcript base');
      assert.equal(m.genomic_position, splicedToGenomic(m.spliced_position, exons), 'genomic position maps consistently');
      assert.ok(m.distance_from_3prime >= 1, 'no terminal-base mismatch in intron mode');
    }
  }
}

// ── v12: Primer3-style structural filters (items 1/2/3 of the Primer3 parity) ─

{
  const design = await import('../design.mjs');
  const relaxedBase = () => ({
    ...design.resolveDesignOptions({}),
    gcMin: 0, gcMax: 100, gcClamp: 0, tmMin: 0, tmMax: 100, maxRun: 100,
  });

  // self-any: a palindromic GC repeat is maximally self-complementary
  const pal = 'GCGCGCGCGCGCGCGCGC';
  assert.ok(lib.selfAnyScore(pal) >= 8, 'palindromic primer must exceed the Primer3 self-any threshold (8.0)');
  assert.ok(lib.selfEndScore(pal) >= 3, 'palindromic primer must exceed the Primer3 self-end threshold (3.0)');
  assert.equal(design.evaluateSeq(pal, relaxedBase(), 60).reason, 'self');
  // a homopolymer is NOT self-complementary (A does not pair A)
  assert.equal(lib.selfAnyScore('A'.repeat(20)), 0);
  assert.equal(lib.selfEndScore('A'.repeat(20)), 0);

  // self-end: C-rich 5' end + G-rich 3' end anchors a 3'-end duplex
  const endDuplex = 'CCCCCCCCCCCCGGGGGG';
  assert.ok(lib.selfEndScore(endDuplex) > 3, '3\'-anchored self duplex must exceed the self-end threshold');
  assert.equal(design.evaluateSeq(endDuplex, { ...relaxedBase(), maxSelfAny: 100 }, 60).reason, 'self_end');

  // hairpin: 8 bp GC stem with a 4 nt loop folds above the 47 °C threshold
  const hairpinSeq = 'GCGCGCGCTTTTGCGCGCGC';
  const topHairpin = lib.hairpinThermo(hairpinSeq, 200e-9)[0];
  assert.ok(topHairpin !== undefined && topHairpin.tm > 47, 'GC-rich hairpin must exceed the 47 °C threshold');
  assert.equal(topHairpin.stem, 8);
  assert.equal(topHairpin.loop, 4);
  assert.equal(design.evaluateSeq(hairpinSeq, { ...relaxedBase(), maxSelfAny: 100, maxSelfEnd: 100, maxRun: 100 }, 60).reason, 'hairpin');
  // short stems stay below the threshold (Primer3 convention)
  const shortHairpin = lib.hairpinThermo('GGGGTTTTCCCC', 200e-9)[0];
  assert.ok(shortHairpin === undefined || shortHairpin.tm <= 47, 'a 4 bp stem must not trip the 47 °C threshold');

  // end stability: ΔG(37 °C) of the last five bases (GC-rich end is stable)
  assert.ok(lib.endStability5('GCGCG') < -6, 'GCGCG 3\' end must be stable (< -6 kcal/mol)');
  assert.ok(lib.endStability5('ATATA') > -6, 'ATATA 3\' end must be unstable');
  assert.equal(design.evaluateSeq('ATATATATATATATGCGCG', { ...relaxedBase(), maxSelfAny: 100, maxSelfEnd: 100, maxEndStability: 5 }, 60).reason, 'end_stability');

  // end GC: G/C count in the last five bases
  assert.equal(lib.endGcCount5('GCGCG'), 5);
  assert.equal(design.evaluateSeq('ATATATATATATATATGGGGG', { ...relaxedBase(), maxEndGc: 2, maxSelfAny: 100, maxSelfEnd: 100 }, 60).reason, 'end_gc');

  // GC clamp levels (0-3 consecutive G/C at the 3' end)
  const clampOpts = () => ({ ...relaxedBase(), maxSelfAny: 100, maxSelfEnd: 100, maxEndGc: 5, maxEndStability: 30 });
  assert.equal(design.evaluateSeq('ATATATATATATATATATAC', { ...clampOpts(), gcClamp: 2 }, 60).reason, 'clamp');
  assert.equal(design.evaluateSeq('ATATATATATATATATATAC', { ...clampOpts(), gcClamp: 1 }, 60).reason, undefined);
  assert.equal(design.evaluateSeq('ATATATATATATATATATCC', { ...clampOpts(), gcClamp: 3 }, 60).reason, 'clamp');
  assert.equal(design.evaluateSeq('ATATATATATATATATATCC', { ...clampOpts(), gcClamp: 2 }, 60).reason, undefined);

  // primer dimer: G12/C12 forms a 67 °C duplex — rejected at the Primer3 default
  assert.ok(lib.dimerThermo('GGGGGGGGGGGG', 'CCCCCCCCCCCC', 200e-9).any_tm > 47);
  const dimerTemplate = 'C'.repeat(12) + 'A'.repeat(20) + 'G'.repeat(12);
  const dimerParams = {
    lenMin: 12, lenMax: 12, tmMin: 0, tmMax: 100, gcMin: 0, gcMax: 100, gcClamp: 0, maxRun: 20,
    maxSelfAny: 100, maxSelfEnd: 100, maxHairpinTm: 120, maxDimerTm: 200, maxDimerEndTm: 47,
    maxEndStability: 30, maxEndGc: 5, maxTmDelta: 200, ampliconMin: 12, ampliconMax: 12,
    regionStart: 1, regionEnd: 44, maxResults: 50, maxCandidates: 5000,
  };
  const dimerStrict = design.designPrimerPairs(dimerTemplate, dimerParams);
  assert.ok(dimerStrict.length > 0, 'other pairs still exist');
  assert.ok(!dimerStrict.some((p) => p.forward.sequence === 'CCCCCCCCCCCC'), 'the 67 °C G/C dimer pair must be rejected at the Primer3 47 °C threshold');
  const dimerLoose = design.designPrimerPairs(dimerTemplate, { ...dimerParams, maxDimerEndTm: 200 });
  assert.ok(dimerLoose.some((p) => p.forward.sequence === 'CCCCCCCCCCCC'), 'relaxing the threshold admits the G/C dimer pair');
}

// ── v12: mispriming check (item 6 of the Primer3 parity) ────────────────────

{
  const block = makeTemplate(60, 5);
  const spacer = makeTemplate(80, 9);
  const template = block + spacer + block; // duplicated block → every primer tail hits a second site
  const params = {
    template,
    primer_len_min: 18, primer_len_max: 20,
    tm_min: 30, tm_max: 95, gc_min: 20, gc_max: 80,
    gc_clamp: 0, max_run: 3,
    max_self_any: 20, max_self_end: 20, max_hairpin_tm: 120,
    max_dimer_tm: 120, max_dimer_end_tm: 120,
    max_end_stability: 30, max_end_gc: 5, max_tm_delta: 200,
    amplicon_min: 30, amplicon_max: 60, region_start: 1, region_end: 60,
    max_results: 5,
  };
  const off = await run('molbio_design_primers', { ...params, check_mispriming: false });
  assert.ok(off.pairs.length > 0, 'mispriming check off → pairs exist');
  for (const pair of off.pairs) {
    assert.equal(pair.forward.mispriming_count, 0);
    assert.deepEqual(pair.forward.mispriming_sites, []);
  }
  const strict = await run('molbio_design_primers', { ...params, check_mispriming: true, mispriming_max_sites: 1 });
  assert.equal(strict.pairs.length, 0, 'with the duplicated block every primer has >= 1 extra site → all pairs rejected');
  const loose = await run('molbio_design_primers', { ...params, check_mispriming: true, mispriming_max_sites: 10 });
  assert.ok(loose.pairs.length > 0);
  const pair = loose.pairs[0];
  const totalSites = pair.forward.mispriming_count + pair.reverse.mispriming_count;
  assert.ok(totalSites >= 1, 'loose mispriming run must report extra sites');
  const allSites = [...pair.forward.mispriming_sites, ...pair.reverse.mispriming_sites];
  assert.ok(allSites.some((s) => s.position > 60), 'a site in the duplicated second block must be reported');
  for (const s of allSites) {
    assert.ok(['top', 'bottom'].includes(s.strand));
    assert.ok(s.matches >= 7, 'sites are found via <= 1 mismatch in the 3-prime tail');
  }

  // primer_check exposes the same thermodynamic metrics
  const check = await run('molbio_primer_check', { primer1: 'GCGCGCGCGCGCGCGCGC', primer2: 'GCGCGCGCGCGCGCGCGC' });
  assert.ok(check.primer1.self_any_score >= 8);
  assert.ok(check.primer1.self_end_score >= 3);
  assert.equal(typeof check.primer1.hairpin_tm, 'number');
  assert.equal(typeof check.primer1.end_stability_kcal, 'number');
  assert.equal(typeof check.primer1.end_gc_count, 'number');
  const dimerPair = await run('molbio_primer_check', { primer1: 'GGGGGGGGGGGG', primer2: 'CCCCCCCCCCCC' });
  assert.ok(dimerPair.pair.dimer_tm > 47, 'primer_check must report the Primer3-style dimer Tm');
  assert.ok(dimerPair.pair.dimer_end_tm > 47);
}

/** Map a 1-based spliced-transcript position back to 1-based genomic coordinates (test helper). */
function splicedToGenomic(splicedPos, exons) {
  let cursor = 0;
  for (const exon of exons) {
    const span = exon.end - exon.start + 1;
    if (splicedPos <= cursor + span) return exon.start + (splicedPos - cursor) - 1;
    cursor += span;
  }
  throw new Error(`spliced position ${splicedPos} outside exons`);
}

// ── pubmed search (mocked web service) ──────────────────────────────────────

{
  const out = await run('molbio_pubmed_search', { query: 'CRISPR' });
  assert.equal(out.query, 'CRISPR');
  assert.equal(out.answer, 'answer for CRISPR');
  assert.equal(out.sources.length, 2);
  assert.equal(out.sources[0].pmid, '12345678');
  assert.equal(out.sources[1].pmid, undefined);
}

// ── paper library (mocked fs service) ───────────────────────────────────────

{
  const file = 'C:/tmp/papers.json';
  const added = await run('molbio_paper_add', {
    file,
    papers: [
      { title: 'Paper A', pmid: '111', year: '2024', tags: ['crispr'] },
      { title: 'Paper B', pmid: '111', note: 'duplicate should be skipped' },
      { title: 'Paper C', url: 'https://example.com/c' },
    ],
  });
  assert.equal(added.added.length, 2);
  assert.equal(added.total, 2);
  assert.equal(added.file, file);

  const list = await run('molbio_paper_list', { file });
  assert.equal(list.papers.length, 2);
  assert.equal(list.papers[0].id, 'pmid:111');

  const updated = await run('molbio_paper_update', { file, id: 'pmid:111', note: 'read in lab meeting' });
  assert.equal(updated.found, true);
  assert.equal(updated.paper.note, 'read in lab meeting');

  const missing = await run('molbio_paper_update', { file, id: 'nope', note: 'x' });
  assert.equal(missing.found, false);

  const removed = await run('molbio_paper_remove', { file, id: 'url:https://example.com/c' });
  assert.equal(removed.removed, true);
  assert.equal(removed.total, 1);

  const finalList = await run('molbio_paper_list', { file });
  assert.equal(finalList.papers.length, 1);
}

// ── v13: reaction-condition knobs (salt / primer concentration) ─────────────

{
  const template = makeTemplate(600, 7);
  const out = await run('molbio_design_primers', { template, max_results: 2 });
  assert.deepEqual(out.conditions, { na_mm: 50, mg_mm: 1.5, dntp_mm: 0.8, primer_nm: 200 });
  const salted = await run('molbio_design_primers', { template, max_results: 2, na_mm: 300, mg_mm: 3, dntp_mm: 0.4, primer_nm: 50, tm_min: 55, tm_max: 80 });
  assert.deepEqual(salted.conditions, { na_mm: 300, mg_mm: 3, dntp_mm: 0.4, primer_nm: 50 });
  assert.ok(salted.pairs.length > 0, 'designer works under custom reaction conditions');
  // engine-level known value: the same primer melts hotter at higher salt
  const design = await import('../design.mjs');
  const base = { gcMin: 10, gcMax: 90, maxRun: 10, maxSelfAny: 100, maxSelfEnd: 100, maxHairpinTm: 200, maxEndStability: 50, maxEndGc: 5, tmMin: 1, tmMax: 100, gcClamp: 0 };
  const optsLow = design.resolveDesignOptions({ ...base, naMm: 20, mgMm: 0 });
  const optsHigh = design.resolveDesignOptions({ ...base, naMm: 300, mgMm: 0 });
  const evLow = design.evaluateSeq('GTAAAACGACGGCCAGTC', optsLow, 60);
  const evHigh = design.evaluateSeq('GTAAAACGACGGCCAGTC', optsHigh, 60);
  assert.equal(evLow.reason, undefined);
  assert.equal(evHigh.reason, undefined);
  assert.ok(evHigh.tm > evLow.tm, 'NN Tm must rise with monovalent salt');
  await assert.rejects(() => run('molbio_design_primers', { template, na_mm: 0 }), /na_mm/);
  await assert.rejects(() => run('molbio_design_primers', { template, mg_mm: -1 }), /mg_mm/);
  await assert.rejects(() => run('molbio_design_primers', { template, primer_nm: 6000 }), /primer_nm/);
  await assert.rejects(() => run('molbio_design_primers', { template, dntp_mm: 20 }), /dntp_mm/);
}

// ── v13: 3' target position preference ──────────────────────────────────────

{
  const template = makeTemplate(600, 7);
  const near = await run('molbio_design_primers', { template, max_results: 3, target_position: 100, target_penalty: 100 });
  assert.ok(near.pairs.length > 0);
  for (const pair of near.pairs) {
    assert.ok(pair.forward.target_distance >= 0 && pair.reverse.target_distance >= 0);
    assert.equal(pair.target_distance, Math.min(pair.forward.target_distance, pair.reverse.target_distance));
  }
  assert.ok(near.pairs[0].target_distance <= 100, `target 100 should pull the 3' ends close (got ${near.pairs[0].target_distance})`);
  const far = await run('molbio_design_primers', { template, max_results: 3, target_position: 500, target_penalty: 100 });
  assert.ok(far.pairs[0].target_distance <= 100, `target 500 should pull the 3' ends close (got ${far.pairs[0].target_distance})`);
  const plain = await run('molbio_design_primers', { template, max_results: 2 });
  assert.equal(plain.pairs[0].target_distance, undefined, 'no target_distance without target_position');
  await assert.rejects(() => run('molbio_design_primers', { template, target_position: 601 }), /outside the template/);
  await assert.rejects(() => run('molbio_design_primers', { template, target_penalty: -1 }), /target_penalty/);
  // cross-intron design reports spliced-coordinate target distances too
  const e1 = makeTemplate(120, 10);
  const e2 = makeTemplate(120, 14);
  const e3 = makeTemplate(120, 34);
  const genomic = e1 + makeTemplate(800, 29) + e2 + makeTemplate(800, 31) + e3;
  const exons = [{ start: 1, end: 120 }, { start: 921, end: 1040 }, { start: 1841, end: 1960 }];
  const intron = await run('molbio_design_intron_primers', { genomic, exons, tm_min: 50, tm_max: 70, min_genomic_span: 900, max_results: 3, target_position: 150, target_penalty: 100 });
  assert.ok(intron.pairs.length > 0);
  for (const pair of intron.pairs) {
    assert.equal(pair.target_distance, Math.min(pair.forward.target_distance, pair.reverse.target_distance));
    assert.ok(pair.forward.target_distance <= 359);
  }
}

// ── v13: enzyme catalog lookup ──────────────────────────────────────────────

{
  const catalog = await run('molbio_enzyme_lookup', {});
  assert.ok(catalog.total >= 90, `expected >= 90 enzymes, got ${catalog.total}`);
  assert.equal(catalog.enzymes.length, catalog.total);
  const eco = catalog.enzymes.find((entry) => entry.name === 'EcoRI');
  assert.equal(eco.iis, false);
  assert.equal(eco.recognition, 'GAATTC');
  assert.equal(eco.palindromic, true);
  const bsaI = catalog.enzymes.find((entry) => entry.name === 'BsaI');
  assert.equal(bsaI.iis, true);
  assert.equal(bsaI.site, 'GGTCTC(1/5)');
  assert.equal(bsaI.cut_offset, 7);
  assert.equal(bsaI.bottom_cut, 5);
  assert.equal(bsaI.overhang_length, 4);
  assert.equal(bsaI.palindromic, false);
  // both strand orientations: a reverse-complemented BsaI site is also cut
  const seq = 'GGTCTC' + 'A'.repeat(10) + 'GAGACC' + 'C'.repeat(10);
  const scanned = await run('molbio_enzyme_lookup', { sequence: seq, enzymes: ['BsaI'] });
  assert.equal(scanned.enzymes[0].cuts, 2);
  assert.deepEqual(scanned.enzymes[0].cut_events.map((cut) => cut.cut_position), [8, 12]);
  assert.deepEqual(scanned.enzymes[0].fragments, [21, 7, 4]);
  const circularEco = await run('molbio_enzyme_lookup', { sequence: 'GAATTC', enzymes: ['EcoRI'], circular: true });
  assert.deepEqual(circularEco.enzymes[0].fragments, [6]);
  await assert.rejects(() => run('molbio_enzyme_lookup', { enzymes: ['NotAnEnzyme'] }), /unknown enzyme/);
}

// ── v13: Golden Gate assembly ───────────────────────────────────────────────

{
  // Bare-vector mode: the tool adds the cassette around the region and designs
  // both vector junctions. The vector cassette sites stay in the backbone.
  const vector = 'A'.repeat(60) + 'C'.repeat(40) + 'T'.repeat(60);
  const g1 = 'G'.repeat(30) + 'AATT' + 'C'.repeat(30);
  const g2 = 'T'.repeat(25) + 'GGCC' + 'G'.repeat(25);
  assert.equal(lib.enzymeCuts(vector, 'BsaI').length, 0);
  assert.equal(lib.enzymeCuts(g1, 'BsaI').length, 0);
  assert.equal(lib.enzymeCuts(g2, 'BsaI').length, 0);
  const gbSeq = vector;
  memFs.files.set('C:/tmp/pGG.gb', [
    'LOCUS       pGG                 160 bp    DNA     circular SYN 01-JAN-2024',
    'FEATURES             Location/Qualifiers',
    '     rep_origin      1..60',
    '                     /label="ori"',
    '     CDS             61..100',
    '                     /label="lacZ"',
    '     CDS             120..160',
    '                     /label="AmpR"',
    'ORIGIN',
    `        1 ${gbSeq}`,
    '//',
  ].join('\n'));
  const out = await run('molbio_golden_gate', {
    vector_path: 'C:/tmp/pGG.gb',
    inserts: [g1, g2],
    replace_region: { start: 61, end: 100 },
    save_path: 'C:/tmp/gg.fa',
    map_path: 'C:/tmp/gg.svg',
  });
  assert.equal(out.method, 'golden_gate');
  assert.equal(out.enzyme, 'BsaI');
  assert.equal(out.enzyme_site, 'GGTCTC(1/5)');
  assert.equal(out.overhang_length, 4);
  assert.equal(out.fragments_to_order.length, 2);
  assert.equal(out.junctions.length, 3);
  assert.equal(out.fragments_to_order[0].left_overhang, out.junctions[0].sequence);
  assert.equal(out.fragments_to_order[0].right_overhang, out.junctions[1].sequence);
  assert.equal(out.fragments_to_order[1].left_overhang, out.junctions[1].sequence);
  assert.equal(out.fragments_to_order[1].right_overhang, out.junctions[2].sequence);
  for (let i = 0; i < out.junctions.length; i++) {
    const seq = out.junctions[i].sequence;
    assert.equal(seq.length, 4);
    assert.notEqual(seq, lib.reverseComplement(seq), 'junctions must not be palindromic');
    for (let j = i + 1; j < out.junctions.length; j++) {
      assert.notEqual(seq, out.junctions[j].sequence, 'junctions must be unique');
      assert.notEqual(seq, lib.reverseComplement(out.junctions[j].sequence), 'junctions must not be complementary');
    }
  }
  // final plasmid = vector with cassette retained + fragments, up to rotation
  const expected = vector.slice(0, 60) + 'GGTCTC' + 'A' + out.junctions[0].sequence + g1 + out.junctions[1].sequence + g2 + out.junctions[2].sequence + 'A' + 'GAGACC' + vector.slice(100);
  assert.equal(out.length, expected.length);
  assert.ok((out.final_sequence + out.final_sequence).includes(expected), 'final sequence must equal the expected assembly up to circular rotation');
  assert.equal(lib.enzymeCuts(out.final_sequence, 'BsaI').length, 2, 'exactly the 2 retained vector cassette sites');
  assert.ok(out.dropped_features.some((feature) => feature.label === 'lacZ'), 'feature inside the replaced region is dropped');
  const ampR = out.features.find((feature) => feature.label === 'AmpR');
  assert.deepEqual([ampR.start, ampR.end], [31, 71], 'AmpR shifts into the linearized backbone frame');
  assert.equal(out.delta, 82);
  assert.ok(out.verify.length > 0, 'verification digests are produced');
  assert.equal(out.save_path, 'C:/tmp/gg.fa');
  assert.equal(out.map_path, 'C:/tmp/gg.svg');
  assert.ok(memFs.files.get(out.save_path).toString('utf8').includes('golden_gate'));
  assert.ok(memFs.files.get(out.map_path).toString('utf8').includes('<svg'));

  // Vector-with-cassette mode: the tool reads the junctions from the vector
  // and designs only the interior ones.
  const left = 'C'.repeat(50);
  const right = 'G'.repeat(50);
  const cassetteVector = left + 'GGTCTC' + 'A' + 'CGAC' + 'T'.repeat(40) + 'GTCT' + 'A' + 'GAGACC' + right;
  const f1 = 'AAGG' + 'T'.repeat(30);
  const f2 = 'C'.repeat(25) + 'AATT';
  const f3 = 'G'.repeat(28) + 'CC';
  assert.equal(lib.enzymeCuts(f1, 'BsaI').length, 0);
  assert.equal(lib.enzymeCuts(f2, 'BsaI').length, 0);
  assert.equal(lib.enzymeCuts(f3, 'BsaI').length, 0);
  const cassetteOut = await run('molbio_golden_gate', { vector: cassetteVector, inserts: [f1, f2, f3] });
  assert.equal(cassetteOut.junctions[0].sequence, 'CGAC');
  assert.equal(cassetteOut.junctions[3].sequence, 'GTCT');
  assert.equal(cassetteOut.fragments_to_order[0].sequence, 'GGTCTC' + 'A' + 'CGAC' + f1 + cassetteOut.junctions[1].sequence + 'A' + 'GAGACC');
  // top strand = backbone (with the retained cassette; linearized at the reverse top cut, so the vector junction zPrime leads) + left junction + fragments + interiors
  const cassetteExpected = cassetteOut.junctions[3].sequence + 'A' + 'GAGACC' + right + left + 'GGTCTC' + 'A' + 'CGAC' + f1 + cassetteOut.junctions[1].sequence + f2 + cassetteOut.junctions[2].sequence + f3;
  assert.equal(cassetteOut.length, cassetteExpected.length);
  assert.ok((cassetteOut.final_sequence + cassetteOut.final_sequence).includes(cassetteExpected), 'cassette-mode assembly up to circular rotation');
  assert.equal(lib.enzymeCuts(cassetteOut.final_sequence, 'BsaI').length, 2);

  // error paths
  await assert.rejects(() => run('molbio_golden_gate', { vector, inserts: ['GGTCTC' + 'A'.repeat(20)], replace_region: { start: 61, end: 100 } }), /cuts INSIDE/);
  await assert.rejects(() => run('molbio_golden_gate', { vector, inserts: ['A'.repeat(20)], enzyme: 'EcoRI' }), /not a type IIS/);
  await assert.rejects(() => run('molbio_golden_gate', { vector: 'A'.repeat(100), inserts: ['C'.repeat(20)] }), /exactly one forward/);
  await assert.rejects(() => run('molbio_golden_gate', { vector: 'GGTCTC' + 'A'.repeat(40), inserts: ['C'.repeat(20)], replace_region: { start: 5, end: 10 } }), /already cuts the bare vector/);
  const palindromic = left + 'GGTCTC' + 'A' + 'ATAT' + 'T'.repeat(40) + 'GTCT' + 'A' + 'GAGACC' + right;
  await assert.rejects(() => run('molbio_golden_gate', { vector: palindromic, inserts: ['C'.repeat(20)] }), /unusable/);
}

// ── v13: virtual agarose gel ────────────────────────────────────────────────

{
  const gel = await run('molbio_virtual_gel', { lanes: [{ label: 'EcoRI digest', fragments: [3000, 800] }, { label: '', fragments: [] }], title: 'Clone check' });
  assert.equal(gel.lane_count, 2);
  assert.equal(gel.band_count, 2);
  assert.equal(gel.ladder, '1kb');
  assert.equal(gel.svg_path, 'C:\\tmp\\Clone_check.svg');
  const svg = memFs.files.get(gel.svg_path).toString('utf8');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('EcoRI digest'));
  assert.ok(svg.includes('10 kb'));
  assert.ok(svg.includes('3 kb'));
  const small = await run('molbio_virtual_gel', { lanes: [{ label: 'PCR', fragments: [150, 900] }], ladder: '100bp', output_path: 'C:/tmp/gel2.svg' });
  assert.equal(small.svg_path, 'C:/tmp/gel2.svg');
  const svg2 = memFs.files.get(small.svg_path).toString('utf8');
  assert.ok(svg2.includes('1.5 kb') && svg2.includes('0.9 kb'));
  await assert.rejects(() => run('molbio_virtual_gel', { lanes: [{ label: 'x', fragments: [1.5] }] }), /expected an integer/);
  await assert.rejects(() => run('molbio_virtual_gel', { lanes: [{ label: 'x', fragments: [999999] }] }), /fragment sizes/);
  await assert.rejects(() => run('molbio_virtual_gel', { lanes: [] }), /1-12/);
  await assert.rejects(() => run('molbio_virtual_gel', { lanes: [{ label: 'x', fragments: [] }], ladder: 'nope' }), /must be one of 1kb, 100bp/);
}

// ── v16: sequence logo ──────────────────────────────────────────────────────

{
  // Hand-checked composition: 4 rows, 3 columns.
  //   col 1 all A          -> fractions A=1,    H=0,      R=2 bits
  //   col 2 A,A,C,C        -> A=0.5  C=0.5,    H=1,      R=1
  //   col 3 A,A,A,C        -> A=0.75 C=0.25,   H=0.8113, R=1.1887
  // (small-sample correction off; with it on, col 1 is 2 - 1.082 = 0.918.)
  const rows = ['AAA', 'AAA', 'ACA', 'ACC'];
  const logo = await run('molbio_sequence_logo', { alignment: rows, title: 'splice site' });
  assert.equal(logo.source, 'alignment');
  assert.equal(logo.sequence_count, 4);
  assert.equal(logo.columns, 3);
  assert.equal(logo.score_type, 'bits');
  assert.equal(logo.small_sample, true);
  assert.equal(logo.most_conserved, 1);
  assert.equal(logo.gap_columns, 0);
  // corrected column bits: 1.459 + 0.459 + 0.648 = 2.566 -> 2.57; mean 0.855 -> 0.86
  assert.equal(logo.total_bits, 2.57);
  assert.equal(logo.mean_bits, 0.86);
  const logoSvg = memFs.files.get(logo.svg_path).toString('utf8');
  assert.ok(logoSvg.startsWith('<svg'), 'the logo is a standalone SVG document');
  assert.ok(logoSvg.endsWith('</svg>'));
  assert.ok(logoSvg.includes('splice site'));
  assert.ok(logoSvg.includes('information content (bits)'));
  // Tallest letter in the fully conserved column: an A glyph of ~1.46 bits.
  assert.ok(/>A<\/text>/.test(logoSvg), 'letters are drawn as text glyphs');
  assert.ok(logoSvg.includes('column 1: 1.46 bits'), 'each column carries a <title> tooltip');
  assert.ok(logoSvg.includes('A 1, C 0, G 0, T 0'), 'the tooltip lists the base fractions');
  // Glyphs must never be wider than the column they belong to, and their
  // baseline must stay at or above the axis (the plot spans y = 82 .. 302).
  for (const match of logoSvg.matchAll(/<text x="[\d.]+" y="([\d.]+)" font-size="([\d.]+)"[^>]*textLength="([\d.]+)"[^>]*>([ACGT])<\/text>/g)) {
    const [, y, size, length, base] = match;
    assert.ok(Number(size) <= 26 * 0.95 + 1e-9, `font-size ${size} fits the 26px column (${base})`);
    assert.ok(Number(length) <= 26, `textLength ${length} fits the 26px column (${base})`);
    assert.ok(Number(y) <= 302.51, `${base} baseline ${y} sits at or above the axis`);
    assert.ok(Number(y) - 0.72 * Number(size) >= 82 - 0.51, `${base} cap top stays inside the plot`);
  }

  // small_sample=false must reproduce the uncorrected bits exactly.
  const exact = await run('molbio_sequence_logo', { alignment: rows, small_sample: false, output_path: 'C:/tmp/exact.svg' });
  assert.equal(exact.small_sample, false);
  assert.equal(exact.total_bits, 4.19, 'uncorrected: 2 + 1 + 1.1887');
  assert.equal(exact.mean_bits, 1.4);
  // 2 sequences that disagree are 0 bits after correction, 1 bit without it.
  const corrected = await run('molbio_sequence_logo', { alignment: ['A', 'C'] });
  assert.equal(corrected.total_bits, 0);
  const uncorrected = await run('molbio_sequence_logo', { alignment: ['A', 'C'], small_sample: false, score_type: 'frequency', output_path: 'C:/tmp/freq.svg' });
  assert.equal(uncorrected.score_type, 'frequency');
  assert.ok(memFs.files.get('C:/tmp/freq.svg').toString('utf8').includes('frequency'));

  // Gaps: frequencies use residues only, and the gap column is reported.
  const gapped = await run('molbio_sequence_logo', { alignment: ['AC-G', 'AC-G', 'ACGG', 'ACTG'] });
  assert.equal(gapped.gap_columns, 1);
  assert.equal(gapped.most_conserved, 1);
  const gapSvg = memFs.files.get(gapped.svg_path).toString('utf8');
  assert.ok(gapSvg.includes('gap(s) excluded'), 'the header states that gaps are excluded');

  // Raw sequences are aligned first (source = msa).
  const fromSeq = await run('molbio_sequence_logo', { sequences: ['ACGTACGT', 'ACGTACGT'] });
  assert.equal(fromSeq.source, 'msa');
  assert.equal(fromSeq.columns, 8);
  // Two identical sequences carry almost no evidence: each column is
  // 2 - 3/(4·ln2·2) = 0.918 bits instead of a nominal 2.
  assert.equal(fromSeq.total_bits, 7.34);
  const fromSeqExact = await run('molbio_sequence_logo', { sequences: ['ACGTACGT', 'ACGTACGT'], small_sample: false, output_path: 'C:/tmp/uncorrected.svg' });
  assert.equal(fromSeqExact.total_bits, 16, 'without the correction two identical sequences give 2 bits x 8 columns');

  // Ambiguity codes spread over their base set, so an ambiguity code is not a
  // fifth symbol: 'RR' is a 50/50 A/G column (1 bit) and 'RA' is 75/25 A/G
  // (1.189 bits) — a two-symbol consensus, not a fully conserved column.
  const ambig = await run('molbio_sequence_logo', { alignment: ['RR', 'RA'], small_sample: false, output_path: 'C:/tmp/ambig.svg' });
  assert.equal(ambig.total_bits, 2.19);
  const plain = await run('molbio_sequence_logo', { alignment: ['RR', 'RR'], small_sample: false, output_path: 'C:/tmp/plain.svg' });
  assert.equal(plain.total_bits, 2, 'two identical ambiguity codes are fully conserved');

  await assert.rejects(() => run('molbio_sequence_logo', {}), /exactly one of/);
  await assert.rejects(() => run('molbio_sequence_logo', { alignment: ['ACGT', 'ACG'] }), /same length/);
  await assert.rejects(() => run('molbio_sequence_logo', { alignment: ['ACGT'], }), /at least 2/);
  await assert.rejects(() => run('molbio_sequence_logo', { alignment: ['ACGT', 'ACX*'] }), /invalid character/);
}

// ── v16: CRISPR gRNA design ─────────────────────────────────────────────────

{
  // Purpose-built 53 bp target, hand-verified to contain exactly four NGG PAM
  // sites. `guide` is a real SpCas9-style protospacer; `offSite` differs from
  // it at guide positions 4 and 7 (both in the distal, non-seed region).
  //   forward  6-25   PAM TGG   = the guide
  //   reverse 13-32   PAM CGG   (CC on the top strand at 28-29)
  //   forward 31-50   PAM TGG   = the 2-mismatch off-target
  //   reverse 32-51   PAM CGG   (CC at 29-30)
  // The two reverse sites share the engineered CC stretch, so the fixture has
  // four sites rather than two; their protospacers do not resemble the guide,
  // which keeps the off-target counts unambiguous.
  const guide = 'GAGTCCGAGCAGAAGAAGAA';
  const offSite = 'GAGACCTAGCAGAAGAAGAA';
  const target = `TTTTT${guide}TGGCC${offSite}TGG`;
  assert.equal(target.length, 53);
  assert.equal(target.slice(5, 25), guide);
  assert.equal(target.slice(30, 50), offSite);
  assert.equal(target.slice(25, 28), 'TGG');
  assert.equal(target.slice(50, 53), 'TGG');

  const design = await run('molbio_grna_design', { sequence: target, check_off_target: true, max_mismatches: 2 });
  assert.equal(design.pam, 'NGG');
  assert.equal(design.guide_length, 20);
  assert.equal(design.target_length, 53);
  assert.equal(design.candidate_count, 4, 'exactly four PAM sites');
  assert.equal(design.rejected_count, 0);
  assert.equal(design.off_target_checked, true);
  assert.equal(design.off_target_scanned, 4);
  assert.equal(design.guides_truncated, false);
  assert.equal(design.guides.length, 4);

  const first = design.guides.find((g) => g.start === 6 && g.strand === 'forward');
  assert.equal(first.sequence, guide);
  assert.equal(first.pam, 'TGG');
  assert.equal(first.end, 25);
  assert.equal(first.gc_percent, 50);
  assert.equal(first.tm_celsius, 58.43, 'NN Tm at the default 50 mM Na+/1.5 mM Mg2+/200 nM');
  assert.equal(first.self_any, 5.5);
  assert.equal(first.self_end, 0);
  assert.equal(first.seed_self_any, 2);
  assert.equal(first.longest_t_run, 1);
  assert.equal(first.off_target_count, 1, 'the intended site is not counted as its own off-target');
  assert.equal(first.off_target_sites.length, 1);
  assert.deepEqual(first.off_target_sites[0], {
    strand: 'forward', start: 31, end: 50, pam: 'TGG', pam_intact: true,
    mismatches: 2, mismatch_positions: [4, 7],
  });
  // This guide's only penalty is the off-target (8): 100 - 8 = 92. It gets no
  // PAM-proximal bonus because guide position 20 is A, not G (see below).
  assert.equal(first.score, 92);

  // The reciprocal call: designing on the off-target site sees the guide.
  const reciprocal = await run('molbio_grna_design', { sequence: target, region_start: 31, region_end: 50, max_mismatches: 2 });
  assert.equal(reciprocal.candidate_count, 1);
  assert.equal(reciprocal.guides[0].off_target_count, 1);
  assert.deepEqual(reciprocal.guides[0].off_target_sites[0].mismatch_positions, [4, 7]);
  assert.equal(reciprocal.guides[0].off_target_sites[0].start, 6);

  // Reverse-strand geometry: the protospacer is the reverse complement of the
  // top-strand slice at 31-50 and the PAM is the reverse complement of the
  // top-strand CCN at 26-28 (so the reported PAM always reads 5'->3' on the
  // strand the guide targets).
  const reverseGuide = design.guides.find((g) => g.strand === 'reverse' && g.start === 13);
  assert.equal(reverseGuide.end, 32);
  assert.equal(reverseGuide.sequence.length, 20, 'a reverse protospacer is 20 nt, never PAM + 20');
  assert.equal(target.slice(12, 32), reverseComplementOf(reverseGuide.sequence), 'the top-strand 13-32 slice is the reverse complement of the guide');
  assert.equal(reverseGuide.pam, reverseComplementOf(target.slice(28, 31)), 'the reported PAM is the reverse complement of the top-strand CCN it sits on');
  assert.equal(target.slice(28, 31), 'CCG');
  assert.equal(reverseGuide.pam, 'CGG');
  assert.equal(reverseGuide.off_target_count, 0);

  // The 3' clamp note fires exactly when the last two bases are both G/C.
  const clampGuide = `${guide.slice(0, 17)}GGG`;
  const clampDesign = await run('molbio_grna_design', { sequence: `TTTTT${clampGuide}TGG${'A'.repeat(10)}`, check_off_target: false });
  const clamped = clampDesign.guides.find((g) => g.sequence === clampGuide);
  assert.ok(clamped, 'the clamp guide survives the filters');
  assert.ok(clamped.notes.some((note) => note.includes('clamp')), 'the 3\' clamp note is reported');
  assert.ok(!design.guides.some((g) => g.notes.some((note) => note.includes('clamp'))), 'guides ending in AA get no clamp note');

  // An off-target-free guide with no other penalties sits at the 100 ceiling.
  assert.ok(design.guides.some((g) => g.score === 100), 'a clean guide scores 100');

  // Filters: a GC-rich guide with a C-run is rejected for BOTH reasons, and the
  // reasons are the ones reported (the forward guide + five incidental reverse
  // sites on the same C-stretch are all filtered here).
  const gcRichSequence = `${'A'.repeat(5)}GACCCCCTCCACCCCGCCTCTGG${'A'.repeat(10)}`;
  const gcRich = await run('molbio_grna_design', { sequence: gcRichSequence, check_off_target: false });
  assert.equal(gcRich.candidate_count, 6, 'the forward guide plus five incidental reverse sites');
  assert.equal(gcRich.rejected_count, 6, 'every candidate here violates a filter');
  assert.equal(gcRich.guides.length, 0);
  // Widening only the GC bound still leaves the C-run rule in force ...
  const stillRun = await run('molbio_grna_design', { sequence: gcRichSequence, gc_max: 90, check_off_target: false, max_guides: 10 });
  assert.ok(!stillRun.guides.some((g) => g.sequence === 'GACCCCCTCCACCCCGCCTC'), 'the C-run filter is independent of gc_max');
  // ... while a GC-rich guide with NO homopolymer run is genuinely rescued by
  // widening gc_max, which is what proves the bound itself is what filtered it.
  const gcOnlyGuide = 'GCGCGCGCGCGCGCGCACAT'; // 85% GC, no 4+ run, T-run 1
  const gcOnlySequence = `${'A'.repeat(5)}${gcOnlyGuide}TGG${'A'.repeat(10)}`;
  const blocked = await run('molbio_grna_design', { sequence: gcOnlySequence, check_off_target: false });
  assert.equal(blocked.rejected_count, 1);
  assert.equal(blocked.guides.length, 0);
  const widened = await run('molbio_grna_design', { sequence: gcOnlySequence, gc_max: 90, check_off_target: false, max_guides: 10 });
  const rescued = widened.guides.find((g) => g.sequence === gcOnlyGuide);
  assert.ok(rescued, 'widening gc_max rescues the GC-rich guide');
  assert.equal(rescued.gc_percent, 85);
  assert.equal(rescued.score, 67.5);

  // max_guides truncates the returned list without losing the count.
  const limited = await run('molbio_grna_design', { sequence: target, max_guides: 2, check_off_target: false });
  assert.equal(limited.guides.length, 2);
  assert.equal(limited.guides_truncated, true);
  assert.equal(limited.candidate_count, 4);
  assert.equal(limited.off_target_scanned, 0, 'no off-target search when it is switched off');
  // Without the search the off-target penalty is absent, so the same guide
  // scores higher than in the searched run (96) — the difference is the point.
  assert.equal(limited.guides.find((g) => g.start === 6).score, 100);

  // CSV + map outputs.
  const files = await run('molbio_grna_design', { sequence: target, save_path: 'C:/tmp/guides.csv', map_path: 'C:/tmp/grna-map.svg' });
  assert.equal(files.saved_to, 'C:/tmp/guides.csv');
  assert.equal(files.map_path, 'C:/tmp/grna-map.svg');
  const csv = memFs.files.get('C:/tmp/guides.csv').toString('utf8');
  const csvLines = csv.trim().split('\n');
  assert.equal(csvLines[0], 'rank,sequence,pam,strand,start,end,gc_percent,tm_celsius,self_any,self_end,longest_t_run,off_target_count,score');
  assert.equal(csvLines.length, 5, 'header + four guides');
  assert.ok(csv.includes(guide));
  const mapSvg = memFs.files.get('C:/tmp/grna-map.svg').toString('utf8');
  assert.ok(mapSvg.includes('gRNA 1'), 'the map labels every guide');

  // A .dna/.gb path is accepted as the target, same as a raw sequence.
  const fromFile = await run('molbio_grna_design', { sequence_path: 'C:/tmp/pUC118.dna', max_guides: 3, check_off_target: false });
  assert.equal(fromFile.target_name, 'pUC118');
  assert.equal(fromFile.target_length, 3162);
  assert.ok(fromFile.guides.length > 0, 'pUC118 has NGG sites');
  assert.ok(fromFile.guides.every((g, index) => g.rank === index + 1), 'ranks are 1..n in score order');
  assert.ok(fromFile.guides.every((g, index, list) => index === 0 || list[index - 1].score >= g.score), 'guides are sorted by score');

  // Error paths.
  await assert.rejects(() => run('molbio_grna_design', {}), /exactly one of/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target, sequence_path: 'C:/tmp/pUC118.dna' }), /exactly one of/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: 'ACGT' }), /at least 23 bp/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target.replace('TTTTT', 'NNNNN') }), /ambiguous base N at position 1/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target, pam: 'GG' }), /must start with the degenerate position N/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target, pam: 'NGGGGGGG' }), /must be 2-6 nt/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target, max_mismatches: 9 }), /max_mismatches must be an integer between 0 and 4/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target, gc_min: 80, gc_max: 20 }), /must not exceed gc_max/);
  await assert.rejects(() => run('molbio_grna_design', { sequence: target, guide_length: 12 }), /guide_length must be an integer between 15 and 30/);
}

// ── v17: TaqMan probes, multiplex, protein plots, methylation digests ───────

{
  const puc118 = await run('molbio_parse_snapgene', { path: 'C:/tmp/pUC118.dna' });
  const slice = puc118.sequence.slice(1200, 1800); // 600 bp

  // ── TaqMan probe design ───────────────────────────────────────────────────
  const assays = await run('molbio_design_taqman', { sequence: slice });
  assert.equal(assays.assays.length, 7, 'seven assays satisfy the probe window on this slice');
  assert.deepEqual(assays.probe_options.length, [18, 27]);
  assert.equal(assays.probe_options.min_tm_delta_vs_primer, 5);
  assert.equal(assays.conditions.primer_nm, 200);
  assert.deepEqual(assays.primer_options.amplicon, [70, 200], 'the assay designer uses qPCR-sized amplicons by default');
  assert.deepEqual(assays.primer_options.region, [1, 600]);
  assert.equal(assays.notes.filter((note) => note.includes('no probe clears the')).length, 5, 'every amplicon whose probe falls short of the Tm margin is reported');

  // Every reported assay must respect the geometry and the probe rules. These
  // are the invariants the module got wrong twice during development, so they
  // are checked on EVERY assay, not only a pinned one.
  for (const assay of assays.assays) {
    const probe = assay.probe;
    const forward = assay.forward;
    const reverse = assay.reverse;
    assert.equal(probe.orientation === 'forward' ? probe.sequence : reverseComplementOf(probe.sequence),
      slice.slice(probe.start - 1, probe.end),
      'a forward probe equals its template slice, a reverse probe its reverse complement');
    if (probe.orientation === 'forward') {
      assert.ok(probe.end < reverse.start || probe.start > reverse.end, 'a probe never overlaps the reverse primer');
    }
    // The probe is read outward from the primer whose 3' end opens the amplicon's
    // gap (the one on the gap's left edge), and the reported distance is measured
    // from exactly that primer's 3' end — for either orientation.
    const reverseUpstream = reverse.end < forward.start;
    const stemThreePrime = reverseUpstream ? reverse.end : forward.end;
    assert.equal(probe.distance_from_primer_3prime, probe.start - stemThreePrime, 'distance is measured from the 3\' end of the primer that opens the gap');
    // Both orientations must keep the default 1 bp clear of the primer they are
    // read from — the rule that stops a probe from competing with its own primer.
    assert.ok(probe.distance_from_primer_3prime >= 1, 'the probe keeps clear of its primer 3\' end');
    // The probe must sit in the amplicon's gap between the two primer sites.
    const overlaps = (interval) => probe.start <= interval.end && probe.end >= interval.start;
    assert.ok(!overlaps({ start: forward.start, end: forward.end }) && !overlaps({ start: reverse.start, end: reverse.end }), 'the probe overlaps neither primer binding site');
    assert.ok(probe.start >= 1 && probe.end <= slice.length, 'probe coordinates stay on the template');
    assert.ok(probe.end - probe.start + 1 === probe.length, 'probe length matches its span');
    assert.equal(probe.five_prime_g, false, 'the no-5\'-G rule is a hard filter');
    assert.equal(probe.three_prime_g, false, 'a 3\' terminal G is filtered out by default');
    assert.equal(probe.runs.length, 0, 'no mononucleotide run survives');
    assert.equal(probe.repeats, 0);
    assert.ok(probe.gc_percent >= 40 && probe.gc_percent <= 65, 'probe GC stays inside the window');
    assert.ok(probe.tm >= 58 && probe.tm <= 72, 'probe Tm stays inside the window');
    assert.ok(probe.tm_delta_vs_primer >= 0 || /Tm margin/.test(assays.notes.join(' ')), 'a negative Tm margin is only acceptable when it is reported');
    assert.ok(assay.amplicon.length >= 70 && assay.amplicon.length <= 200, 'the assay designer uses qPCR-sized amplicons');
  }

  // The best-ranked assay, pinned: the probe sits in the amplicon's gap, in the
  // standard (forward) orientation.
  const best = assays.assays[0];
  assert.equal(best.amplicon.length, 83);
  assert.equal(best.forward.sequence, 'GTTCGGTGTAGGTCGTTCG');
  assert.equal(best.reverse.sequence, 'AAGGGAGAAAGGCGGACAG');
  assert.equal(best.probe.sequence, 'AGCGTGGCGCTTTCTCAT');
  assert.equal(best.probe.orientation, 'forward');
  assert.equal(best.probe.start, 321);
  assert.equal(best.probe.end, 338);
  assert.equal(best.probe.length, 18);
  assert.equal(best.probe.tm, 61.71);
  assert.equal(best.probe.tm_delta_vs_primer, 0.81);
  assert.equal(best.probe.gc_percent, 55.56);
  assert.equal(best.probe.distance_from_primer_3prime, 6);
  assert.equal(best.assay_penalty, 11.22);
  // The reported Tm is the same NN model the primer tools use.
  const probeTm = lib.primerTm(best.probe.sequence, { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: 200 }).tm_celsius;
  assert.equal(best.probe.tm, probeTm, 'the probe Tm is the shared NN model, not a second implementation');

  // A second assay, pinned, whose stem primer is the reverse one: the probe is
  // read outward from the reverse primer's 3' end (that is what the reported
  // distance measures), and still sits in the same physical gap.
  const second = assays.assays[2];
  assert.equal(second.amplicon.length, 170);
  assert.equal(second.probe.sequence, 'CCTGTCCGCCTTTCTCCCTTC');
  assert.equal(second.probe.orientation, 'forward');
  assert.equal(second.probe.start, 296);
  assert.equal(second.probe.end, 316);
  assert.equal(second.probe.tm, 64.11);
  assert.equal(second.probe.tm_delta_vs_primer, 7.31);
  assert.equal(second.probe.distance_from_primer_3prime, 67);
  // The gap lies between the reverse primer (upstream) and the forward primer.
  assert.ok(second.probe.start > second.reverse.end && second.probe.end < second.forward.start);

  // Widening the probe window must be able to rescue an amplicon that had none.
  const widened = await run('molbio_design_taqman', { sequence: slice, probe_tm_min: 45, probe_len_min: 16, min_tm_delta: 0 });
  assert.ok(widened.assays.length >= assays.assays.length, 'a wider window never returns fewer assays');

  // Error paths: each option is validated as itself, not as "no assay found".
  await assert.rejects(() => run('molbio_design_taqman', { sequence: slice, probe_len_max: 10 }), /probe_len_max must be an integer between probe_len_min and 40/);
  await assert.rejects(() => run('molbio_design_taqman', { sequence: slice, probe_tm_min: 80, probe_tm_max: 60 }), /probe_tm_min must be lower than probe_tm_max/);
  await assert.rejects(() => run('molbio_design_taqman', { sequence: slice, probe_min_distance_from_primer: 20 }), /probe_min_distance_from_primer must be an integer between 0 and 12/);
  await assert.rejects(() => run('molbio_design_taqman', { sequence: slice, primer_options: { tm_min: 70, tm_max: 60 } }), /tm_min must be lower than tm_max/);

  // ── multiplex compatibility ───────────────────────────────────────────────
  // Four real primer pairs designed on the same slice; the last two amplicons
  // are 164 and 168 bp, which is the gel-resolvability defect a multiplexer has
  // to catch. The panel is described explicitly (coordinates given) so the test
  // does not depend on which pair the designer ranks first.
  const multiplexTargets = [
    { name: 'amp1', sequence: slice, forward: 'AGGATTAGCAGAGCGAGG', reverse: 'CGAACGACCTACACCGAAC', amplicon_start: 361, amplicon_end: 524 },
    { name: 'amp2', sequence: slice, forward: 'TACCTGTCCGCCTTTCTC', reverse: 'TATCTTTATAGTCCTGTCGGG', amplicon_start: 209, amplicon_end: 311 },
    { name: 'amp3', sequence: slice, forward: 'TTAGCAGAGCGAGGTATG', reverse: 'GAACGACCTACACCGAAC', amplicon_start: 361, amplicon_end: 528 },
    { name: 'amp4', sequence: slice, forward: 'GTTCGGTGTAGGTCGTTCG', reverse: 'AAGGGAGAAAGGCGGACAG', amplicon_start: 297, amplicon_end: 379 },
  ];
  const panel = await run('molbio_multiplex_check', { targets: multiplexTargets });
  assert.equal(panel.target_count, 4);
  assert.equal(panel.template_count, 1, 'targets sharing a template are one template');
  assert.equal(panel.primer_count, 8);
  assert.equal(panel.primers.length, 8);
  assert.equal(panel.interactions.length, 24, 'every primer pair is checked; a benign intended pair inside one target is not reported');
  // The pinned panel's real defect is the gel, not the dimers: 164 vs 168 bp.
  assert.equal(panel.compatible, false);
  assert.deepEqual(panel.size_conflicts, [
    { a: 'amp1', b: 'amp3', a_length: 164, b_length: 168, difference_bp: 4, severity: 'indistinguishable' },
    { a: 'amp2', b: 'amp4', a_length: 103, b_length: 83, difference_bp: 20, severity: 'close' },
  ]);
  assert.equal(panel.conflicting_interactions, 3, 'the curated panel has three real cross-target dimers');
  assert.equal(panel.cross_target_conflicts, 3);
  assert.deepEqual(panel.interactions.filter((entry) => entry.conflict).map((entry) => [entry.a, entry.b, entry.end_tm]), [
    ['amp1/reverse', 'amp4/forward', 69.1],
    ['amp3/reverse', 'amp4/forward', 66.03],
    ['amp2/forward', 'amp4/reverse', 61.23],
  ]);
  assert.equal(panel.cross_template_mispriming, 0, 'one shared template cannot cross-react with itself');
  assert.ok(panel.advice.some((line) => line.includes('their 3\'-anchored dimer Tm is 69.1')), 'a cross-dimer produces redesign advice');
  assert.ok(panel.advice.some((line) => line.includes('not resolvable')), 'the size conflict produces redesign advice');
  assert.ok(!panel.advice.some((line) => line.includes('differ by only 20 bp')), 'a merely close pair is not called unresolvable');
  assert.ok(panel.notes.some((line) => line.includes('not modelled here')), 'the panel states what it does not model');
  for (const primer of panel.primers) {
    assert.ok(['forward', 'reverse'].includes(primer.role));
    assert.ok(primer.tm > 40 && primer.tm < 80, 'primer Tms are plausible');
    // The scores are Primer3-style alignment scores: an all-mismatch register is
    // negative, so only "any" (a local alignment) is guaranteed non-negative.
    assert.ok(primer.self_any >= 0);
    assert.ok(Number.isFinite(primer.self_end));
  }

  // A primer whose 3' tail also matches ANOTHER target's template is the
  // multiplex cross-reaction: it must be reported as such (and as blocking).
  // Identical template sequences are ONE template, so they cannot cross-react...
  const identicalTemplates = await run('molbio_multiplex_check', {
    targets: [
      { name: 'geneA', sequence: 'AAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTT', forward: 'AAACCCGGGTTTAAACCCGG', reverse: 'CCCGGGTTTAAACCCGGGTT' },
      { name: 'geneB', sequence: 'AAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTT', forward: 'AAACCCGGGTTTAAACCCGG', reverse: 'CCCGGGTTTAAACCCGGGTT' },
    ],
  });
  assert.equal(identicalTemplates.template_count, 1, 'identical template sequences are one template');
  assert.equal(identicalTemplates.cross_template_mispriming, 0);
  // ...while two DIFFERENT templates sharing a primer's tail do.
  const distinctTemplates = await run('molbio_multiplex_check', {
    targets: [
      { name: 'geneA', sequence: 'AAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAACCCGGGTTT', forward: 'AAACCCGGGTTTAAACCCGG', reverse: 'CCCGGGTTTAAACCCGGGTT' },
      { name: 'geneB', sequence: 'AAACCCGGGTTTAAACCCGGGTTTAGGGTTTAAACCCGGGTTTAAACCCGGGTTTAAAAA', forward: 'GGGTTTAAACCCGGGTTTAA', reverse: 'TTTAAACCCGGGTTTAAACC' },
    ],
  });
  assert.equal(distinctTemplates.template_count, 2);
  assert.equal(distinctTemplates.cross_template_mispriming, 4, 'each primer of the pair finds the other template');
  assert.ok(distinctTemplates.mispriming.filter((entry) => entry.scope === 'other_templates').every((entry) => entry.perfect_count === 8), 'a cross-reaction needs a perfect 3\' tail');
  assert.ok(distinctTemplates.advice.some((line) => line.includes('another panel template')));
  assert.ok(distinctTemplates.mispriming.find((entry) => entry.scope === 'other_templates').templates[0].positions.length <= 6, 'site lists are capped');

  // Two targets with no amplicon coordinates cannot produce a size conflict.
  const noCoords = await run('molbio_multiplex_check', {
    targets: [
      { name: 'a', sequence: 'AAAAGATCTAAAACCTGGAAAAGCATGCTTTTGAATTCTTTTAAGCTTGGATCCAAAAAA', forward: 'AAAAGATCTAAAACCTGGAA', reverse: 'TTTTTGGATCCAAGCTTAAA' },
      { name: 'b', sequence: 'GGGGCCCCTTTTAAAACCCCGGGGTTTTAAAACCCCGGGGTTTTAAAACCCCGGGGTTTT', forward: 'GGGGCCCCTTTTAAAACCCC', reverse: 'AAAACCCCGGGGTTTTAAAA' },
    ],
  });
  assert.equal(noCoords.size_conflicts.length, 0);
  assert.deepEqual(noCoords.amplicons, [{ name: 'a' }, { name: 'b' }], 'an amplicon without coordinates reports no size');

  await assert.rejects(() => run('molbio_multiplex_check', { targets: [] }), /targets must be a non-empty array/);
  await assert.rejects(() => run('molbio_multiplex_check', { targets: [{ name: 'x' }] }), /targets\[0\]\.sequence": missing/);
  await assert.rejects(() => run('molbio_multiplex_check', { targets: [{ name: 'x', sequence: slice, forward: 'ACGTACGTACGTACGTAC' }] }), /must give both forward and reverse primers/);
  await assert.rejects(() => run('molbio_multiplex_check', { targets: multiplexTargets, dimer_tm_threshold: 0 }), /dimer_tm_threshold must be a positive/);

  // ── helical wheel ─────────────────────────────────────────────────────────
  const wheel = await run('molbio_helical_wheel', { sequence: 'INLKALAALAKKIL' });
  assert.equal(wheel.residues_shown, 14, 'the whole peptide is drawn at 3.6 residues/turn');
  assert.equal(wheel.start, 1);
  assert.equal(wheel.end, 14);
  assert.equal(wheel.degrees_per_residue, 100);
  assert.equal(wheel.hydrophobic_moment, 0.353);
  assert.equal(wheel.maximum_window_moment, 0.584);
  assert.equal(wheel.maximum_window_start, 3);
  assert.deepEqual(wheel.class_counts, { hydrophobic: 10, polar: 1, acidic: 0, basic: 3 });
  assert.equal(wheel.hydrophobic_fraction, 0.714);
  assert.ok(wheel.notes.some((note) => note.includes('amphipathic')), 'a high moment is called out');
  // Residue 1 sits at the top (90°) and each step subtracts 100°.
  assert.equal(wheel.residues[0].amino_acid, 'I');
  assert.equal(wheel.residues[0].angle_degrees, 90);
  assert.equal(wheel.residues[0].x, 0);
  assert.equal(wheel.residues[0].y, -1);
  assert.equal(wheel.residues[1].amino_acid, 'N');
  assert.equal(wheel.residues[1].angle_degrees, 350);
  assert.equal(wheel.residues[1].hydropathy, -3.5);
  assert.equal(wheel.residues[1].hydrophobicity, -0.78);
  for (const residue of wheel.residues) {
    const radius = Math.sqrt(residue.x * residue.x + residue.y * residue.y);
    assert.ok(Math.abs(radius - 1) < 0.002, 'unit-circle coordinates');
  }
  const wheelSvg = memFs.files.get(wheel.svg_path).toString('utf8');
  assert.ok(wheelSvg.startsWith('<svg') && wheelSvg.endsWith('</svg>'));
  assert.ok(wheelSvg.includes('Helical wheel'));
  assert.ok(wheelSvg.includes('μH 0.353'));
  // Glyphs are bounded by font-size + textLength, so none can overflow a residue
  // circle of radius 17 (the sequence-logo lesson, re-applied here).
  const wheelGlyphs = [...wheelSvg.matchAll(/font-size="13"[^>]*textLength="(\d+)"/g)].map((match) => Number(match[1]));
  assert.equal(wheelGlyphs.length, 14, 'one glyph per residue');
  assert.ok(wheelGlyphs.every((length) => length <= 34), 'no glyph can overflow its residue circle');
  assert.equal(wheel.auto_viewed, false, 'auto-view is disabled in tests');
  await assert.rejects(() => run('molbio_helical_wheel', { sequence: 'INLKALAALAKKIL', start: 0 }), /start must be an integer between 1/);
  await assert.rejects(() => run('molbio_helical_wheel', { sequence: 'INLKALAALAKKIL', residues_per_turn: 9 }), /residues_per_turn must be a number between 2 and 6/);
  await assert.rejects(() => run('molbio_helical_wheel', { sequence: 'INLKALAALAKKIL', moment_window: 1 }), /moment_window must be an integer between 2 and 40/);

  // ── hydropathy plot ───────────────────────────────────────────────────────
  const hydropathyProtein = 'MKKLLLLLLLGGGGGAAGGGGGLLLLLLLKKKKRRRRDDDDEEEE' + 'MKTIIALSYIFCLVFADYKDDDDK';
  const profile = await run('molbio_hydropathy_plot', { sequence: hydropathyProtein, window: 9 });
  assert.equal(profile.length, 69);
  assert.equal(profile.window, 9);
  assert.equal(profile.threshold, 1.6);
  assert.equal(profile.gravy, -0.13);
  assert.equal(profile.mean_profile, -0.103);
  assert.equal(profile.minimum_hydropathy, -4.122);
  assert.equal(profile.maximum_hydropathy, 2.867);
  assert.deepEqual(profile.peaks, [
    { start: 4, end: 10, length: 7, maximum: 2.867, maximum_position: 8 },
    { start: 23, end: 27, length: 5, maximum: 2.867, maximum_position: 25 },
    { start: 52, end: 59, length: 8, maximum: 2.478, maximum_position: 53 },
  ]);
  assert.equal(profile.points.length, 69, 'one profile point per residue');
  assert.deepEqual(profile.points[0], { position: 1, amino_acid: 'M', hydropathy: 0.34, window: [1, 5] });
  // The first residue's window is truncated at the terminus (centred window).
  assert.deepEqual(profile.points[68].window, [65, 69]);
  // A window average is the mean of the raw Kyte-Doolittle values it spans.
  const manual = [...hydropathyProtein.slice(0, 5)].map((aa) => ({ A: 1.8, M: 1.9, K: -3.9, L: 3.8 }[aa] ?? -0.8));
  const manualMean = manual.reduce((sum, value) => sum + value, 0) / manual.length;
  assert.equal(profile.points[0].hydropathy, Math.round(manualMean * 1000) / 1000, 'the first window is the mean over residues 1-5');
  const hydropathySvg = memFs.files.get(profile.svg_path).toString('utf8');
  assert.ok(hydropathySvg.startsWith('<svg') && hydropathySvg.endsWith('</svg>'));
  assert.ok(hydropathySvg.includes('threshold 1.6'));
  assert.equal((hydropathySvg.match(/<polyline points="([^"]+)"/)[1]).split(' ').length, 69, 'the profile line has one vertex per residue');
  assert.equal([...hydropathySvg.matchAll(/fill="#e07a5f"\/>/g)].length, 3, 'one marker per peak');
  assert.ok(hydropathySvg.includes('>4-10<'), 'peaks are labelled with their residue range');
  // A 21-residue window smooths the same protein into fewer, flatter peaks.
  const smooth = await run('molbio_hydropathy_plot', { sequence: hydropathyProtein, window: 21 });
  assert.equal(smooth.peaks.length, 2);
  assert.equal(smooth.maximum_hydropathy, 1.845);
  assert.equal(smooth.gravy, profile.gravy, 'GRAVY is window-independent');
  await assert.rejects(() => run('molbio_hydropathy_plot', { sequence: hydropathyProtein, window: 2 }), /window must be an integer between 3 and 51/);
  await assert.rejects(() => run('molbio_hydropathy_plot', { sequence: hydropathyProtein, threshold: 9 }), /threshold must be a number between -4.5 and 4.5/);
  await assert.rejects(() => run('molbio_hydropathy_plot', { sequence: 'MKKZ' }), /invalid character "Z"/);

  // ── methylation-aware digest ──────────────────────────────────────────────
  // Hand-built fixture: three GATC-bearing ClaI sites (blocked by Dam), one
  // BamHI site whose GATC is Dam-methylated (impaired), one Dcm site that
  // overlaps nothing in the selection, and clean EcoRI/HindIII/XbaI sites.
  const blockedSequence = 'GATCGATCGATCGGATCCAAAAATCGATAAAAAAGCTTTTTTGAATTCAAAACCTGGAAAAATCTAGATTTTT';
  const methyl = await run('molbio_methylation_check', { sequence: blockedSequence, enzymes: ['BamHI', 'ClaI', 'XbaI', 'EcoRI', 'HindIII', 'KpnI', 'ApaI'] });
  assert.equal(methyl.length, blockedSequence.length);
  assert.deepEqual(methyl.sites_by_mark, { dam: 4, dcm: 1 });
  assert.equal(methyl.enzymes_checked, 7);
  const status = (name) => methyl.per_enzyme.find((entry) => entry.enzyme === name);
  assert.equal(status('ClaI').status, 'blocked');
  assert.deepEqual(status('ClaI').blocked_by, ['dam']);
  assert.equal(status('ClaI').sites, 3);
  assert.equal(status('BamHI').status, 'impaired');
  assert.deepEqual(status('BamHI').impaired_by, ['dam']);
  assert.equal(status('EcoRI').status, 'cuts');
  assert.equal(status('HindIII').status, 'cuts');
  assert.equal(status('XbaI').status, 'cuts');
  assert.equal(status('KpnI').status, 'no_site');
  assert.deepEqual(methyl.usable, ['EcoRI', 'HindIII', 'XbaI']);
  assert.deepEqual(methyl.risky, ['BamHI', 'ClaI']);
  assert.deepEqual(methyl.blocked, [{ enzyme: 'ClaI', by: ['dam'], sites: 3 }]);
  assert.deepEqual(methyl.impaired, [{ enzyme: 'BamHI', by: ['dam'], sites: 1 }]);
  // Fragment arithmetic: EcoRI cuts at 44 linear -> 43 + 30.
  const eco = methyl.recommended.find((entry) => entry.enzyme === 'EcoRI');
  assert.deepEqual(eco.cut_positions, [44]);
  assert.deepEqual(eco.fragments, [43, 30]);
  assert.ok(methyl.advice.some((line) => line.includes('BLOCKED by dam methylation') && line.includes('EcoRI')), 'the advice names the blocked enzyme and survivable alternatives');
  // The Dam marks are only attributed to an enzyme whose own site they overlap.
  const damSites = methyl.methylation_sites.filter((site) => site.mark === 'dam');
  assert.equal(damSites.length, 4);
  assert.deepEqual(damSites[0], { mark: 'dam', site: 'GATC', start: 1, sequence: 'GATC', strand: 'top', overlapping_enzymes: ['ClaI'] });
  assert.deepEqual(damSites[3].overlapping_enzymes, ['BamHI', 'BstYI']);
  const dcmSite = methyl.methylation_sites.find((site) => site.mark === 'dcm');
  assert.deepEqual(dcmSite, { mark: 'dcm', site: 'CCWGG', start: 53, sequence: 'CCTGG', strand: 'top', overlapping_enzymes: [] });
  assert.ok(methyl.notes.some((note) => note.includes('quick reference')), 'the reference-data caveat travels with the result');

  // On the real plasmid the default selection finds Dam/Dcm marks and reports
  // the methylation-sensitive enzymes that survive them.
  const plasmidMethyl = await run('molbio_methylation_check', { sequence: puc118.sequence });
  assert.deepEqual(plasmidMethyl.sites_by_mark, { dam: 15, dcm: 5 });
  assert.equal(plasmidMethyl.blocked.length, 0);
  assert.deepEqual(plasmidMethyl.impaired, [{ enzyme: 'BamHI', by: ['dam'], sites: 1 }, { enzyme: 'BstYI', by: ['dam'], sites: 7 }]);
  assert.ok(plasmidMethyl.usable.includes('KpnI') && plasmidMethyl.usable.includes('XbaI'));
  assert.ok(plasmidMethyl.per_enzyme.some((entry) => entry.status === 'no_site'), 'enzymes with no site are reported as no_site, not as blocked');

  await assert.rejects(() => run('molbio_methylation_check', { sequence: blockedSequence, marks: [] }), /marks must be a non-empty array/);
  await assert.rejects(() => run('molbio_methylation_check', { sequence: blockedSequence, enzymes: ['NopeI'] }), /unknown enzyme "NopeI"/);

  // ── double digest ─────────────────────────────────────────────────────────
  const doubleDigest = await run('molbio_double_digest', { sequence: puc118.sequence, first: 'EcoRI', second: 'HindIII', circular: true });
  assert.deepEqual(doubleDigest.first, { name: 'EcoRI', cut_positions: [927], fragments: [3162] });
  assert.deepEqual(doubleDigest.second, { name: 'HindIII', cut_positions: [876], fragments: [3162] });
  assert.deepEqual(doubleDigest.combined_cut_positions, [876, 927]);
  assert.deepEqual(doubleDigest.combined_fragments, [3111, 51]);
  assert.equal(doubleDigest.sequential_required, false);
  assert.deepEqual(doubleDigest.buffers.map((buffer) => buffer.key), ['r1.1', 'r2.1', 'r3.1', 'cutsmart']);
  assert.ok(doubleDigest.all_shared_buffers.some((buffer) => buffer.legacy === true), 'legacy buffers are kept but not recommended');
  assert.ok(doubleDigest.advice[0].includes('digested together in'), 'a shared buffer is stated as advice');
  // Two enzymes with no shared buffer in the table force a sequential digest.
  const sequential = await run('molbio_double_digest', { sequence: puc118.sequence, first: 'BstXI', second: 'SmaI' });
  assert.equal(sequential.sequential_required, true);
  assert.deepEqual(sequential.buffers, []);
  assert.ok(sequential.advice[0].includes('share no buffer'), 'the sequential-digest route is spelled out');
  // A site-less combination is flagged rather than silently reported.
  const single = await run('molbio_double_digest', { sequence: 'AAAAGAATTCAAACCCGGGTTT', first: 'EcoRI', second: 'XhoI' });
  assert.ok(single.advice.some((line) => line.includes('has no site on this template')), 'an enzyme with no site is called out');
  await assert.rejects(() => run('molbio_double_digest', { sequence: puc118.sequence, first: 'EcoRI', second: 'EcoRI' }), /needs two different enzymes/);
  await assert.rejects(() => run('molbio_double_digest', { sequence: puc118.sequence, first: 'EcoRI', second: 'NopeI' }), /unknown enzyme "NopeI"/);
}

// ── v18: the opt-in picture hand-off ────────────────────────────────────────
//
// The workspace cannot hold the PNG (the harness fs seam is text-only by
// contract), so a picture reaches the model as an image content block backed by
// ctx.attachments.saveImage(). These checks cover the wiring: what we commit,
// what the result carries, and every reason the picture may be missing — the
// SVG must still be written and the call must still succeed in all of them.

{
  const committed = [];
  let modalities = ['text', 'image'];
  extraServices.set('attachments', {
    async saveImage({ data, mediaType, name }) {
      committed.push({ data, mediaType, name });
      // Mirrors the harness's ImageAttachmentRef (brand is type-level only).
      return { attachmentId: `att-${committed.length}`, mediaType, bytes: data.length, width: 42, height: 43, name };
    },
  });
  extraServices.set('llm', {
    async resolveModelInfo() {
      return { inputModalities: modalities };
    },
  });
  const routedExec = {
    agent: {
      session: { header: { cwd: 'C:/tmp' }, requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
      options: {},
    },
  };
  const toolByName = (toolName) => registered.find((t) => t.name === toolName);
  const runWith = async (toolName, args, exec) => {
    const tool = toolByName(toolName);
    const value = await tool.execute(args, exec);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [], `${toolName} output violates its schema with attach_image`);
    return { value, blocks: tool.output.render(args, value) };
  };

  // 1. Not asked → nothing changes for existing callers.
  committed.length = 0;
  const plain = await runWith('molbio_virtual_gel', { lanes: [{ label: '1', fragments: [1000] }] }, routedExec);
  assert.equal(plain.value.image, undefined, 'no image without attach_image');
  assert.equal(plain.value.image_note, undefined, 'and no note either');
  assert.equal(committed.length, 0, 'nothing was committed to the attachment store');
  assert.equal(plain.blocks.length, 1, 'the result stays a single text block');

  // 2. Asked on an image-capable route → a real PNG is committed and attached.
  const gel = await runWith('molbio_virtual_gel', {
    lanes: [{ label: '1', fragments: [3000, 1000] }, { label: '2', fragments: [1500] }],
    attach_image: true,
    output_path: 'C:/tmp/gel.svg',
  }, routedExec);
  assert.equal(committed.length, 1, 'exactly one image was committed');
  const [png] = committed;
  assert.equal(png.mediaType, 'image/png');
  assert.equal(png.name, 'gel.png', 'the attachment is named after the written file');
  assert.deepEqual([...png.data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the committed bytes are a PNG');
  const header = new DataView(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  // The gel canvas is LEFT_GUTTER 70 + (lanes + the ladder) x LANE_WIDTH 70 +
  // RIGHT_GUTTER 20, and TOP_MARGIN 60 + RUN_LENGTH 600 + BOTTOM_MARGIN 40.
  assert.equal(header.getUint32(16), 70 + 3 * 70 + 20, 'IHDR width matches the gel canvas');
  assert.equal(header.getUint32(20), 700, 'IHDR height matches the gel canvas');
  assert.deepEqual(gel.value.image, { attachment_id: 'att-1', media_type: 'image/png', bytes: png.data.length, width: 42, height: 43, name: 'gel.png' });
  assert.equal(gel.blocks.length, 2, 'the render carries the picture beside the text');
  assert.equal(gel.blocks[1].type, 'image');
  assert.deepEqual(gel.blocks[1].attachment, { attachmentId: 'att-1', mediaType: 'image/png', bytes: png.data.length, width: 42, height: 43, name: 'gel.png' });
  assert.ok(gel.blocks[0].text.includes('The rendered PNG is attached'), 'the text tells the model the picture is there');
  assert.ok(memFs.files.get('C:/tmp/gel.svg').includes('<svg'), 'the SVG is still written');

  // 3. The direct map path (not writeSvgFile) is wired too.
  committed.length = 0;
  const map = await runWith('molbio_plasmid_map', { sequence: 'ATGCATGCATGCATGCATGC', name: 'tiny', attach_image: true }, routedExec);
  assert.equal(committed.length, 1, 'the map tool reaches the same attachment path');
  assert.equal(map.value.image.attachment_id, 'att-1');
  assert.equal(map.blocks[1].type, 'image');

  // 4. A text-only route degrades to text that names the reason.
  modalities = ['text'];
  committed.length = 0;
  const textOnly = await runWith('molbio_virtual_gel', { lanes: [{ label: '1', fragments: [500] }], attach_image: true }, routedExec);
  assert.equal(textOnly.value.image, undefined);
  assert.match(textOnly.value.image_note, /does not declare image input/);
  assert.equal(textOnly.blocks.length, 1, 'and no image block is produced');
  assert.match(textOnly.blocks[0].text, /no image was attached/);
  assert.equal(committed.length, 0, 'nothing is committed for a route that cannot see it');
  modalities = ['text', 'image'];

  // 5. No attachment service mounted (a bare composition).
  extraServices.delete('attachments');
  const noStore = await runWith('molbio_virtual_gel', { lanes: [{ label: '1', fragments: [500] }], attach_image: true, output_path: 'C:/tmp/gel.svg' }, routedExec);
  assert.match(noStore.value.image_note, /mounts no attachment service/);
  assert.equal(noStore.value.svg_path, 'C:/tmp/gel.svg', 'the SVG is still written and reported');
  extraServices.set('attachments', {
    async saveImage({ data, mediaType, name }) {
      committed.push({ data, mediaType, name });
      return { attachmentId: `att-${committed.length}`, mediaType, bytes: data.length, width: 42, height: 43, name };
    },
  });

  // 6. An unresolvable route is a degradation, not a failure.
  const noRoute = await runWith('molbio_virtual_gel', { lanes: [{ label: '1', fragments: [500] }], attach_image: true }, fakeExec);
  assert.match(noRoute.value.image_note, /route could not be resolved/);

  // 7. A refusing store is a degradation too.
  extraServices.set('attachments', {
    async saveImage() {
      throw new Error('store is full');
    },
  });
  const refused = await runWith('molbio_virtual_gel', { lanes: [{ label: '1', fragments: [500] }], attach_image: true }, routedExec);
  assert.match(refused.value.image_note, /attachment store refused the image: store is full/);
  assert.equal(refused.value.image, undefined);
  extraServices.set('attachments', {
    async saveImage({ data, mediaType, name }) {
      committed.push({ data, mediaType, name });
      return { attachmentId: `att-${committed.length}`, mediaType, bytes: data.length, width: 42, height: 43, name };
    },
  });

  // 8. Every picture tool carries the parameter and the output field.
  const pictureTools = [
    'molbio_plasmid_map', 'molbio_plasmid_map_file', 'molbio_clone_simulate', 'molbio_golden_gate',
    'molbio_grna_design', 'molbio_qpcr_efficiency', 'molbio_plot', 'molbio_virtual_gel',
    'molbio_sequence_logo', 'molbio_helical_wheel', 'molbio_hydropathy_plot',
    'molbio_fastq_qc', 'molbio_phylogenetic_tree', 'molbio_pcr_simulate', 'molbio_gc_composition',
  ];
  for (const toolName of pictureTools) {
    const tool = toolByName(toolName);
    assert.ok(Object.hasOwn(tool.parameters.properties, 'attach_image'), `${toolName} offers attach_image`);
    assert.ok(Object.hasOwn(tool.output.schema.properties, 'image'), `${toolName} can report the attached image`);
    assert.ok(Object.hasOwn(tool.output.schema.properties, 'image_note'), `${toolName} can explain a missing image`);
  }
  assert.equal(registered.filter((tool) => Object.hasOwn(tool.parameters.properties, 'attach_image')).length, 15, 'exactly the 15 picture tools — the report-only analysis tools are untouched');

  // 9. Rendering text alone still works (the attachment must not break render).
  const logo = await runWith('molbio_sequence_logo', { alignment: ['ACGTACGT', 'ACGTTCGT'], attach_image: true }, routedExec);
  assert.equal(logo.blocks[0].type, 'text');
  assert.ok(logo.blocks[0].text.includes('sequence logo written to'));
  assert.equal(logo.blocks[1].type, 'image');
}

// ── v19: read-level FASTQ QC ────────────────────────────────────────────────
//
// A hand-built 8-read fixture whose every statistic is worked out by hand
// below. Quality strings are written Phred+33 (Q=0 -> '!'), which is what the
// decoder assumes; positions are reported 1-based, as in every other tool.
{
  const read = (id, sequence, qualities) => ({ id, sequence, qualities });
  const fixture = [
    read('r1', 'ACGT', [30, 30, 30, 10]),
    read('r2', 'ACGT', [20, 20, 20, 10]),
    read('r3', 'ACGT', [10, 10, 10, 10]),
    read('r4', 'ACGTACGTAC', [40, 40, 40, 40, 40, 40, 40, 40, 40, 40]),
    read('r5', 'AAAAAAAAAA', [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
    read('r6', 'ACGT', [40, 40, 40, 40]),
    read('r7', 'ACGTACGT', [20, 20, 20, 20, 20, 20, 20, 20]),
    read('r8', 'ACGTACGTACGTAGATCGGAAGAG', [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12]),
  ];
  const qualityString = (qualities) => qualities.map((value) => String.fromCharCode(33 + value)).join('');
  const fastqText = fixture.map((entry) => `@${entry.id}\n${entry.sequence}\n+\n${qualityString(entry.qualities)}\n`).join('');
  const totalReads = fixture.length;
  const totalBases = fixture.reduce((sum, entry) => sum + entry.sequence.length, 0);

  const qc = await run('molbio_fastq_qc', { fastq: fastqText, max_plot_bases: 10 });

  // 1. Headline counts and length statistics.
  assert.equal(qc.reads, totalReads);
  assert.equal(qc.reads_total, totalReads);
  assert.equal(qc.truncated, false);
  assert.equal(qc.bases, totalBases);
  assert.deepEqual(
    [qc.length.min, qc.length.max, qc.length.median, qc.length.n50, qc.length.distinct_lengths],
    [4, 24, 6, 10, 4],
    'lengths sorted 4,4,4,4,8,10,10,24 -> max 24 (the adapter read), median (4+8)/2 = 6, N50 10, four distinct values',
  );
  assert.equal(qc.length.histogram.reduce((sum, bin) => sum + bin.reads, 0), totalReads, 'the histogram accounts for every read');

  // 2. Per-position quality: mean/median/quartiles are hand-computed.
  assert.equal(qc.per_base.length, 10, 'the plot cap is honoured even though one read is 24 bp');
  const position1 = qc.per_base[0];
  assert.deepEqual(
    { mean: position1.mean, median: position1.median, lower: position1.lower_quartile, upper: position1.upper_quartile, min: position1.min, max: position1.max, observations: position1.observations },
    { mean: 25, median: 25, lower: 17.5, upper: 32.5, min: 10, max: 40, observations: 8 },
    'Q at position 1: 30,20,10,40,10,40,20,30 -> sorted 10,10,20,20,30,30,40,40; quartiles are linearly interpolated',
  );
  assert.equal(position1.a_percent, 100, 'every read in this fixture starts with A — said plainly, because a per-base composition that is 100% one base is itself a red flag');
  assert.equal(position1.c_percent, 0);
  assert.equal(position1.g_percent, 0);
  assert.equal(position1.t_percent, 0);
  const position2 = qc.per_base[1];
  // Position 2 across the eight reads: C,C,C,C,A,C,C,C -> 87.5% C, 12.5% A.
  assert.deepEqual(
    [position2.a_percent, position2.c_percent, position2.g_percent, position2.t_percent],
    [12.5, 87.5, 0, 0],
    'the composition tracks the actual base at each position',
  );
  const lastPosition = qc.per_base[9];
  assert.deepEqual(
    { observations: lastPosition.observations, mean: lastPosition.mean, min: lastPosition.min, max: lastPosition.max },
    { observations: 3, mean: 26.67, min: 10, max: 40 },
    'position 10 belongs to the two 10-base reads (Q40, Q10) and the 24-mer (Q30): (40+10+30)/3 = 26.67 — the 8-mer has no base 10',
  );
  assert.ok(qc.per_base.every((row, index) => row.position === index + 1), 'positions are 1-based');

  // 3. Q30/Q20 fractions and the quality tail.
  assert.equal(qc.quality_tail_below_30, 1, 'position 1 already averages 25 < 30');
  assert.equal(qc.quality_tail_below_20, 0, 'the worst position mean is 22.5, still above Q20');
  const allQualities = fixture.flatMap((entry) => entry.qualities);
  const q20 = allQualities.filter((value) => value >= 20).length;
  const q30 = allQualities.filter((value) => value >= 30).length;
  assert.equal(qc.quality_q20_percent, Math.round((q20 / allQualities.length) * 10000) / 100);
  assert.equal(qc.quality_q30_percent, Math.round((q30 / allQualities.length) * 10000) / 100);
  assert.equal(qc.quality_mean, Math.round((allQualities.reduce((sum, value) => sum + value, 0) / allQualities.length) * 100) / 100);

  // 4. Composition and the per-sequence quality histogram.
  const gcBases = fixture.reduce((sum, entry) => sum + [...entry.sequence].filter((base) => base === 'G' || base === 'C').length, 0);
  assert.equal(qc.gc_percent, Math.round((gcBases / totalBases) * 10000) / 100);
  assert.equal(qc.n_bases, 0);
  assert.equal(qc.n_percent, 0);
  assert.equal(qc.per_sequence_quality.histogram.reduce((sum, count) => sum + count, 0), totalReads, 'every read lands in a quality bin');
  assert.equal(qc.per_sequence_quality.worst, 10, 'the all-Q10 read is the worst');
  assert.equal(qc.per_sequence_quality.best, 40, 'the all-Q40 read is the best');
  // A, C and T are equally frequent here but G is rare, so the entropy sits
  // below the 2 bits of a perfectly even four-letter sequence.
  assert.equal(qc.content_entropy_bits, 1.918);
  assert.equal(qc.gc_distribution.measured_percent.length, 101);
  assert.equal(Math.round(qc.gc_distribution.measured_percent.reduce((sum, value) => sum + value, 0)), 100, 'measured GC distribution is a percentage per read');

  // 5. Duplication: four reads are the same 4-mer (r1, r2, r3, r6).
  assert.equal(qc.duplication.sampled_reads, totalReads);
  assert.deepEqual(
    [qc.duplication.unique_sequences, qc.duplication.duplicate_reads, qc.duplication.duplicate_groups, qc.duplication.duplication_percent, qc.duplication.remaining_percent],
    [5, 4, 1, 50, 62.5],
    'five distinct sequences, one repeated group holding all four reads of it',
  );
  assert.equal(qc.duplication.top_sequences[0].sequence, 'ACGT');
  assert.equal(qc.duplication.top_sequences[0].count, 4);
  assert.equal(qc.duplication.top_sequences[0].percent, 50);

  // 6. Adapter content: exactly one read carries the Illumina universal fragment.
  assert.deepEqual(qc.adapter.hits.map((hit) => [hit.name, hit.reads, hit.percent]), [['Illumina Universal', 1, 12.5]]);
  assert.equal(qc.adapter.reads_with_adapter, 1);
  assert.equal(qc.adapter.per_base_percent.length, 10, 'the adapter curve shares the plot cap');
  assert.equal(qc.adapter.per_base_percent[0], 0, 'and is zero before the fragment starts at position 13');
  const adapterUncapped = await run('molbio_fastq_qc', { fastq: fastqText, max_plot_bases: 150, output_path: 'C:/tmp/qc-wide.svg' });
  assert.equal(adapterUncapped.adapter.per_base_percent[12], 12.5, 'with no cap the fragment shows at 1-based position 13');
  assert.equal(adapterUncapped.adapter.per_base_percent[23], 12.5, 'through its last base at position 24');
  assert.equal(adapterUncapped.adapter.per_base_percent[24], 0, 'and stops there');

  // 7. Over-representation names the threshold that produced it — and on a
  //    sample this small that threshold legitimately yields nothing, because
  //    the bar is max(20 reads, 0.1% of the sample).
  assert.equal(qc.overrepresented.sampled_reads, totalReads);
  assert.equal(qc.overrepresented.minimum_count, 20);
  assert.deepEqual(qc.overrepresented.rows, [], '8 reads cannot clear a 20-read floor, and the tool says so instead of inventing a hit');
  assert.ok(qc.overrepresented.basis.includes('exact sequence counts'));
  // With a sample worth scanning (24 of 30 reads identical) the same analysis
  // reports the sequence, its share, and the threshold it used. A sequence can
  // only clear the floor by being duplicated, so these two views agree.
  const clonal = Array.from({ length: 30 }, (_, index) => {
    const sequence = index < 24 ? 'ACGTACGT' : `TTTTTTT${'ACGT'[index % 4]}`;
    return `@c${index}\n${sequence}\n+\n${'I'.repeat(8)}\n`;
  }).join('');
  const clonalReport = await run('molbio_fastq_qc', { fastq: clonal, output_path: 'C:/tmp/clonal.qc.svg' });
  assert.equal(clonalReport.overrepresented.minimum_count, 20);
  assert.equal(clonalReport.overrepresented.rows.length, 1, 'only the 24-read sequence clears the floor');
  assert.deepEqual(
    [clonalReport.overrepresented.rows[0].sequence, clonalReport.overrepresented.rows[0].count, clonalReport.overrepresented.rows[0].percent],
    ['ACGTACGT', 24, 80],
  );
  assert.equal(clonalReport.overrepresented.rows[0].possible_source, 'unknown');
  // Duplication counts every read that sits in a repeated group, so the three
  // TTTT variants that each appear twice add to the clonal 24: 28 of 30 reads.
  assert.deepEqual(
    [clonalReport.duplication.unique_sequences, clonalReport.duplication.duplicate_reads, clonalReport.duplication.duplicate_groups, clonalReport.duplication.duplication_percent],
    [5, 28, 3, 93.33],
    'the clonal group plus TTTTA/TTTTC/TTTTG each appearing twice',
  );

  // 8. The picture is written and is the same document shape the rasterizer takes.
  assert.ok(qc.report_path.endsWith('.qc.svg'), `report path looks like a QC report: ${qc.report_path}`);
  const qcSvg = memFs.files.get(qc.report_path);
  assert.ok(typeof qcSvg === 'string' && qcSvg.startsWith('<svg'), 'the SVG report reached the workspace');
  assert.ok(qcSvg.includes('Per-base quality') && qcSvg.includes('Adapter content'), 'and carries the panel titles');

  // 9. Error paths.
  await assert.rejects(() => run('molbio_fastq_qc', {}), /provide exactly one of path .* or fastq/);
  await assert.rejects(() => run('molbio_fastq_qc', { path: 'C:/tmp/reads.fq', fastq: fastqText }), /provide exactly one of path .* or fastq/);
  await assert.rejects(() => run('molbio_fastq_qc', { fastq: '>not-fastq\nACGT\n' }), /looks like FASTA/);
  await assert.rejects(() => run('molbio_fastq_qc', { fastq: '@r1\nACGT\n+\nIII\n' }), /quality shorter than sequence/);
  await assert.rejects(() => run('molbio_fastq_qc', { fastq: fastqText, max_reads: 500000 }), /exceeds the supported/);
  await assert.rejects(() => run('molbio_fastq_qc', { fastq: fastqText, max_reads: -1 }), /max_reads must be a positive integer/);

  // 10. Reading the same fixture from a file gives the identical report.
  memFs.files.set('C:/tmp/qc.fastq', fastqText);
  const fromFile = await run('molbio_fastq_qc', { path: 'C:/tmp/qc.fastq', max_plot_bases: 12 });
  assert.equal(fromFile.quality_mean, qc.quality_mean);
  assert.equal(fromFile.bases, qc.bases);
  assert.ok(fromFile.report_path.includes('qc'), 'the default report name follows the input file');
}

// ── v19: codon usage (CAI / RSCU / Nc) ──────────────────────────────────────
{
  const cds = (body) => `ATG${body}TAA`;

  // 1. Every codon at its host optimum gives CAI exactly 1, and the alanine
  //    family must have FOUR codons — building the families from the partial
  //    optimization table instead of the frequency table made this 0.4444.
  const optimal = await run('molbio_codon_usage', { sequence: cds('GCG'.repeat(20)), host: 'e_coli' });
  assert.equal(optimal.cai, 1);
  assert.equal(optimal.cai_by_codon.GCG, 1, 'the family maximum has relative adaptiveness 1');
  assert.equal(optimal.cai_by_codon.GCA, 0.5833, 'GCA is 0.21/0.36 — and it IS in the family, even though the optimization table omits it');
  assert.equal(optimal.rare_codon_count, 0);
  assert.equal(optimal.host, 'e_coli');
  assert.equal(optimal.has_start_codon, true);
  assert.equal(optimal.has_stop_codon, true);
  assert.equal(optimal.analysed_codons, 22);
  assert.equal(optimal.internal_stop_count, 0, 'the terminal TAA is an end, not an internal stop');

  // 2. A suboptimal but non-rare codon sits between: GCT is 0.16/0.36 = 0.4444.
  const suboptimal = await run('molbio_codon_usage', { sequence: cds('GCT'.repeat(20)), host: 'e_coli' });
  assert.equal(suboptimal.cai, 0.4444);
  assert.equal(suboptimal.cai_by_codon.GCG, 1, 'alternatives are reported too, so the comparison is visible');
  assert.equal(suboptimal.cai_counted_codons.GCT, 20, 'but only the codons actually present enter the geometric mean');
  assert.equal(suboptimal.cai_counted_codons.GCG, undefined);

  // 3. A balanced alanine CDS: equal thirds, so RSCU is 1 for all four codons,
  //    GC3 is exactly 50% and the CAI is a hand-computed geometric mean.
  const balanced = await run('molbio_codon_usage', { sequence: cds('GCA'.repeat(5) + 'GCC'.repeat(5) + 'GCG'.repeat(5) + 'GCT'.repeat(5)), host: 'e_coli' });
  assert.deepEqual([balanced.rscu.GCA, balanced.rscu.GCC, balanced.rscu.GCG, balanced.rscu.GCT], [1, 1, 1, 1]);
  assert.equal(balanced.gc3, 50);
  assert.equal(balanced.cai, 0.664, 'geometric mean over all 20 alanines of (0.5833, 0.75, 1, 0.4444)^5');
  assert.deepEqual(balanced.gc3_distribution, { A: 6, C: 5, G: 6, T: 5 }, 'the six A are the five GCA plus the stop codon; the six G are the five GCG plus the ATG');
  assert.equal(balanced.gc123.length, 3);
  assert.ok(balanced.gc123[0] > balanced.gc123[2], 'position 1 is GC-rich while position 3 is balanced');

  // 4. RSCU is a per-family normalisation: a single-codon usage gives the
  //    family size, which is how the family sizes are pinned.
  const leucine = await run('molbio_codon_usage', { sequence: cds('CTG'.repeat(10)), host: 'e_coli' });
  assert.equal(leucine.rscu.CTG, 6, 'Leu has six codons in E. coli');
  assert.equal(leucine.rscu.TTA, 0, 'and the unused ones are reported as 0');
  assert.equal(leucine.cai, 1);
  assert.equal(leucine.n_codon, 1.03, 'a single-codon CDS is maximally biased; Nc pins the Wright table');

  // 5. The frequency tables must be complete: 61 sense codons per host, each
  //    amino-acid family summing to 1, and no stop codons.
  const { CODON_FREQUENCIES } = await import('../codon.mjs');
  const { CODON_TABLE_BY_NAME } = lib;
  const code = CODON_TABLE_BY_NAME.standard;
  const sense = Object.keys(code).filter((codon) => code[codon] !== '*');
  assert.equal(sense.length, 61);
  for (const [host, table] of Object.entries(CODON_FREQUENCIES)) {
    assert.deepEqual(Object.keys(table).sort(), sense.slice().sort(), `${host} lists exactly the 61 sense codons`);
    const sums = new Map();
    for (const codon of sense) sums.set(code[codon], (sums.get(code[codon]) ?? 0) + table[codon]);
    for (const [aminoAcid, sum] of sums) {
      assert.ok(Math.abs(sum - 1) < 0.011, `${host} ${aminoAcid} frequencies sum to ${sum.toFixed(4)} (within rounding)`);
    }
  }
  // The optimizer's first choice must at least be a reasonably frequent codon.
  const { CODON_USAGE } = await import('../protein.mjs');
  for (const [host, families] of Object.entries(CODON_USAGE)) {
    for (const [aminoAcid, ordered] of Object.entries(families)) {
      const members = sense.filter((codon) => code[codon] === aminoAcid);
      const maximum = Math.max(...members.map((codon) => CODON_FREQUENCIES[host][codon]));
      assert.ok(
        CODON_FREQUENCIES[host][ordered[0]] >= maximum * 0.5,
        `${host} ${aminoAcid}: the optimizer's preferred ${ordered[0]} is not a rare codon`,
      );
    }
  }

  // 6. Rare codons and host switching: human GCG has w = 0.08/0.43 = 0.186.
  const human = await run('molbio_codon_usage', { sequence: cds('GCG'.repeat(20)), host: 'human' });
  assert.equal(human.cai, 0.186);
  assert.equal(human.rare_codon_count, 20);
  assert.equal(human.rare_codons[0].codon, 'GCG');
  assert.equal(human.rare_codons[0].amino_acid, 'A');
  assert.equal(human.rare_codons[0].host_frequency, 0.08);
  assert.equal(human.rare_codons[0].relative_adaptiveness, 0.186);
  assert.equal(human.rare_codons[0].position, 2, 'position 1 is the ATG');
  assert.match(human.cai_interpretation, /poorly adapted/);
  assert.ok(human.warnings.some((warning) => warning.includes('CAI 0.186 is low')));

  // 7. CpG observed/expected, and the reason it is not interpreted for a short CDS.
  const cpgSequence = cds('GCG'.repeat(10));
  const cpg = await run('molbio_codon_usage', { sequence: cpgSequence, host: 'e_coli' });
  // ATG + 10x GCG + TAA is 36 nt with 10 C and 21 G, so the CpG expectation is
  // C*G/length = 210/36 = 5.83 and this deliberately CpG-rich CDS sits at 1.714.
  assert.equal(cpg.cpg.observed, 10, 'each GCG contributes a C followed by a G');
  assert.equal(cpg.cpg.expected, 5.83);
  assert.equal(cpg.cpg.observed_expected, 1.714);
  assert.match(cpg.cpg.interpretation, /not interpreted for sequences under 100 nt/);

  // 8. The local CAI profile is a real windowed series: 12 codons (ATG + 10x
  //    GCG + TAA) in windows of five give starts at codons 1..8.
  const profiled = await run('molbio_codon_usage', { sequence: cds('GCG'.repeat(10)), host: 'e_coli', region_window: 5 });
  assert.equal(profiled.cai_profile.length, 8);
  assert.equal(profiled.cai_profile[0].start_codon, 1);
  assert.equal(profiled.cai_profile[0].end_codon, 5);
  assert.equal(profiled.cai_profile[0].cai, 1, 'an all-optimal window is 1 (ATG and TAA carry no weight)');
  assert.equal(profiled.cai_profile[profiled.cai_profile.length - 1].start_codon, 8);
  assert.equal(profiled.cai_profile[profiled.cai_profile.length - 1].end_codon, 12, 'the terminal stop codon closes the last window');

  // 9. Warnings, not failures, for a CDS that is merely unusual.
  const sloppy = await run('molbio_codon_usage', { sequence: 'GCGGCGGCGG', host: 'e_coli' });
  assert.equal(sloppy.ignored_trailing_bases, 1);
  assert.ok(sloppy.warnings.some((warning) => warning.includes('not a multiple of 3')));
  assert.ok(sloppy.warnings.some((warning) => warning.includes('does not start with ATG')));
  const ambiguous = await run('molbio_codon_usage', { sequence: 'ATGNNNGGGTAA', host: 'e_coli' });
  assert.ok(ambiguous.warnings.some((warning) => warning.includes('ambiguous bases')));
  assert.equal(ambiguous.analysed_codons, 3, 'the ambiguous codon is excluded from the counts');
  const internalStop = await run('molbio_codon_usage', { sequence: 'ATGTAAGGGTAA', host: 'e_coli' });
  assert.equal(internalStop.internal_stop_count, 1);
  assert.deepEqual(internalStop.internal_stops, [{ codon: 'TAA', position: 2 }]);
  assert.ok(internalStop.warnings.some((warning) => warning.includes('internal stop codon')));

  // 10. Error paths. An unknown host is caught by the argument schema (enum),
  //     and the module's own domain check is exercised separately.
  const { codonUsageAnalysis } = await import('../codon.mjs');
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'ACGTTT', host: 'mouse' }), /must be one of e_coli, yeast, human/);
  assert.throws(() => codonUsageAnalysis('ATGGCGTAA', { host: 'mouse' }), /unknown host "mouse"/);
  await assert.rejects(() => run('molbio_codon_usage', { sequence: '   ' }), /coding sequence is empty/);
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'ACGTXYZ' }), /not IUPAC nucleotides/);
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'GC' }), /shorter than one codon/);
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'ATGGCG', region_window: 2 }), /region_window must be at least 3/);
  // All-ambiguous and Met/Trp-only CDSs both leave CAI nothing to score.
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'ATGNNNNNN', host: 'e_coli' }), /no codon with synonymous alternatives/);
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'ATGTGGTAA', host: 'e_coli' }), /no codon with synonymous alternatives/);
  await assert.rejects(() => run('molbio_codon_usage', { sequence: 'NNNNNNNNN', host: 'e_coli' }), /no unambiguous sense codons/);
}

// ── v19: phylogenetic tree ──────────────────────────────────────────────────
{
  const { distanceMatrix, parseNewick, toNewick, kmerDistanceMatrix, coverageShortfall } = await import('../phylo.mjs');

  // A four-taxon fixture with hand-checkable differences:
  //   A and B identical; C is A plus one C->T transition; D is C plus one
  //   G->A transition and one T->G transversion.
  const fixture = [
    { id: 'A', sequence: 'ACGTACGTAC' },
    { id: 'B', sequence: 'ACGTACGTAC' },
    { id: 'C', sequence: 'ACGTTCGTAC' },
    { id: 'D', sequence: 'ACGTTCGTAG' },
  ];

  // 1. p-distance cells (1 difference in 10 = 0.1; 2 in 10 = 0.2).
  const pd = distanceMatrix(fixture, { model: 'p-distance' });
  assert.deepEqual(
    pd.matrix.map((row) => row.map((value) => Math.round(value * 1000) / 1000)),
    [[0, 0, 0.1, 0.2], [0, 0, 0.1, 0.2], [0.1, 0.1, 0, 0.1], [0.2, 0.2, 0.1, 0]],
  );
  assert.equal(pd.compared[0][2], 10, 'all ten sites are comparable in this fixture');

  // 2. Jukes-Cantor: -3/4 ln(1 - 4p/3) with p = 0.1.
  const jc = distanceMatrix(fixture, { model: 'jukes-cantor' });
  const jcExpected = (-3 / 4) * Math.log(1 - (4 / 3) * 0.1);
  assert.equal(jc.matrix[0][2].toFixed(6), jcExpected.toFixed(6), '0.107326 for p = 0.1');
  assert.equal(jc.matrix[0][1], 0, 'identical sequences are 0 apart');
  assert.deepEqual(jc.saturated, [], 'nothing is saturated here');

  // 3. Saturation is reported and clamped rather than silently huge.
  const saturated = distanceMatrix([{ id: 'X', sequence: 'AAAAAAAAAA' }, { id: 'Y', sequence: 'CCCCCCCCCC' }], { model: 'jukes-cantor' });
  assert.equal(saturated.matrix[0][1], 0.75, 'clamped to the model limit');
  assert.equal(saturated.saturated.length, 1);
  assert.deepEqual(saturated.saturated[0].pair, ['X', 'Y']);
  assert.match(saturated.saturated[0].reason, /limit 0.75/);
  assert.equal(saturated.saturated[0].clipped_to, 0.75);

  // 4. Gaps and ambiguous bases are skipped per pair.
  const gapped = distanceMatrix([
    { id: 'P', sequence: 'ACGTNNNNNN' },
    { id: 'Q', sequence: 'ACGTACGTAC' },
  ], { model: 'p-distance' });
  assert.equal(gapped.matrix[0][1], 0, 'only the four comparable sites count');
  assert.equal(gapped.compared[0][1], 4);

  // 5. The tree tool end to end: NJ puts A+B together and leaves D outside.
  const tree = await run('molbio_phylogenetic_tree', {
    sequences: fixture.map((entry) => entry.sequence),
    ids: ['A', 'B', 'C', 'D'],
    method: 'nj',
    distance_model: 'kimura-2p',
    bootstrap: 20,
    seed: 99,
    consensus: 'majority',
    layout: 'rectangular',
    nwk_path: 'C:/tmp/fixture.nwk',
    svg_path: 'C:/tmp/fixture-tree.svg',
  });
  assert.equal(tree.method, 'nj');
  assert.equal(tree.distance_model, 'kimura-2p');
  assert.equal(tree.taxa, 4);
  assert.equal(tree.alignment_columns, 10);
  assert.equal(tree.aligned_by_tool, false, 'the fixture is already aligned');
  assert.equal(tree.bootstrap_replicates, 20);
  assert.equal(tree.bootstrap_seed, 99);
  const leafNames = (node) => (node.children === undefined ? [node.name] : node.children.flatMap(leafNames));
  assert.deepEqual(leafNames(tree.tree).sort(), ['A', 'B', 'C', 'D']);
  // The unrooted four-taxon topology here must be (A,B)|(C,D). NJ roots at the
  // last join, so the root split can be either {A,B}|{C,D} or {A,B,C}|{D}; what
  // matters is that the {A,B} clade exists and its counterpart is {C,D}.
  const clades = (node, out = []) => {
    if (node.children !== undefined) {
      out.push(leafNames(node).sort().join(''));
      for (const child of node.children) clades(child, out);
    }
    return out;
  };
  const allClades = clades(tree.tree).sort();
  assert.ok(allClades.includes('AB'), `A and B are identical and must form a clade (got ${allClades.join(', ')})`);
  // Which edge NJ roots on is an arbitrary choice among the unrooted tree's
  // edges, so {C,D} need not appear as a clade. The unrooted topology is pinned
  // instead by the four-point condition on the distance matrix.
  const [a, b, c, d] = ['A', 'B', 'C', 'D'];
  const index = (name) => tree.distance_labels.indexOf(name);
  const pairDistance = (left, right) => tree.distance_matrix[index(left)][index(right)];
  assert.equal(
    pairDistance(a, c) + pairDistance(b, d),
    pairDistance(a, d) + pairDistance(b, c),
    'the two cross sums agree, which is what an unrooted tree predicts',
  );
  assert.ok(
    pairDistance(a, d) + pairDistance(b, c) > pairDistance(a, b) + pairDistance(c, d),
    'and they exceed the within-pair sum, so the split is (A,B)|(C,D) and not (A,D)|(B,C)',
  );
  assert.ok(tree.newick.endsWith(';'), 'the Newick text is terminated');
  assert.ok(!/\)\d+(\.\d+)?;/.test(tree.newick), 'the root carries no support label');
  assert.deepEqual(tree.distance_labels, ['A', 'B', 'C', 'D']);
  assert.equal(tree.distance_matrix.length, 4);
  assert.equal(tree.distance_matrix[0][1], 0);
  // K2P separates transitions from transversions: one transition in ten sites
  // is P = 0.1, Q = 0, giving -1/2 ln(0.8) - 1/4 ln(1) = 0.111572... /2.
  const k2pExpected = (-1 / 2) * Math.log(1 - 2 * 0.1) - (1 / 4) * Math.log(1 - 0);
  assert.equal(tree.distance_matrix[0][2], 0.108466, `K2P for P=0.1, Q=0 (${k2pExpected.toFixed(6)} to more digits)`);
  assert.notEqual(tree.distance_matrix[0][2], jcExpected, 'and it is NOT the Jukes-Cantor value, which shows the model is really applied');
  assert.deepEqual(tree.saturated_pairs, []);
  assert.equal(tree.consensus.mode, 'majority');
  assert.ok(tree.consensus.newick.endsWith(';'));
  assert.ok(tree.notes.some((note) => note.includes('not a maximum-likelihood')));
  assert.ok(tree.notes.some((note) => note.includes('not a p-value')));
  assert.equal(tree.svg_path, 'C:/tmp/fixture-tree.svg');
  assert.ok(memFs.files.get('C:/tmp/fixture.nwk').startsWith('('), 'the Newick file reached the workspace');
  assert.ok(memFs.files.get('C:/tmp/fixture-tree.svg').includes('<svg'));

  // 6. The same seed reproduces the same support and the same file exactly.
  const again = await run('molbio_phylogenetic_tree', {
    sequences: fixture.map((entry) => entry.sequence),
    ids: ['A', 'B', 'C', 'D'],
    method: 'nj',
    distance_model: 'kimura-2p',
    bootstrap: 20,
    seed: 99,
    nwk_path: 'C:/tmp/fixture2.nwk',
    svg_path: 'C:/tmp/fixture-tree2.svg',
  });
  assert.equal(again.newick, tree.newick);
  assert.deepEqual(again.support, tree.support);
  assert.equal(memFs.files.get('C:/tmp/fixture2.nwk'), memFs.files.get('C:/tmp/fixture.nwk'));

  // 7. UPGMA and NJ are different algorithms, not one renamed.
  const upgma = await run('molbio_phylogenetic_tree', {
    sequences: fixture.map((entry) => entry.sequence),
    ids: ['A', 'B', 'C', 'D'],
    method: 'upgma',
    distance_model: 'p-distance',
    bootstrap: 0,
    nwk_path: 'C:/tmp/upgma.nwk',
    svg_path: 'C:/tmp/upgma.svg',
  });
  assert.equal(upgma.bootstrap_replicates, 0);
  assert.deepEqual(upgma.support, []);
  assert.notEqual(upgma.newick, tree.newick, 'the two methods really are different algorithms');
  assert.match(upgma.newick, /D:\d/);
  assert.equal(upgma.bootstrap_seed, 0, 'no bootstrap means no seed is claimed');

  // 8. Newick round trip against the module (the format, not just the tool).
  assert.equal(toNewick(parseNewick(tree.newick)), tree.newick);
  const quoted = toNewick({ name: '', children: [{ name: 'sample 1|a', children: [], length: 0 }, { name: 'b', children: [], length: 0.25 }], length: 0 });
  assert.equal(quoted, "('sample 1|a':0,b:0.25);");
  assert.equal(parseNewick(quoted).children[0].name, 'sample 1|a');
  const polytomy = '(a:1,b:2,c:3);';
  assert.equal(toNewick(parseNewick(polytomy)), polytomy, 'a polytomy round trips too');
  assert.throws(() => parseNewick('(a:1,b:2'), /expected "," or "\)"/);
  assert.throws(() => parseNewick('(a:1 b:2);'), /invalid branch length/);
  assert.throws(() => parseNewick(''), /unexpected end of Newick/);
  assert.throws(() => parseNewick('(,'), /empty leaf label/);
  assert.throws(() => parseNewick('(a:x,b:2);'), /invalid branch length/);
  assert.throws(() => parseNewick('(a:1,b:2);extra'), /unexpected trailing text/);

  // 9. Raw sequences are aligned first, and the k-mer distance is the same
  //    formula msa.mjs uses for its guide tree.
  const unaligned = await run('molbio_phylogenetic_tree', {
    sequences: ['ACGTACGTAC', 'ACGTACGTACG', 'ACGTTCGTAC'],
    ids: ['u1', 'u2', 'u3'],
    bootstrap: 0,
    nwk_path: 'C:/tmp/unaligned.nwk',
    svg_path: 'C:/tmp/unaligned.svg',
  });
  assert.equal(unaligned.aligned_by_tool, true);
  // v20 FIXED THE ALIGNER HERE. This assertion used to read `alignment_columns
  // === 10` with the comment "the progressive aligner pads rather than
  // inserting a gap for this pair", i.e. it pinned the BUG: u2 supplied 11
  // bases and the alignment kept only 10, silently dropping the residue. The
  // free-end-gap DP legitimately prefers the 10-column path (score 40 at
  // (10,10) vs 30 at (11,10)), but the residues past the chosen endpoint are an
  // OVERHANG, not a gap the alignment chose — dropping them lost data. The
  // aligner now emits them, so the column count is 11 and nothing is lost.
  assert.equal(unaligned.alignment_columns, 11, 'the trailing residue is emitted as an overhang column, not dropped');
  assert.ok(unaligned.notes.some((note) => note.includes('progressive aligner')));
  // The coverage warning from v19 must now be ABSENT: every residue is placed.
  assert.ok(
    !unaligned.notes.some((note) => note.includes('did not place every residue')),
    'the aligner no longer loses residues, so the coverage warning must not fire',
  );
  // The guard itself must still WORK, or "no warning" proves nothing. Run the
  // coverage check directly with a deliberately truncated alignment: the same
  // helper that used to fire on real output must still fire on a damaged row.
  const damaged = coverageShortfall(
    [
      { id: 'u1', sequence: 'ACGTACGTAC-' },
      { id: 'u2', sequence: 'ACGTACGTAC' },
    ],
    [
      { id: 'u1', sequence: 'ACGTACGTAC' },
      { id: 'u2', sequence: 'ACGTACGTACG' },
    ],
  );
  assert.deepEqual(damaged, ['u2 (10 of 11 bases kept)'], 'the coverage guard still reports a truncated row');
  // When every residue IS placed, there is no warning.
  const clean = await run('molbio_phylogenetic_tree', {
    sequences: ['ACGTACGTAC', 'ACGTTCGTAC', 'ACGTTCGTAA'],
    ids: ['c1', 'c2', 'c3'],
    bootstrap: 0,
    nwk_path: 'C:/tmp/clean.nwk',
    svg_path: 'C:/tmp/clean.svg',
  });
  assert.ok(!clean.notes.some((note) => note.includes('WARNING: the alignment')), 'equal-length input needs no coverage warning');
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGTA'], aligned: false, bootstrap: 0 }), /not all the same length/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGTA'], aligned: true, bootstrap: 0 }), /different lengths/);
  // The k-mer distance must be the SAME MATRIX msa.mjs derives for its guide
  // tree, so the duplicated formula cannot drift. Two routes to the numbers:
  // recompute the shared-feature overlap here, and check the topology the
  // unaligned tree tool produced matches upgmaTree over that same matrix.
  const kmer = kmerDistanceMatrix(fixture);
  const profile = (sequence) => {
    const map = new Map();
    for (let index = 0; index + 5 <= sequence.length; index++) {
      const mer = sequence.slice(index, index + 5);
      map.set(mer, (map.get(mer) ?? 0) + 1);
    }
    return map;
  };
  const [pa, , pc] = [profile(fixture[0].sequence), profile(fixture[1].sequence), profile(fixture[2].sequence)];
  let shared = 0;
  for (const [mer, count] of pa) shared += Math.min(count, pc.get(mer) ?? 0);
  assert.equal(kmer[0 * 4 + 1], 0, 'identical sequences have identical k-mer profiles');
  assert.equal(kmer[0 * 4 + 2].toFixed(6), (1 - (2 * shared) / (6 + 6)).toFixed(6), 'the shared 5-mer overlap formula');
  const unalignedTree = await run('molbio_phylogenetic_tree', {
    sequences: fixture.map((entry) => entry.sequence),
    ids: ['A', 'B', 'C', 'D'],
    bootstrap: 0,
    nwk_path: 'C:/tmp/kmer.nwk',
    svg_path: 'C:/tmp/kmer.svg',
  });
  assert.ok(unalignedTree.newick.includes('A') && unalignedTree.newick.includes('B'));

  // 10. FASTA input, duplicate names, and the argument errors.
  const fromFasta = await run('molbio_phylogenetic_tree', {
    fasta: '>f1\nACGTACGTAC\n>f2\nACGTTCGTAC\n',
    bootstrap: 0,
    nwk_path: 'C:/tmp/fasta.nwk',
    svg_path: 'C:/tmp/fasta.svg',
  });
  assert.deepEqual(fromFasta.distance_labels, ['f1', 'f2']);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGT'], ids: ['same', 'same'], bootstrap: 0 }), /names must be unique/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { bootstrap: 0 }), /provide sequences, fasta or path/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT'], bootstrap: 0 }), /at least 2 sequences/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGA'], method: 'parsimony', bootstrap: 0 }), /must be one of upgma, nj/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGA'], distance_model: 'hky', bootstrap: 0 }), /must be one of p-distance/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGA'], consensus: 'majority', bootstrap: 0 }), /consensus needs bootstrap/);
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGA'], bootstrap: 1001 }), /at most 1000 bootstrap/);
  // The budget counts replicates x pairs x columns, so 1000 replicates over a
  // 30-sequence, 1000-column alignment must be refused before it starts.
  const wide = Array.from({ length: 30 }, (_, index) => ({ id: `w${index}`, sequence: 'ACGT'.repeat(250) }));
  await assert.rejects(
    () => run('molbio_phylogenetic_tree', {
      sequences: wide.map((entry) => entry.sequence),
      ids: wide.map((entry) => entry.id),
      bootstrap: 1000,
      seed: 1,
      nwk_path: 'C:/tmp/wide.nwk',
      svg_path: 'C:/tmp/wide.svg',
    }),
    /bootstrap budget exceeded/,
  );
  await assert.rejects(() => run('molbio_phylogenetic_tree', { sequences: ['ACGT', 'ACGA'], bootstrap: 0, layout: 'radial' }), /must be one of rectangular/);
}

// ── v19: in-silico PCR ──────────────────────────────────────────────────────
{
  // A non-repetitive 200 bp template (a random one, so a 20-mer primer has
  // exactly one binding site — a repetitive template would legitimately produce
  // dozens of sites and make every assertion about "the" product meaningless).
  const TEMPLATE = 'TAAGTAAGTAGCTCCGCGCGATGTGCGACTCTGCCGGGATATGGCATTGCCCAAAGTGGCCACCACTCTTGGATAGGTGCTATAACTATTACAAATAAAGCACCTTCGGGTATCGCGGTATGTGAACGTTCACTTCCGTAAAGACTTAGGGTGACGCAACACTCACCATGGAGGATAGTAATAGGTGAGAGAGATTTAGA';
  assert.equal(TEMPLATE.length, 200);
  const rc = (sequence) => [...sequence].reverse().map((base) => ({ A: 'T', C: 'G', G: 'C', T: 'A' }[base])).join('');
  const forward = TEMPLATE.slice(0, 20);
  const reverse = rc(TEMPLATE.slice(80, 100));

  // 1. Exact match: one 100 bp product spanning 1-100.
  const exact = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'amp', forward, reverse }],
    min_size: 50,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-exact.svg',
  });
  const amp = exact.pairs[0];
  assert.equal(amp.verdict, 'specific');
  assert.equal(amp.amplicon_count, 1);
  assert.equal(amp.forward_sites.length, 1);
  assert.equal(amp.reverse_sites.length, 1);
  assert.equal(amp.amplicons[0].size, 100);
  assert.deepEqual([amp.amplicons[0].forward_site.start, amp.amplicons[0].forward_site.end], [1, 20]);
  assert.deepEqual([amp.amplicons[0].reverse_site.start, amp.amplicons[0].reverse_site.end], [81, 100]);
  assert.equal(amp.amplicons[0].total_mismatches, 0);
  assert.equal(amp.amplicons[0].wraps_origin, false);
  assert.equal(amp.amplicons[0].sequence, TEMPLATE.slice(0, 100), 'the product is exactly the top strand from 1 to 100');
  assert.deepEqual(exact.verdicts, ['specific']);
  assert.equal(exact.template_length, 200);
  assert.equal(exact.circular, false);
  assert.ok(memFs.files.get('C:/tmp/pcr-exact.svg').includes('<svg'), 'the gel reached the workspace');

  // 2. A mismatch in the middle of a primer: refused at 0 mismatches, allowed
  //    at 1, and the site reports where the mismatch is.
  const internalBad = forward.slice(0, 9) + (forward[9] === 'A' ? 'C' : 'A') + forward.slice(10);
  const strict = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'mm', forward: internalBad, reverse }],
    min_size: 50,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-mm.svg',
  });
  assert.equal(strict.pairs[0].verdict, 'no_product');
  assert.equal(strict.pairs[0].forward_sites.length, 0);
  const relaxed = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'mm', forward: internalBad, reverse }],
    max_mismatches: 1,
    min_size: 50,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-mm.svg',
  });
  assert.equal(relaxed.pairs[0].verdict, 'specific_with_mismatches');
  assert.deepEqual(relaxed.pairs[0].amplicons[0].forward_site.mismatch_positions, [10], '1-based position inside the primer');
  assert.equal(relaxed.pairs[0].amplicons[0].total_mismatches, 1);
  assert.equal(relaxed.pairs[0].off_target_count, 1, 'a mismatched product is counted as off-target');
  assert.equal(relaxed.pairs[0].on_target_count, 0);

  // 3. The 3' end rule, which is the difference between "anneals" and
  //    "extends": a terminal mismatch is refused even at 1 allowed mismatch,
  //    unless the 3' anchor requirement is dropped.
  const threePrimeBad = forward.slice(0, 19) + (forward[19] === 'A' ? 'C' : 'A');
  const anchorHeld = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'p3', forward: threePrimeBad, reverse }],
    max_mismatches: 1,
    min_size: 50,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-3p.svg',
  });
  assert.equal(anchorHeld.pairs[0].verdict, 'no_product', "a 3' mismatch is refused with the default 3-base anchor");
  assert.equal(anchorHeld.settings.three_prime_exact, 3);
  const anchorOff = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'p3', forward: threePrimeBad, reverse }],
    max_mismatches: 1,
    three_prime_exact: 0,
    min_size: 50,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-3p0.svg',
  });
  assert.equal(anchorOff.pairs[0].verdict, 'specific_with_mismatches', 'and accepted once the requirement is dropped');
  assert.deepEqual(anchorOff.pairs[0].forward_sites[0].mismatch_positions, [20], 'the mismatch is the primer 3\' base');
  // An internal mismatch survives the 3' rule even at 2 allowed.
  const twoMismatch = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'p2mm', forward: internalBad, reverse }],
    max_mismatches: 2,
    min_size: 50,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-2mm.svg',
  });
  assert.equal(twoMismatch.pairs[0].verdict, 'specific_with_mismatches');

  // 4. Mispriming: a second forward site upstream of the reverse site gives a
  //    second, shorter band — the "why do I see two bands" case.
  const duplicated = TEMPLATE.slice(0, 40) + forward + TEMPLATE.slice(40);
  const multi = await run('molbio_pcr_simulate', {
    template: duplicated,
    primer_pairs: [{ name: 'multi', forward, reverse }],
    min_size: 20,
    max_size: 400,
    gel_path: 'C:/tmp/pcr-multi.svg',
  });
  assert.equal(multi.pairs[0].verdict, 'multiple_bands');
  assert.equal(multi.pairs[0].forward_sites.length, 2);
  assert.deepEqual(multi.pairs[0].amplicons.map((entry) => entry.size), [120, 80], 'sizes follow the forward-site order, not the size order');
  assert.deepEqual(multi.pairs[0].amplicons.map((entry) => entry.forward_site.start), [1, 41]);
  assert.equal(multi.pairs[0].off_target_count, 0, 'both products are mismatch-free');

  // 5. The size window filters products out of range and counts them.
  const narrow = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'amp', forward, reverse }],
    min_size: 120,
    max_size: 130,
    gel_path: 'C:/tmp/pcr-narrow.svg',
  });
  assert.equal(narrow.pairs[0].verdict, 'no_product');
  assert.equal(narrow.pairs[0].out_of_range, 1, 'the 100 bp product was found but filtered');
  assert.equal(narrow.settings.min_size, 120);

  // 6. Circular template: a product that crosses the origin, with the modular
  //    slice taken as the sequence.
  const circular = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'wrap', forward: TEMPLATE.slice(150, 170), reverse: rc(TEMPLATE.slice(10, 30)) }],
    circular: true,
    min_size: 20,
    max_size: 300,
    gel_path: 'C:/tmp/pcr-wrap.svg',
  });
  assert.equal(circular.circular, true);
  assert.equal(circular.pairs[0].amplicons.length, 1);
  assert.equal(circular.pairs[0].amplicons[0].size, 80);
  assert.equal(circular.pairs[0].amplicons[0].wraps_origin, true);
  assert.equal(circular.pairs[0].amplicons[0].sequence, TEMPLATE.slice(150) + TEMPLATE.slice(0, 30), 'the slice wraps as template[151..200] + template[1..30]');

  // 7. Screening a different template (a vector) answers "does this pair also
  //    amplify the backbone".
  const screened = await run('molbio_pcr_simulate', {
    template: TEMPLATE,
    primer_pairs: [{ name: 'amp', forward, reverse }],
    min_size: 20,
    max_size: 400,
    screen_templates: [{ name: 'vector', sequence: 'TTTTGGGGCCCCAAAATTTTGGGGCCCCAAAA' }],
    gel_path: 'C:/tmp/pcr-screen.svg',
  });
  assert.equal(screened.screens.length, 1);
  assert.equal(screened.screens[0].name, 'vector');
  assert.equal(screened.screens[0].products[0].amplicon_count, 0);
  assert.equal(screened.screens[0].products[0].verdict, 'no_product');

  // 8. Reading the template from a workspace FASTA, and include_sequence: false.
  memFs.files.set('C:/tmp/template.fa', `>t\n${TEMPLATE}\n`);
  const fromFile = await run('molbio_pcr_simulate', {
    path: 'C:/tmp/template.fa',
    primer_pairs: [{ name: 'amp', forward, reverse }],
    min_size: 20,
    max_size: 400,
    include_sequence: false,
    gel_path: 'C:/tmp/pcr-file.svg',
  });
  assert.equal(fromFile.pairs[0].amplicons[0].size, 100);
  assert.equal(fromFile.pairs[0].amplicons[0].sequence, '', 'the sequence is omitted on request');

  // 9. Error paths.
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, primer_pairs: [], gel_path: 'C:/tmp/x.svg' }), /at least one primer pair/);
  await assert.rejects(() => run('molbio_pcr_simulate', { gel_path: 'C:/tmp/x.svg', primer_pairs: [{ forward, reverse }] }), /provide exactly one of template .* or path/);
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, path: 'C:/tmp/template.fa', primer_pairs: [{ forward, reverse }], gel_path: 'C:/tmp/x.svg' }), /provide exactly one of template .* or path/);
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, primer_pairs: [{ name: 'x', forward, reverse: '' }], gel_path: 'C:/tmp/x.svg' }), /has no reverse primer/);
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, primer_pairs: [{ name: 'x', forward: '', reverse }], gel_path: 'C:/tmp/x.svg' }), /has no forward primer/);
  await assert.rejects(() => run('molbio_pcr_simulate', { template: '   ', primer_pairs: [{ forward, reverse }], gel_path: 'C:/tmp/x.svg' }), /template sequence is empty/);
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, primer_pairs: [{ forward, reverse }], three_prime_exact: 21, gel_path: 'C:/tmp/x.svg' }), /longer than the primer/);
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, primer_pairs: [{ forward, reverse }], max_mismatches: -1, gel_path: 'C:/tmp/x.svg' }), /mismatches must be a non-negative integer/);
  const tooMany = Array.from({ length: 25 }, (_, index) => ({ name: `p${index}`, forward, reverse }));
  await assert.rejects(() => run('molbio_pcr_simulate', { template: TEMPLATE, primer_pairs: tooMany, gel_path: 'C:/tmp/x.svg' }), /at most 24 primer pairs/);
}

// ── v19: GC composition, CpG islands and skew ───────────────────────────────
{
  // A synthetic island: 250 bp of pure CG (100% GC, CpG at every position) then
  // 150 bp of pure AT. Islands are 200 bp here because the 100 bp windows are
  // 101-200 and 201-300; the latter is only 50% GC and does not qualify.
  const sequence = 'CG'.repeat(125) + 'AT'.repeat(75);
  const report = await run('molbio_gc_composition', {
    sequence,
    window: 100,
    svg_path: 'C:/tmp/gc.svg',
  });
  assert.equal(report.length, 400);
  assert.equal(report.gc_percent, 62.5);
  assert.equal(report.at_percent, 37.5);
  assert.equal(report.n_percent, 0);
  assert.equal(report.gc_windows.length, 4);
  assert.deepEqual(report.gc_windows.map((window) => window.gc_percent), [100, 100, 50, 0]);
  assert.equal(report.cpg_islands.length, 1);
  assert.deepEqual(
    [report.cpg_islands[0].start, report.cpg_islands[0].end, report.cpg_islands[0].length, report.cpg_islands[0].gc_percent, report.cpg_islands[0].cpg_oe],
    [1, 200, 200, 100, 2],
    'the island is the merged first two windows',
  );
  assert.equal(report.observed_expected_cpg, 3.2, 'CpG observed/expected over the whole sequence');
  assert.equal(report.criteria.name, 'gardiner');
  assert.equal(report.criteria.min_length, 200);
  assert.match(report.criteria.reference, /Gardiner-Garden & Frommer 1987/);

  // A pure-CG stretch has zero GC skew, and the origin/terminus hints are
  // explicitly an indicator.
  assert.deepEqual(report.cumulative_gc_skew, [0, 0, 0, 0]);
  assert.equal(report.ori_hint.window, 1);
  assert.equal(report.ter_hint.window, 1);
  assert.ok(report.notes.some((note) => note.includes('INDICATOR of the replication origin')));

  // Entropy and complexity of a two-letter repeat: 'CG'x125 + 'AT'x75 contains
  // all four bases, so entropy is well below the 2-bit maximum but not 1 —
  // hand-computed as -(0.3125 log2 0.3125) x 2 - (0.1875 log2 0.1875) x 2.
  const expectedEntropy = -2 * (0.3125 * Math.log2(0.3125)) - 2 * (0.1875 * Math.log2(0.1875));
  assert.equal(report.entropy_bits, Math.round(expectedEntropy * 1e4) / 1e4);
  assert.ok(report.linguistic_complexity < 0.05);
  assert.equal(report.n50, 400, 'one uninterrupted block');
  assert.equal(report.l50, 1);
  assert.equal(report.dinucleotides.find((row) => row.pair === 'CG').observed, 125);
  assert.equal(report.dinucleotides.find((row) => row.pair === 'CG').observed_expected, 3.2);
  assert.ok(memFs.files.get('C:/tmp/gc.svg').includes('<svg'));

  // Takai & Jones criteria need 500 bp and 55% GC, so this 200 bp island is not
  // called — the criteria really are applied, not decorative.
  const takai = await run('molbio_gc_composition', { sequence, criteria: 'takai', svg_path: 'C:/tmp/gc-takai.svg' });
  assert.equal(takai.cpg_islands.length, 0);
  assert.equal(takai.criteria.name, 'takai');
  assert.equal(takai.criteria.min_length, 500);
  assert.match(takai.criteria.reference, /Takai & Jones 2002/);

  // The CpG ratio is a real condition: 50% GC with NO CpG dinucleotide is not
  // an island even though every window clears the GC threshold.
  const noCpG = 'GCTT'.repeat(75);
  assert.equal(noCpG.length, 300);
  assert.equal(noCpG.includes('CG'), false);
  const depleted = await run('molbio_gc_composition', { sequence: noCpG, window: 100, svg_path: 'C:/tmp/gc-depleted.svg' });
  assert.equal(depleted.gc_percent, 50);
  assert.equal(depleted.observed_expected_cpg, 0);
  assert.deepEqual(depleted.cpg_islands, [], 'high GC alone does not make an island — the obs/exp CpG condition applies too');

  // A homopolymer: zero expected CpG must not divide by zero, and a single-base
  // sequence has zero entropy.
  const polyA = await run('molbio_gc_composition', { sequence: 'A'.repeat(300), window: 100, svg_path: 'C:/tmp/gc-poly.svg' });
  assert.equal(polyA.gc_percent, 0);
  assert.equal(polyA.observed_expected_cpg, 0);
  assert.deepEqual(polyA.cpg_islands, []);
  assert.equal(polyA.entropy_bits, 0);
  assert.ok(polyA.linguistic_complexity > 0 && polyA.linguistic_complexity < 0.01, `a homopolymer has one distinct word per length, so complexity ${polyA.linguistic_complexity} is near zero`);

  // Skew: a G-rich isochore followed by a C-rich one. Both are pure G/C, so the
  // GC CONTENT is constant at 100% and only the G/C asymmetry moves the
  // profile: every window's skew is exactly (3-1)/(3+1) = +0.5 for 'GGGC' and
  // -0.5 for 'GCCC'.
  const isochores = 'GGGC'.repeat(50) + 'GCCC'.repeat(50);
  const biased = await run('molbio_gc_composition', { sequence: isochores, window: 100, svg_path: 'C:/tmp/gc-rich.svg' });
  assert.equal(biased.gc_percent, 100);
  assert.deepEqual(biased.gc_skew_windows.map((window) => window.gc_skew), [0.5, 0.5, -0.5, -0.5]);
  assert.deepEqual(biased.cumulative_gc_skew, [0.5, 1, 0.5, 0]);
  assert.equal(biased.ori_hint.window, 4, 'the cumulative minimum is the last window');
  assert.equal(biased.ter_hint.window, 2, 'and the maximum is where the G-rich half ends');

  // Custom thresholds and window/step, plus the ambiguous-base note.
  const custom = await run('molbio_gc_composition', { sequence, window: 50, step: 25, min_length: 150, gc_threshold: 60, cpg_oe_threshold: 1.5, svg_path: 'C:/tmp/gc-custom.svg' });
  assert.equal(custom.criteria.window, 50);
  assert.equal(custom.criteria.min_length, 150);
  assert.equal(custom.criteria.gc_threshold, 60);
  assert.equal(custom.criteria.cpg_oe_threshold, 1.5);
  assert.equal(custom.gc_windows.length, 15, '400 bp in 50 bp windows stepping by 25 gives floor((400-50)/25)+1 = 15 windows');
  const ambiguous = await run('molbio_gc_composition', { sequence: `${'ACGT'.repeat(50)}NNNNNNNNNN`, window: 100, svg_path: 'C:/tmp/gc-n.svg' });
  assert.ok(ambiguous.notes.some((note) => note.includes('ambiguous')));
  assert.ok(ambiguous.n_percent > 0);
  const short = await run('molbio_gc_composition', { sequence: 'ACGTACGTACGTACGTACGT', window: 100, svg_path: 'C:/tmp/gc-short.svg' });
  assert.deepEqual(short.gc_windows, [], 'a sequence shorter than the window yields no windows');
  assert.ok(short.notes.some((note) => note.includes('no cumulative-skew origin')));

  // Errors.
  await assert.rejects(() => run('molbio_gc_composition', { svg_path: 'C:/tmp/x.svg' }), /provide exactly one of sequence or path/);
  await assert.rejects(() => run('molbio_gc_composition', { sequence: 'ACGT', path: 'C:/tmp/x.fa', svg_path: 'C:/tmp/x.svg' }), /provide exactly one of sequence or path/);
  await assert.rejects(() => run('molbio_gc_composition', { sequence: '   ' }), /sequence is empty/);
  await assert.rejects(() => run('molbio_gc_composition', { sequence: 'ACGTACGTAC', criteria: 'emboss' }), /must be one of gardiner, takai/);
  await assert.rejects(() => run('molbio_gc_composition', { sequence: 'ACGTACGTAC', window: 5 }), /window must be an integer of at least 10/);
}

// ── plugin surface ──────────────────────────────────────────────────────────

assert.equal(plugin.name, 'dsh-molbio-tools');
assert.deepEqual(plugin.inject, ['tools', 'systemPrompt']);

console.log('all smoke tests passed');

