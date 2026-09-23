/**
 * dsh-molbio-tools/benchmark/sequences.mjs
 *
 * The DNA the benchmark tasks use, in one place.
 *
 * `tasks/*.json` is JSON on purpose — it is data, it diffs cleanly, and a
 * reviewer can read a task without reading code. The cost is that a task cannot
 * compute anything, and several tasks need *generated* input:
 *
 *  - a pseudo-random 400 bp primer-design template (a hand-typed 400-mer
 *    invites typos);
 *  - the reference (200 bp) plus the read (`ALIGN_READ`) for the alignment task,
 *    where the read must be DERIVED from the reference or the "exactly one
 *    mismatch at reference position 81" claim silently becomes false;
 *  - the synthetic construct, vector and inserts in `fixtures.mjs`.
 *
 * Those live here as pure functions, and the runner expands a task's
 * placeholders before handing the instruction to the model. Deriving the read is
 * the point: the ground truth is then a property of this module, so the
 * instruction and the expected mismatch position cannot disagree.
 *
 * Placeholder syntax is `{name}` or `{name:arg}`; an unknown name or a missing
 * or extra argument is a hard error, so a typo in a task file fails the run
 * instead of sending the model the literal text `{seq:typo}`.
 */

import { FIXTURES, reverseComplementOf } from './fixtures.mjs';

export { FIXTURES, reverseComplementOf };

/** Deterministic pseudo-random DNA (the generator `test/smoke.mjs` uses). */
export function makeTemplate(n, seed = 42) {
  let s = seed;
  const bases = 'ACGT';
  let out = '';
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += bases[(s >> 16) % 4];
  }
  return out;
}

/** The 200 bp reference for the alignment task. */
export const ALIGN_REFERENCE = makeTemplate(200, 11);

/**
 * The 60 bp "sequenced" read: reference positions 51-110 with one base changed.
 *
 * Read offset 30 is rewritten to `A`. `benchmark/_probe.mjs` confirms that A is
 * a genuine mismatch against the reference there, so the tool reports exactly
 * one difference, at reference position 81.
 */
export const ALIGN_READ = `${ALIGN_REFERENCE.slice(50, 80)}A${ALIGN_REFERENCE.slice(81, 110)}`;

/** The 400 bp primer-design template. */
export const QPCR_TEMPLATE = makeTemplate(400, 7);

/**
 * A 402 bp fragment that DOES contain a CpG island.
 *
 * A synthetic low-complexity repeat (`CGCG…`) is a bad fixture: it has a high
 * CpG observed/expected ratio, but the island rules also require a minimum
 * LENGTH while the surrounding padding drags the GC of every window down, so
 * the tool correctly reports no island and the task would be graded on a
 * sequence that does not demonstrate what it claims. This is the 5' end of
 * pUC118 (positions 1-402), which the probe confirms yields one island:
 * 1-200, 200 bp, 57% GC, CpG o/e 1.08, against an overall GC of 47.5%.
 *
 * The gap between those two numbers is the point of the task: a model that
 * reports the OVERALL GC as the island's GC has not read the result.
 */
export const PUCI18_CPG_REGION = 'TCGCGCGTTTCGGTGATGACGGTGAAAACCTCTGACACATGCAGCTCCCGGAGACGGTCACAGCTTGTCTGTAAGCGGATGCCGGGAGCAGACAAGCCCGTCAGGGCGCGTCAGCGGGTGTTGGCGGGTGTCGGGGCTGGCTTAACTATGCGGCATCAGAGCAGATTGTACTGAGAGTGCACCATAAAATTGTAAACGTTAATATTTTGTTAAAATTCGCGTTAAATTTTTGTTAAATCAGCTCATTTTTTAACCAATAGGCCGAAATCGGCAAAATCCCTTATAAATCAAAAGAATAGCCCGAGATAGGGTTGAGTGTTGTTCCAGTTTGGAACAAGAGTCCACTATTAAAGAACGTGGACTCCAACGTCAAAGGGCGAAAAACCGTCTATCAGGGCGATG';

/** 1-based mutation the searched mutagenesis template admits a pair for. */
export const MUTAGENESIS_MUTATION = FIXTURES.MUTAGENESIS_MUTATION;

/**
 * The named zero-argument sequences, addressable as `{seq:name}`.
 *
 * Exported because the offline grader (`verifications.mjs`) has to run the SAME
 * inputs the task text carries: a second copy of these sequences would let the
 * instruction and the expectation diverge without either one looking wrong.
 */
export const NAMED_SEQUENCES = {
  align_reference: ALIGN_REFERENCE,
  align_read: ALIGN_READ,
  qpcr_template: QPCR_TEMPLATE,
  puc118_cpg_region: PUCI18_CPG_REGION,
  construct: FIXTURES.CONSTRUCT,
  pcr_forward: FIXTURES.CONSTRUCT.slice(100, 120),
  pcr_reverse: reverseComplementOf(FIXTURES.CONSTRUCT.slice(281, 301)),
  gg_vector: FIXTURES.GG_VECTOR,
  intron_genomic: FIXTURES.INTRON_GENOMIC,
  gg_insert_1: FIXTURES.GG_INSERTS[0],
  gg_insert_2: FIXTURES.GG_INSERTS[1],
  clone_insert: FIXTURES.CLONE_INSERT,
  cds: FIXTURES.CDS,
  mutagenesis_template: FIXTURES.MUTAGENESIS_TEMPLATE,
  sanger_read: FIXTURES.SANGER_READ,
  /**
   * The three FASTQ reads the `fastq-qc` task pastes in.
   *
   * Named so the instruction and the offline grader use ONE copy: the first
   * version of that task hard-coded the reads in the instruction while the
   * grader read `reads.fq`, whose contents are different — so the offline check
   * "verified" a 2-read file against a 3-read expectation and passed only
   * because nobody had run it yet. Read r3 carries quality-0 bases, which is the
   * 3' collapse the task asks about.
   */
  qc_reads: [
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
  ].join('\n'),
};

/** Named sequences that take an integer argument. */
const PARAMETERISED = {
  template: (n, seed) => makeTemplate(n, seed),
};

/**
 * Expand `{name}` / `{name:arg}` / `{name:arg:arg2}` placeholders.
 *
 * @param {string} text the raw instruction.
 * @returns {string} the instruction a human would have typed.
 */
export function expandInstruction(text) {
  return text.replace(/\{[^{}]*\}/g, (match) => {
    const parts = match.slice(1, -1).split(':');
    const name = parts[0];
    const args = parts.slice(1);
    // `{seq:<name>}` is a NAMESPACE, not a lookup of `NAMED_SEQUENCES.seq`: the
    // first draft tested `hasOwn(NAMED_SEQUENCES, name)` with `name === 'seq'`,
    // which is false for every named sequence, so every `{seq:…}` placeholder
    // fell through to the "unknown placeholder" error while the helper looked
    // correct. The namespace is unpacked first for that reason.
    if (name === 'seq') {
      if (args.length !== 1) throw new Error(`benchmark: {seq:name} takes exactly one name (got ${args.length})`);
      const value = NAMED_SEQUENCES[args[0]];
      if (value === undefined) {
        throw new Error(
          `benchmark: unknown named sequence "${args[0]}" (have: ${Object.keys(NAMED_SEQUENCES).join(', ')})`,
        );
      }
      return value;
    }
    if (Object.hasOwn(NAMED_SEQUENCES, name)) {
      if (args.length > 0) throw new Error(`benchmark: {${name}} takes no argument (got ${args.length})`);
      return NAMED_SEQUENCES[name];
    }
    if (Object.hasOwn(PARAMETERISED, name)) {
      if (args.length === 0) throw new Error(`benchmark: {${name}} needs at least one argument`);
      const numbers = args.map((value) => {
        if (!/^\d+$/.test(value)) throw new Error(`benchmark: {${name}} arguments must be integers (got "${value}")`);
        return Number(value);
      });
      return PARAMETERISED[name](...numbers);
    }
    throw new Error(`benchmark: unknown placeholder ${match}`);
  });
}
