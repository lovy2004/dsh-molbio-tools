/**
 * dsh-molbio-tools/fastq-trim.mjs
 *
 * Pure FASTQ trimming/filtering: 5' primer removal, 3' adapter removal, 3'
 * sliding-window quality trimming, poly-G/poly-A tail trimming, and length/N
 * filters. No file I/O and no quality re-encoding — the tool layer reads and
 * writes through ctx.fs, while this module only transforms entry objects.
 *
 * The deliberately narrow scope is stated in the tool description: this is not
 * a paired-end merger, not cutadapt's semiglobal aligner, and not a UMI
 * pipeline. The algorithms here are the ones a bench user can reason about.
 */
import { MolbioInputError, normalizeSequence } from './lib.mjs';

/** Defaults and hard bounds shared by the tool, tests and docs. */
export const FASTQ_TRIM_DEFAULTS = {
  minQuality: 20,
  qualityWindow: 4,
  polyMin: 8,
  minLength: 0,
  maxNPercent: 100,
  phred: 33,
  maxReads: 0,
  maxReadsHard: 200000,
};

const PHRED_OFFSETS = [33, 64];

function integerIn(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MolbioInputError(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

function numberIn(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new MolbioInputError(name + ' must be a number between ' + min + ' and ' + max);
  }
  return value;
}

/** Validate and normalize the options once per call. */
export function resolveTrimOptions(options = {}) {
  const minQuality = integerIn(options.minQuality ?? FASTQ_TRIM_DEFAULTS.minQuality, 'min_quality', 0, 60);
  const qualityWindow = integerIn(options.qualityWindow ?? FASTQ_TRIM_DEFAULTS.qualityWindow, 'quality_window', 1, 100);
  const polyMin = integerIn(options.polyMin ?? FASTQ_TRIM_DEFAULTS.polyMin, 'poly_min', 2, 100);
  const minLength = integerIn(options.minLength ?? FASTQ_TRIM_DEFAULTS.minLength, 'min_length', 0, 1_000_000);
  const maxNPercent = numberIn(options.maxNPercent ?? FASTQ_TRIM_DEFAULTS.maxNPercent, 'max_n_percent', 0, 100);
  const phred = options.phred ?? FASTQ_TRIM_DEFAULTS.phred;
  if (!PHRED_OFFSETS.includes(phred)) throw new MolbioInputError('phred must be 33 or 64');
  const maxReads = integerIn(options.maxReads ?? FASTQ_TRIM_DEFAULTS.maxReads, 'max_reads', 0, FASTQ_TRIM_DEFAULTS.maxReadsHard);
  const adapter = options.adapter === undefined || options.adapter === ''
    ? ''
    : normalizeSequence(options.adapter, 'adapter');
  const primer = options.primer === undefined || options.primer === ''
    ? ''
    : normalizeSequence(options.primer, 'primer');
  return {
    minQuality,
    qualityWindow,
    polyMin,
    minLength,
    maxNPercent,
    phred,
    maxReads,
    adapter,
    primer,
    trimPolyG: options.polyG === true,
    trimPolyA: options.polyA === true,
  };
}

/** 0-based exclusive end after 3' sliding-window quality trimming. */
function qualityTrimEnd(sequence, quality, options) {
  const length = sequence.length;
  if (length === 0) return 0;
  const window = Math.min(options.qualityWindow, length);
  let end = length;
  while (end >= window) {
    let sum = 0;
    for (let index = end - window; index < end; index++) {
      const q = quality.charCodeAt(index) - options.phred;
      if (q < 0 || q > 93) throw new MolbioInputError('FASTQ quality character outside Phred+' + options.phred + ' range at read position ' + (index + 1));
      sum += q;
    }
    if (sum / window >= options.minQuality) break;
    end--;
  }
  return end < window ? 0 : end;
}

/** Longest trailing run of one base, or 0. */
function trailingRun(sequence, base) {
  let length = 0;
  for (let index = sequence.length - 1; index >= 0 && sequence[index] === base; index--) length++;
  return length;
}

/** Count Ns (and any other non-ACGT base) in a sequence. */
function ambiguousCount(sequence) {
  let count = 0;
  for (const base of sequence) if (!'ACGT'.includes(base)) count++;
  return count;
}

/**
 * Trim/filter one parsed FASTQ entry.
 *
 * @param {{id: string, description: string, sequence: string, quality: string}} entry
 * @param {ReturnType<typeof resolveTrimOptions>} options
 * @returns {{entry?: object, dropped?: 'length'|'n', trims: {quality:boolean, adapter:boolean, poly_g:boolean, poly_a:boolean, primer:boolean}}}
 */
export function trimRead(entry, options) {
  if (typeof entry?.sequence !== 'string' || typeof entry?.quality !== 'string') throw new MolbioInputError('each read needs a sequence and a quality string');
  if (entry.sequence.length !== entry.quality.length) throw new MolbioInputError('read ' + entry.id + ': sequence and quality lengths differ');
  let sequence = entry.sequence;
  let quality = entry.quality;
  const trims = { quality: false, adapter: false, poly_g: false, poly_a: false, primer: false };

  if (options.primer !== '' && sequence.startsWith(options.primer)) {
    sequence = sequence.slice(options.primer.length);
    quality = quality.slice(options.primer.length);
    trims.primer = true;
  }
  if (options.adapter !== '') {
    const at = sequence.indexOf(options.adapter);
    if (at !== -1) {
      sequence = sequence.slice(0, at);
      quality = quality.slice(0, at);
      trims.adapter = true;
    }
  }

  const qualityEnd = qualityTrimEnd(sequence, quality, options);
  if (qualityEnd < sequence.length) {
    sequence = sequence.slice(0, qualityEnd);
    quality = quality.slice(0, qualityEnd);
    trims.quality = true;
  }

  if (options.trimPolyG) {
    const run = trailingRun(sequence, 'G');
    if (run >= options.polyMin) {
      sequence = sequence.slice(0, sequence.length - run);
      quality = quality.slice(0, quality.length - run);
      trims.poly_g = true;
    }
  }
  if (options.trimPolyA) {
    const run = trailingRun(sequence, 'A');
    if (run >= options.polyMin) {
      sequence = sequence.slice(0, sequence.length - run);
      quality = quality.slice(0, quality.length - run);
      trims.poly_a = true;
    }
  }

  if (sequence.length === 0) return { dropped: 'length', trims };
  if (sequence.length < options.minLength) return { dropped: 'length', trims };
  const nPercent = (ambiguousCount(sequence) / sequence.length) * 100;
  if (nPercent > options.maxNPercent) return { dropped: 'n', trims };
  return {
    entry: {
      id: entry.id,
      description: entry.description ?? '',
      sequence,
      quality,
    },
    trims,
  };
}

/**
 * Trim/filter a set of parsed FASTQ entries.
 *
 * @param {Array<object>} entries
 * @param {object} [options]
 * @returns {{entries: Array<object>, stats: object}}
 */
export function trimFastq(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new MolbioInputError('FASTQ trimming needs at least one read');
  const resolved = resolveTrimOptions(options);
  const limit = resolved.maxReads === 0 ? FASTQ_TRIM_DEFAULTS.maxReadsHard : resolved.maxReads;
  const scanned = entries.slice(0, limit);
  const kept = [];
  const trimCounts = { quality: 0, adapter: 0, poly_g: 0, poly_a: 0, primer: 0 };
  const dropCounts = { length: 0, n: 0 };
  let basesIn = 0;
  let basesOut = 0;
  let trimmedReads = 0;
  for (const entry of scanned) {
    basesIn += entry.sequence.length;
    const result = trimRead(entry, resolved);
    if (result.entry === undefined) {
      dropCounts[result.dropped]++;
      continue;
    }
    kept.push(result.entry);
    basesOut += result.entry.sequence.length;
    let trimmed = false;
    for (const [key, value] of Object.entries(result.trims)) {
      if (value) {
        trimCounts[key]++;
        trimmed = true;
      }
    }
    if (trimmed) trimmedReads++;
  }
  return {
    entries: kept,
    stats: {
      total_reads: entries.length,
      reads_in: scanned.length,
      reads_out: kept.length,
      bases_in: basesIn,
      bases_out: basesOut,
      trimmed_reads: trimmedReads,
      dropped_reads: scanned.length - kept.length,
      trim_counts: trimCounts,
      drop_counts: dropCounts,
      truncated: entries.length > scanned.length,
      criteria: {
        min_quality: resolved.minQuality,
        quality_window: resolved.qualityWindow,
        poly_min: resolved.polyMin,
        min_length: resolved.minLength,
        max_n_percent: resolved.maxNPercent,
        phred: resolved.phred,
        max_reads: resolved.maxReads,
        adapter: resolved.adapter,
        primer: resolved.primer,
        poly_g: resolved.trimPolyG,
        poly_a: resolved.trimPolyA,
      },
    },
  };
}
