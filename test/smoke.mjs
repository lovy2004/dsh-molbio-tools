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

const require = createRequire(import.meta.url);

// Import the REAL harness validators from the installed DSH (its own deps
// resolve beside it). Test-only import — the shipped plugin never does this.
const dshTools = await import('file:///C:/Users/18771/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
const { assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools;

const plugin = await import('../index.mjs');
const lib = await import('../lib.mjs');
const view = await import('../view.mjs');

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

const mockCtx = {
  systemPrompt: { section(_opts) {} },
  get(name) {
    if (name === 'fs') return memFs;
    if (name === 'web') return mockWeb;
    return undefined; // sandboxPolicy absent → unconditional writes, like a bare fs backend
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

// ── plugin surface ──────────────────────────────────────────────────────────

assert.equal(plugin.name, 'dsh-molbio-tools');
assert.deepEqual(plugin.inject, ['tools', 'systemPrompt']);

console.log('all smoke tests passed');
