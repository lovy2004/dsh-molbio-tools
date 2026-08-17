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
    ['molbio_align', { sequence1: 'ATGCATGCAT', sequence2: 'ATGCGTGCAT' }],
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
  // cross-intron primer design
  const e1 = makeTemplate(120, 17);
  const e2 = makeTemplate(120, 19);
  const e3 = makeTemplate(120, 23);
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
    require_gc_clamp: false, max_run: 4,
    max_self_score: 200, max_self_consecutive: 200, max_hairpin_score: 200,
    max_dimer_score: 200, max_tm_delta: 200,
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
  // AND on the genomic sequence.
  const e1 = makeTemplate(110, 17) + 'T'.repeat(10);
  const e2 = makeTemplate(120, 19);
  const e3 = makeTemplate(120, 23);
  const genomic = e1 + makeTemplate(800, 29) + e2 + makeTemplate(800, 31) + e3;
  const exons = [{ start: 1, end: 120 }, { start: 921, end: 1040 }, { start: 1841, end: 1960 }];
  const spliced = e1 + e2 + e3;
  const out = await run('molbio_design_intron_primers', {
    genomic,
    exons,
    tm_min: 50, tm_max: 70, min_genomic_span: 900,
    max_mismatches: 3, max_3prime_mismatches: 1,
    max_results: 10,
  });
  assert.ok(out.pairs.length > 0);
  const mismatched = out.pairs.find((p) => p.forward.mismatch_count > 0 || p.reverse.mismatch_count > 0);
  assert.ok(mismatched !== undefined, 'the crafted exon junction must yield a mismatched candidate');
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

// ── plugin surface ──────────────────────────────────────────────────────────

assert.equal(plugin.name, 'dsh-molbio-tools');
assert.deepEqual(plugin.inject, ['tools', 'systemPrompt']);

console.log('all smoke tests passed');
