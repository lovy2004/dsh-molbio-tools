/**
 * dsh-molbio-tools/contamination.mjs
 *
 * A small, EMBEDDED set of common vector-backbone/promoter/origin and
 * Illumina/Nextera adapter signatures, plus a bounded both-strand screen.
 *
 * This is deliberately a short-signature screen, not a database search:
 * a hit is evidence worth following up, and a miss is NOT evidence that a
 * sample is clean. The table lives in code because the package has no external
 * data files; every entry names the feature it represents so a report can be
 * read without guessing which 20-mer matched.
 *
 * The adapters are shared with the FASTQ QC adapter-content panel. They are DNA
 * here: the Small RNA 5' entry is publicly documented as RNA (GUUCAG...), but a
 * FASTQ read is cDNA, so keeping the U in the table made the forward molecule
 * unmatchable. Normalizing U→T at the source fixes the screen for both the
 * standalone tool and fastq-qc's adapter panel.
 */
import { MolbioInputError, normalizeSequence, reverseComplement } from './lib.mjs';

/** One signature in the embedded table. */
export const ADAPTERS = [
  { name: 'Illumina Universal', kind: 'adapter', category: 'adapter', sequence: 'AGATCGGAAGAG' },
  { name: "Illumina Small RNA 3'", kind: 'adapter', category: 'adapter', sequence: 'TGGAATTCTCGG' },
  { name: "Illumina Small RNA 5'", kind: 'adapter', category: 'adapter', sequence: 'GTTCAGAGTTCTACAGTCCGACGATC' },
  { name: 'Nextera Transposase', kind: 'adapter', category: 'adapter', sequence: 'CTGTCTCTTATA' },
  { name: 'PolyA', kind: 'adapter', category: 'homopolymer', sequence: 'AAAAAAAAAAAA' },
  { name: 'PolyG', kind: 'adapter', category: 'homopolymer', sequence: 'GGGGGGGGGGGG' },
];

/**
 * Common vector signatures. These are SHORT, deliberately: a 20-35 bp signature
 * is enough to flag a backbone/promoter/origin in an assembly or read set, while
 * a full vector sequence would turn this table into a reference database (and
 * raise licensing questions). Names say which element matched.
 */
export const VECTORS = [
  { name: 'pUC/pBR322 origin', kind: 'vector', category: 'origin', sequence: 'GTTTGCCGGATCAAGAGCTACCAACTCTTT' },
  { name: 'pUC19 lacZ/M13 region', kind: 'vector', category: 'backbone', sequence: 'GTTTTCCCAGTCACGACGTTGTAAAACGACGGCCAGT' },
  { name: 'pUC/pBR322 bla (AmpR) start', kind: 'vector', category: 'selection', sequence: 'ATGAGTATTCAACATTTCCGTGTCGCCCTT' },
  { name: 'pET T7 promoter', kind: 'vector', category: 'promoter', sequence: 'TAATACGACTCACTATAGGG' },
  { name: 'pET T7 terminator', kind: 'vector', category: 'terminator', sequence: 'GCTAGTTATTGCTCAGCGG' },
  { name: 'pcDNA CMV promoter', kind: 'vector', category: 'promoter', sequence: 'CGCAAATGGGCGGTAGGCGTG' },
  { name: 'pcDNA BGH polyA', kind: 'vector', category: 'terminator', sequence: 'CTAGAAGGCACAGTCGAGG' },
  { name: 'Gateway attB1', kind: 'vector', category: 'recombination', sequence: 'ACAAGTTTGTACAAAAAAGCAGGCT' },
  { name: 'Gateway attB2', kind: 'vector', category: 'recombination', sequence: 'ACCCAGCTTTCTTGTACAAAGTGGT' },
];

/** Every embedded signature, adapters first (the table order is stable). */
export const SIGNATURES = [...ADAPTERS, ...VECTORS];

/** Defaults and hard bounds shared by the tool, tests and docs. */
export const CONTAMINATION_DEFAULTS = {
  maxMismatches: 0,
  maxMismatchesHard: 2,
  maxReads: 0,
  maxReadsHard: 200000,
  maxHits: 100,
};

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Hamming distance over equal-length strings (non-ACGT positions count as mismatches). */
function hamming(a, b) {
  let distance = 0;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) distance++;
  }
  return distance;
}

/** The seed chunks used by the mismatch path; one chunk when maxMismatches is 0. */
function seedChunks(signature, maxMismatches) {
  const count = maxMismatches + 1;
  const base = Math.floor(signature.length / count);
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const length = index === count - 1 ? signature.length - offset : base;
    chunks.push({ needle: signature.slice(offset, offset + length), offset });
    offset += length;
  }
  return chunks;
}

/**
 * Best occurrence of one needle on one strand, or undefined.
 *
 * Exact mode is a plain indexOf. The mismatch path uses maxMismatches+1 seed
 * chunks: at most maxMismatches chunks can be altered, so at least one chunk
 * must occur verbatim; every seed occurrence is verified with a Hamming count.
 * This keeps a 30-mer search linear in the number of seed hits instead of
 * scanning every window of every read.
 */
function bestOnStrand(sequence, needle, maxMismatches, strand) {
  let best;
  const consider = (start, mismatches) => {
    if (start < 0 || start + needle.length > sequence.length) return;
    if (best === undefined
      || mismatches < best.mismatches
      || (mismatches === best.mismatches && start < best.start)) {
      best = { start, end: start + needle.length, strand, mismatches };
    }
  };
  if (maxMismatches === 0) {
    let from = 0;
    while (from <= sequence.length - needle.length) {
      const at = sequence.indexOf(needle, from);
      if (at === -1) break;
      consider(at, 0);
      from = at + 1;
    }
    return best;
  }
  for (const chunk of seedChunks(needle, maxMismatches)) {
    if (chunk.needle.length === 0) continue;
    let from = 0;
    while (from <= sequence.length - chunk.needle.length) {
      const at = sequence.indexOf(chunk.needle, from);
      if (at === -1) break;
      const start = at - chunk.offset;
      if (start >= 0 && start + needle.length <= sequence.length) {
        const mismatches = hamming(sequence.slice(start, start + needle.length), needle);
        if (mismatches <= maxMismatches) consider(start, mismatches);
      }
      from = at + 1;
    }
  }
  return best;
}

/** Best hit of a signature against a sequence on either strand. */
export function findSignatureHit(sequence, signature, maxMismatches = 0) {
  const forward = bestOnStrand(sequence, signature, maxMismatches, '+');
  const reverse = bestOnStrand(sequence, reverseComplement(signature), maxMismatches, '-');
  if (forward === undefined) return reverse;
  if (reverse === undefined) return forward;
  if (reverse.mismatches < forward.mismatches) return reverse;
  if (reverse.mismatches === forward.mismatches && reverse.start < forward.start) return reverse;
  return forward;
}

/**
 * Screen one or more sequences against the embedded signatures.
 *
 * @param {Array<{id: string, sequence: string}>} entries
 * @param {{maxMismatches?: number, kinds?: 'both'|'adapter'|'vector', maxReads?: number}} [options]
 * @returns {object} aggregate hits plus the criteria that produced them.
 */
export function screenContamination(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new MolbioInputError('contamination screening needs at least one sequence');
  const maxMismatches = options.maxMismatches ?? CONTAMINATION_DEFAULTS.maxMismatches;
  if (!Number.isInteger(maxMismatches) || maxMismatches < 0 || maxMismatches > CONTAMINATION_DEFAULTS.maxMismatchesHard) {
    throw new MolbioInputError('max_mismatches must be an integer between 0 and ' + CONTAMINATION_DEFAULTS.maxMismatchesHard);
  }
  const kinds = options.kinds ?? 'both';
  if (!['both', 'adapter', 'vector'].includes(kinds)) throw new MolbioInputError('kinds must be "both", "adapter" or "vector"');
  const maxReads = options.maxReads ?? CONTAMINATION_DEFAULTS.maxReads;
  if (!Number.isInteger(maxReads) || maxReads < 0 || maxReads > CONTAMINATION_DEFAULTS.maxReadsHard) {
    throw new MolbioInputError('max_reads must be an integer between 0 and ' + CONTAMINATION_DEFAULTS.maxReadsHard);
  }
  const limit = maxReads === 0 ? CONTAMINATION_DEFAULTS.maxReadsHard : maxReads;
  const normalized = entries.map((entry, index) => ({
    id: typeof entry?.id === 'string' && entry.id !== '' ? entry.id : 'entry' + (index + 1),
    sequence: normalizeSequence(entry?.sequence ?? '', 'sequence'),
  }));
  const scanned = normalized.slice(0, limit);
  const truncated = normalized.length > scanned.length;
  const signatures = SIGNATURES.filter((signature) => kinds === 'both' || signature.kind === kinds);
  let ambiguousBases = 0;
  let bases = 0;
  for (const entry of scanned) {
    bases += entry.sequence.length;
    for (const base of entry.sequence) if (!'ACGT'.includes(base)) ambiguousBases++;
  }
  const hits = [];
  const withHit = new Set();
  for (const signature of signatures) {
    let reads = 0;
    let best;
    for (let index = 0; index < scanned.length; index++) {
      const entry = scanned[index];
      const hit = findSignatureHit(entry.sequence, signature.sequence, maxMismatches);
      if (hit === undefined) continue;
      reads++;
      withHit.add(index);
      if (best === undefined
        || hit.mismatches < best.mismatches
        || (hit.mismatches === best.mismatches && hit.start < best.start)) {
        best = { ...hit, id: entry.id };
      }
    }
    if (reads === 0) continue;
    hits.push({
      name: signature.name,
      kind: signature.kind,
      category: signature.category,
      signature: signature.sequence,
      reads,
      percent: round((reads / scanned.length) * 100),
      best_mismatches: best.mismatches,
      example: {
        id: best.id,
        start: best.start + 1,
        end: best.end,
        strand: best.strand,
        mismatches: best.mismatches,
      },
    });
  }
  hits.sort((a, b) => b.reads - a.reads || a.name.localeCompare(b.name));
  return {
    total_entries: normalized.length,
    scanned_entries: scanned.length,
    bases,
    ambiguous_bases: ambiguousBases,
    hits: hits.slice(0, CONTAMINATION_DEFAULTS.maxHits),
    hit_count: Math.min(hits.length, CONTAMINATION_DEFAULTS.maxHits),
    reads_with_hit: withHit.size,
    truncated,
    criteria: {
      max_mismatches: maxMismatches,
      kinds,
      signature_count: signatures.length,
      max_reads: maxReads,
      match_basis: 'embedded short signatures, both strands, substitutions only (no gaps); a negative result does not prove the sample is clean',
    },
  };
}
