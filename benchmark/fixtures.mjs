/**
 * dsh-molbio-tools/benchmark/fixtures.mjs
 *
 * Synthetic DNA for the tasks whose tools need a template, a vector, a clone or
 * an assembly — plus the workspace files those tools read from disk.
 *
 * Everything here is DERIVED (a deterministic PRNG seeds a repeat, then
 * recognition sites are spliced in at chosen offsets) rather than typed out:
 * a hand-written 1200 bp vector is a typo waiting to make an assertion wrong in
 * a way that looks like a model failure.
 *
 * ── The dependency direction is one-way ─────────────────────────────────────
 *
 * `sequences.mjs` owns the PRNG (`makeTemplate`); this module imports it and
 * builds the fixtures. `sequences.mjs` then re-exports `FIXTURES` so consumers
 * have a single import for "the DNA this benchmark uses". The reverse direction
 * — this module importing the canonical values — would be a cycle.
 */

import { makeTemplate } from './sequences.mjs';

/** Splice `insert` into `sequence` at 0-based `offset`, replacing `replace` bases. */
function spliceAt(sequence, offset, insert, replace = 0) {
  return `${sequence.slice(0, offset)}${insert}${sequence.slice(offset + replace)}`;
}

/** Reverse complement over unambiguous DNA. */
function reverseComplement(sequence) {
  const pairs = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...sequence].reverse().map((base) => pairs[base]).join('');
}

/**
 * Pick a backbone seed that carries no BsaI site.
 *
 * Both `GGTCTC` and its reverse complement `GAGACC` occur in random DNA often
 * enough to matter — a 900 bp pseudo-random sequence contains one roughly a
 * third of the time, which is exactly what happened on the first attempt
 * (`GAGACC` at bp 540, a site nothing had checked for). Rather than pin a lucky
 * seed by hand, search for a clean one and FAIL if none is found: the Golden
 * Gate task's premise is a destination vector the enzyme does not cut, so a
 * silent site would turn a correct model answer into a failure.
 */
function bsaIFreeBackbone(makeTemplate, length, seed) {
  for (let candidate = seed; candidate < seed + 200; candidate += 1) {
    const sequence = makeTemplate(length, candidate);
    if (!sequence.includes('GGTCTC') && !sequence.includes('GAGACC')) return { sequence, seed: candidate };
  }
  throw new Error(`benchmark: no BsaI-free ${length} bp backbone found in 200 seeds from ${seed}`);
}

/**
 * Build every fixture from the shared PRNG.
 *
 * @param {(length: number, seed?: number) => string} makeTemplate the deterministic generator.
 * @returns {object} the fixtures, the workspace file texts, and the sanity checks.
 */
export function buildFixtures(makeTemplate) {
  // ── a small linear test construct ─────────────────────────────────────────
  //
  // EcoRI (`GAATTC`) is spliced at 0-based offset 100 and HindIII (`AAGCTT`) at
  // offset 300. Each splice ADDS 6 bp, so the sites sit at 1-based 101 and 307
  // and the molecule is 512 bp — not the 500 the pre-splice length suggests, and
  // NOT the "200 bp + 300 bp" a two-cut digest would give. The measured answer is
  // three fragments (206, 205, 101 bp), which is why these are probed rather
  // than reasoned about.
  const CONSTRUCT = spliceAt(spliceAt(makeTemplate(500, 21), 300, 'AAGCTT'), 100, 'GAATTC');

  // ── a Golden Gate destination vector ──────────────────────────────────────
  //
  // The tool's contract (read from `simulateGoldenGate`): pass `replace_region`
  // and the vector must be a bare backbone the enzyme does NOT cut — "the tool
  // added the BsaI cassette around the region and designed both vector
  // junctions". A vector that already carries a cassette is the OTHER mode and
  // must then hold exactly one forward `GGTCTC` and one reverse-complemented
  // `GAGACC`; a hand-built cassette satisfies neither branch, which is how the
  // first fixture failed with "BsaI already cuts the bare vector 2 time(s)".
  const backbone = bsaIFreeBackbone(makeTemplate, 900, 31);
  const GG_BACKBONE = backbone.sequence;
  const GG_STUFFER = makeTemplate(50, 47);
  const GG_VECTOR = spliceAt(GG_BACKBONE, 450, GG_STUFFER, 50);

  // ── a cloning insert with flanking sites ──────────────────────────────────
  const CLONE_INSERT = spliceAt(spliceAt(makeTemplate(300, 51), 250, 'AAGCTT'), 50, 'GAATTC');

  // ── a mutagenesis template ────────────────────────────────────────────────
  //
  // `designMutagenesisPrimers` imposes constraints a random template rarely
  // satisfies: the primer must start AND end on G/C, hold 40-60% GC, carry no
  // run of 4, and keep the mutation >=6 bp from either end. An 87 bp ORF cannot
  // even fit the 25-45 bp primer window — the tool correctly answered "no primer
  // pair satisfied the constraints" for every parameter combination tried. So
  // the seed was SEARCHED (seeds 130..139 at position 200); the search lives in
  // `test/benchmark-coverage.mjs`, which asserts directly that this template
  // still yields a pair, so a designer change fails a test instead of silently
  // emptying the task.
  const MUTAGENESIS_TEMPLATE = makeTemplate(400, 135);

  // ── an intron-spanning qPCR target ────────────────────────────────────────
  //
  // `designIntronPrimers` needs the forward primer to straddle the exon-exon
  // junction with `min_junction_bases` on EACH side, so the junction must fall
  // inside an 18-28 bp primer window. Seeds and boundaries were searched; this
  // one yields a pair spanning 12 bp of exon 1 and 6 bp of exon 2.
  const INTRON_GENOMIC = `${makeTemplate(400, 1)}${makeTemplate(300, 101)}${makeTemplate(400, 201)}`;

  // ── a coding sequence for the codon/ORF tasks ─────────────────────────────
  const CDS = `ATG${'GCT'.repeat(3)}${'GAA'.repeat(3)}${'TTC'.repeat(3)}${'AAA'.repeat(3)}${'GGT'.repeat(3)}${'CGT'.repeat(3)}${'TAC'.repeat(3)}${'GAT'.repeat(3)}${'CTG'.repeat(3)}${'TAA'}`;

  // ── workspace files ───────────────────────────────────────────────────────
  const FASTA_TEXT = [
    '>amp_fwd amplicon forward read',
    'ACGTACGTACGTACGTACGT',
    '>amp_rev amplicon reverse read',
    'TTGGCCAATTGGCCAATTGG',
    '>scaffold partial assembly scaffold',
    'GGCCTTAAGGCCTTAAGGCC',
    '',
  ].join('\n');
  const FASTQ_TEXT = ['@read1', 'ACGTACGTACGT', '+', 'IIIIIIIIIIII', '@read2', 'TTTTGGGGCCCC', '+', 'IIIIIIIIIIII', ''].join('\n');

  // A 300 bp slice of the construct, exactly matching it: the Sanger task needs a
  // KNOWN-clean read plus a reference carrying one change. Plain `.seq` rather
  // than an ABIF trace — the verifier accepts both, and a synthetic ABIF would
  // test the binary parser (already covered by smoke.mjs) while adding a fixture
  // nobody can eyeball.
  const SANGER_READ = CONSTRUCT.slice(99, 399);
  const SANGER_TEXT = `>read1\n${SANGER_READ}\n`;

  return {
    CONSTRUCT,
    CONSTRUCT_SITES: { EcoRI: 101, HindIII: 307 },
    CONSTRUCT_DOUBLE_DIGEST_FRAGMENTS: [206, 205, 101],
    GG_BACKBONE,
    GG_BACKBONE_SEED: backbone.seed,
    GG_STUFFER,
    GG_VECTOR,
    GG_REPLACE_REGION: { start: 451, end: 500 },
    GG_INSERTS: [makeTemplate(200, 41), makeTemplate(150, 43)],
    CLONE_INSERT,
    MUTAGENESIS_TEMPLATE,
    MUTAGENESIS_MUTATION: '200A>G',
    INTRON_GENOMIC,
    INTRON_EXONS: [
      { start: 1, end: 400 },
      { start: 701, end: 1100 },
    ],
    INTRON_OPTIONS: { min_junction_bases: 3, amplicon_min: 80, amplicon_max: 200 },
    CDS,
    FASTA_TEXT,
    FASTQ_TEXT,
    SANGER_READ,
    SANGER_TEXT,
    /**
     * The synthetic GenBank fixture committed at `test/fixtures/pUC118.gb`.
     *
     * Written by `benchmark/_make-genbank.mjs` from the SnapGene fixture's own
     * sequence, so the two files describe the SAME 3162 bp plasmid — which is
     * what lets one task ask about both formats and compare them.
     */
    GENBANK_PATH: 'test/fixtures/pUC118.gb',
    /** A 14-residue amphipathic helix — the classic helical-wheel demonstrator. */
    AMPHIPATHIC_PEPTIDE: 'LKKLLKKLLKKLLK',
    /** A 33-residue peptide for the MS-digestion and hydropathy tasks. */
    DIGEST_PEPTIDE: 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ',
    /**
     * The two experiment tables the chart tasks read (`molbio_plot`).
     *
     * They live here rather than as committed files because `verifications.mjs`
     * (the offline grader) and `run.mjs` (the model runner) must seed BYTE-
     * identical workspaces — the whole point of the offline gate is that a
     * `where: "tool"` expectation is checked against what the tool really
     * prints for the very input the model gets.
     *
     * `CT_CSV`: six wells per strain. The ko group carries a 34.5 outlier, so a
     * box plot has something to report beyond its fences and the histogram has
     * a real tail.
     * `GROWTH_CSV`: three strains, four time points each, x values that repeat
     * across the strains — which is exactly what a grouped line chart splits.
     */
    CT_CSV: [
      'sample,strain,ct',
      '1,wt,22.1', '2,wt,22.4', '3,wt,23.9', '4,wt,22.8', '5,wt,22.2', '6,wt,22.6',
      '7,ko,19.4', '8,ko,19.1', '9,ko,19.8', '10,ko,34.5', '11,ko,19.3', '12,ko,19.6',
      '',
    ].join('\n'),
    GROWTH_CSV: [
      'time_h,strain,od600',
      '0,wt,0.05', '2,wt,0.21', '4,wt,0.82', '6,wt,1.41',
      '0,mutA,0.04', '2,mutA,0.11', '4,mutA,0.31', '6,mutA,0.52',
      '0,rescue,0.05', '2,rescue,0.19', '4,rescue,0.74', '6,rescue,1.28',
      '',
    ].join('\n'),
    /**
     * A differential-expression table for the volcano task (batch 2).
     *
     * Six genes: two clearly up (large positive log2FC, small p), two clearly
     * down, and two that must NOT be called significant — one with a large
     * effect and a useless p, one with a good p and no effect. Those last two
     * are the point: a chart that coloured purely by fold change, or purely by
     * p, would call them both hits.
     */
    DE_CSV: [
      'gene,log2fc,p',
      'KRAS,2.5,0.0001', 'EGFR,1.8,0.01', 'MYC,0.3,0.6',
      'TP53,-2.2,0.002', 'BRCA1,-1.9,0.004', 'PTEN,-0.2,0.9',
      '',
    ].join('\n'),
    /**
     * A wide-format matrix for the heatmap task (batch 2): the first column is
     * the row label and every other column is a sample, which is the shape a
     * real expression table arrives in.
     */
    HEATMAP_TSV: [
      'gene\tctrl1\tctrl2\tctrl3\tkd1\tkd2\tkd3',
      'KRAS\t0.10\t0.20\t0.05\t2.10\t1.90\t2.30',
      'EGFR\t-0.30\t-0.10\t-0.20\t1.40\t1.20\t1.50',
      'MYC\t0.05\t-0.10\t0.10\t0.20\t0.10\t0.30',
      'TP53\t-1.20\t-1.10\t-1.30\t0.40\t0.50\t0.30',
      '',
    ].join('\n'),
  };
}

/** The BsaI recognition sequences found in a backbone (asserts emptiness). */
export function bsaISitesIn(sequence) {
  return ['GGTCTC', 'GAGACC'].filter((site) => sequence.includes(site));
}

/** The reverse strand of a top-strand slice — the form a reverse primer takes. */
export function reverseComplementOf(sequence) {
  return reverseComplement(sequence);
}

/**
 * The canonical fixture set, built once at module load.
 *
 * Every consumer (task authoring, the offline grader, the coverage test) reads
 * these values, so the sequence in a task's instruction and the sequence the
 * grader feeds a tool cannot diverge.
 */
export const FIXTURES = buildFixtures(makeTemplate);
