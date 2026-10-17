/**
 * dsh-molbio-tools/batch.mjs
 *
 * Batch sequence-file analysis: parse every matching file in a workspace
 * directory, compute the same summary for each, and emit one CSV/TSV table.
 * Pure parsing and computation; file discovery and writes live in index.mjs and
 * go through ctx.fs with the session sandbox policy.
 *
 * The point is the TABLE, not a second implementation of each analysis: GC/N
 * come from lib.mjs's baseCounts, ORFs from translateFrames, enzyme sites from
 * digest, and the GenBank/SnapGene parsers are the same ones the single-file
 * tools use. A file that cannot be parsed becomes an error row instead of
 * aborting the whole batch — one bad .dna in a folder of 60 must not hide the
 * other 59.
 */

import { MolbioInputError, baseCounts, digest, normalizeSequence, translateFrames } from './lib.mjs';
import { parseGenBank } from './genbank.mjs';
import { parseSnapGeneBytes } from './snapgene.mjs';
import { entryStats, parseFasta, parseFastq } from './seqio.mjs';

export const BATCH_LIMITS = {
  maxFiles: 500,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxOrfBases: 2_000_000,
  maxEnzymes: 20,
};

const round2 = (value) => Math.round(value * 100) / 100;

/** Detect the format from the extension, then from the content. */
export function detectBatchFormat(path, text) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith('.dna')) return 'snapgene';
  if (/\.(gb|gbk|genbank)$/.test(lower)) return 'genbank';
  if (/\.(fa|fasta|fna|fas|ffn)$/.test(lower)) return 'fasta';
  if (/\.(fq|fastq)$/.test(lower)) return 'fastq';
  const head = typeof text === 'string' ? text.trimStart() : '';
  if (head.startsWith('>')) return 'fasta';
  if (head.startsWith('@')) return 'fastq';
  if (/^LOCUS\s/m.test(head)) return 'genbank';
  return 'text';
}

/** Convert a simple basename glob (*, ?) to a RegExp. */
export function globToRegExp(pattern) {
  const source = String(pattern)
    .replace(/[.+^$()|[\]{}]/g, '\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp('^' + source + '$', 'i');
}

/** Parse one sequence file into its name/topology/sequence/features. */
function parseOne({ path, format, text, bytes }) {
  if (format === 'snapgene') {
    if (bytes === undefined) throw new MolbioInputError('a .dna file needs binary bytes');
    const parsed = parseSnapGeneBytes(bytes);
    return {
      name: parsed.name,
      topology: parsed.topology === 'circular' ? 'circular' : 'linear',
      sequence: parsed.sequence,
      features: parsed.features.length,
    };
  }
  if (format === 'genbank') {
    const parsed = parseGenBank(String(text ?? ''));
    return {
      name: parsed.name ?? path,
      topology: parsed.topology === 'circular' ? 'circular' : 'linear',
      sequence: parsed.sequence,
      features: parsed.features.length,
    };
  }
  if (format === 'fasta') {
    const entries = parseFasta(String(text ?? ''));
    return {
      name: entries[0]?.id ?? path,
      topology: 'unknown',
      sequence: entries.map((entry) => entry.sequence).join(''),
      features: 0,
      entries: entries.length,
      fastaEntries: entries,
    };
  }
  if (format === 'fastq') {
    const entries = parseFastq(String(text ?? ''));
    return {
      name: entries[0]?.id ?? path,
      topology: 'unknown',
      sequence: entries.map((entry) => entry.sequence).join(''),
      features: 0,
      entries: entries.length,
      fastqEntries: entries,
    };
  }
  const sequence = normalizeSequence(String(text ?? ''), 'sequence');
  return { name: path, topology: 'unknown', sequence, features: 0, entries: 1 };
}

/**
 * Analyze one file.
 *
 * @param {{path: string, format?: string, text?: string, bytes?: Uint8Array,
 *   enzymes?: string[], orfMinAa?: number, circular?: boolean, codonTable?: string}} input
 * @returns {object} one table row; throws only for an unrecognizable file.
 */
export function analyzeSequenceFile(input) {
  const { path, text, bytes } = input;
  const format = input.format ?? detectBatchFormat(path, text);
  const parsed = parseOne({ path, format, text, bytes });
  const sequence = normalizeSequence(parsed.sequence, path + ' sequence');
  const counts = baseCounts(sequence);
  const totalBases = sequence.length;
  const gcPercent = counts.gc + counts.at === 0 ? 0 : round2((counts.gc / (counts.gc + counts.at)) * 100);
  const nPercent = totalBases === 0 ? 0 : round2((counts.n / totalBases) * 100);
  const row = {
    path,
    format,
    topology: parsed.topology,
    entries: parsed.entries ?? 1,
    total_bases: totalBases,
    gc_percent: gcPercent,
    n_percent: nPercent,
    feature_count: parsed.features,
    enzyme_sites: [],
    error: '',
  };
  const enzymes = input.enzymes ?? [];
  if (enzymes.length > 0) {
    const circular = input.circular === true || parsed.topology === 'circular';
    const result = digest(sequence, enzymes, circular);
    row.enzyme_sites = result.map((entry, index) => ({
      name: enzymes[index],
      sites: entry.cut_positions.length,
    }));
  }
  const orfMinAa = input.orfMinAa ?? 0;
  if (orfMinAa > 0) {
    if (totalBases > BATCH_LIMITS.maxOrfBases) {
      row.orf_count = 0;
      row.longest_orf_aa = 0;
      row.orf_skipped = true;
    } else {
      const { orfs } = translateFrames(sequence, 'all', input.codonTable ?? 'standard', orfMinAa);
      row.orf_count = orfs.length;
      row.longest_orf_aa = orfs.length === 0 ? 0 : Math.max(...orfs.map((orf) => orf.length_aa));
      row.orf_skipped = false;
    }
  }
  if (format === 'fasta' || format === 'fastq') {
    const stats = entryStats(parsed.fastaEntries ?? parsed.fastqEntries ?? [], format === 'fastq');
    row.mean_length = stats.mean_length;
    if (format === 'fastq' && stats.quality_mean !== undefined) row.quality_mean = stats.quality_mean;
  }
  return row;
}

/** Columns for the table, in a stable order. */
export function batchColumns({ orfs, enzymes }) {
  const columns = ['path', 'format', 'topology', 'entries', 'total_bases', 'gc_percent', 'n_percent', 'feature_count', 'mean_length'];
  if (orfs) columns.push('orf_count', 'longest_orf_aa', 'orf_skipped');
  if (enzymes.length > 0) columns.push(...enzymes.map((name) => name + '_sites'));
  columns.push('error');
  return columns;
}

function csvField(value, delimiter) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.includes(delimiter) || /["\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** Render rows as CSV (delimiter = ",") or TSV (delimiter = "\t"). */
export function batchTable(rows, columns, delimiter = ',') {
  const value = (row, column) => {
    if (column.endsWith('_sites')) {
      const name = column.slice(0, -'_sites'.length);
      return row.enzyme_sites?.find((entry) => entry.name === name)?.sites;
    }
    return row[column];
  };
  const lines = rows.map((row) => columns.map((column) => csvField(value(row, column), delimiter)).join(delimiter));
  return [columns.join(delimiter), ...lines].join('\n') + '\n';
}
