/**
 * dsh-molbio-tools/sequence-ops.mjs
 *
 * Format interchange and sequence surgery for annotated DNA:
 *   - features → GFF3 / BED / CSV, with the three coordinate conventions kept
 *     apart instead of silently converted;
 *   - rotate / insert / delete / replace / split / join on a sequence.
 *
 * The coordinate systems are the whole point of the first half. GenBank and
 * GFF3 are 1-based and INCLUSIVE; BED is 0-based and HALF-OPEN. An off-by-one
 * here does not throw — it silently exports the wrong interval — so each format
 * is built from its own explicit conversion and the tool reports which one it
 * used. CDS phase is NOT computed: the transcript frame is not modelled, so the
 * column is '.' (unknown) rather than a plausible-looking guess.
 */

import { MolbioInputError, normalizeSequence } from './lib.mjs';

const FORMATS = ['gff3', 'bed', 'csv'];
const OPERATIONS = ['rotate', 'insert', 'delete', 'replace', 'split', 'join'];

function sanitizeName(value, fallback) {
  const text = String(value ?? '').trim();
  return text === '' ? fallback : text.replace(/[\s]+/g, '_');
}

/** Percent-encode the characters GFF3 reserves inside an attribute value. */
function gffValue(value) {
  return String(value).replace(/[%&=;,\t\n\r]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** RFC 4180 quoting for one CSV cell. */
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function validateFeatures(features, length) {
  const rows = [];
  for (const [index, feature] of features.entries()) {
    const start = feature.start;
    const end = feature.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end) {
      throw new MolbioInputError(`feature ${index + 1} has an invalid span ${JSON.stringify(start)}..${JSON.stringify(end)} (1-based inclusive, start <= end)`);
    }
    if (end > length) throw new MolbioInputError(`feature ${index + 1} ends at ${end}, past the sequence length ${length}`);
    // Parsers use 1 / -1; GFF3 and BED spell the strand '+' / '-' / '.'.
    const strand = feature.strand === '-' || feature.strand === -1 ? '-' : feature.strand === '+' || feature.strand === 1 ? '+' : '.';
    rows.push({ ...feature, start, end, strand });
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  return rows;
}

/**
 * Convert annotated features to GFF3, BED or CSV.
 *
 * @param {object} input {name, sequence, features, format}
 * @returns {object} {format, coordinate_system, content, count, notes}
 */
export function exportFeatures({ name, sequence, features = [], format }) {
  if (!FORMATS.includes(format)) throw new MolbioInputError(`format must be one of ${FORMATS.join(', ')}`);
  if (typeof sequence !== 'string' || sequence.length === 0) throw new MolbioInputError('a sequence is required to export features');
  const rows = validateFeatures(features, sequence.length);
  const seqid = sanitizeName(name, 'sequence');
  const notes = [];
  if (rows.length === 0) notes.push('the input carries no features; the file is still a valid empty document');
  if (rows.some((row) => row.multi_part === true)) notes.push('multi-part features are exported as their outer span; the raw location is preserved in the location attribute/column');
  if (format === 'gff3' || format === 'bed') notes.push('CDS phase is not computed (the transcript frame is not modelled), so the GFF3 phase column is \'.\'');

  if (format === 'gff3') {
    const lines = ['##gff-version 3', `##sequence-region ${seqid} 1 ${sequence.length}`];
    rows.forEach((row, index) => {
      const attributes = [`ID=${gffValue(sanitizeName(row.type, 'feature'))}_${index + 1}`];
      if (row.label !== undefined && row.label !== '') attributes.push(`Name=${gffValue(row.label)}`);
      if (row.gene !== undefined && row.gene !== '') attributes.push(`gene=${gffValue(row.gene)}`);
      if (row.product !== undefined && row.product !== '') attributes.push(`product=${gffValue(row.product)}`);
      if (row.note !== undefined && row.note !== '') attributes.push(`Note=${gffValue(row.note)}`);
      if (row.location !== undefined && row.location !== '') attributes.push(`location=${gffValue(row.location)}`);
      lines.push([seqid, 'dsh-molbio-tools', sanitizeName(row.type, 'feature'), row.start, row.end, '.', row.strand, '.', attributes.join(';')].join('\t'));
    });
    return {
      format,
      coordinate_system: '1-based inclusive',
      content: lines.join('\n') + '\n',
      count: rows.length,
      notes,
    };
  }

  if (format === 'bed') {
    const lines = [`track name="${seqid}" description="dsh-molbio-tools feature export"`];
    for (const row of rows) {
      const start0 = row.start - 1;
      const end0 = row.end;
      lines.push([seqid, start0, end0, sanitizeName(row.label ?? row.type, 'feature'), 0, row.strand].join('\t'));
    }
    return {
      format,
      coordinate_system: '0-based half-open',
      content: lines.join('\n') + '\n',
      count: rows.length,
      notes,
    };
  }

  const header = ['seqid', 'type', 'start', 'end', 'strand', 'length', 'label', 'gene', 'product', 'location'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      seqid, row.type, row.start, row.end, row.strand, row.end - row.start + 1,
      row.label ?? '', row.gene ?? '', row.product ?? '', row.location ?? '',
    ].map(csvCell).join(','));
  }
  return {
    format,
    coordinate_system: '1-based inclusive',
    content: lines.join('\n') + '\n',
    count: rows.length,
    notes,
  };
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MolbioInputError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

/**
 * Rotate / insert / delete / replace / split / join a DNA sequence.
 *
 * All positions are 1-based and inclusive, matching the rest of the toolset;
 * `position` for rotate/insert and `at` for split is the 0-based-style cut used
 * throughout the description of each operation. Features are NOT remapped —
 * re-export annotations against the new coordinates if the edit moves them.
 */
export function editSequence({ sequence: rawSequence, operation, position, start, end, inserted, replacement, joinWith, overlap = 0 } = {}) {
  const sequence = normalizeSequence(rawSequence, 'sequence');
  if (!OPERATIONS.includes(operation)) throw new MolbioInputError(`operation must be one of ${OPERATIONS.join(', ')}`);
  const notes = [];

  if (operation === 'rotate') {
    requireInteger(position, 'position', 1, sequence.length);
    const rotated = sequence.slice(position - 1) + sequence.slice(0, position - 1);
    notes.push(`the original base ${position} is now base 1 (rotation preserves the circular sequence)`);
    return { operation, input_length: sequence.length, output_length: rotated.length, sequences: [rotated], notes };
  }

  if (operation === 'insert') {
    requireInteger(position, 'position', 0, sequence.length);
    const fragment = normalizeSequence(inserted ?? '', 'inserted');
    if (fragment.length === 0) throw new MolbioInputError('insert needs a non-empty inserted sequence');
    const result = sequence.slice(0, position) + fragment + sequence.slice(position);
    notes.push(`inserted ${fragment.length} bp after ${position} base(s)`);
    return { operation, input_length: sequence.length, output_length: result.length, sequences: [result], notes };
  }

  if (operation === 'delete') {
    requireInteger(start, 'start', 1, sequence.length);
    requireInteger(end, 'end', 1, sequence.length);
    if (start > end) throw new MolbioInputError('delete needs start <= end (1-based inclusive)');
    const result = sequence.slice(0, start - 1) + sequence.slice(end);
    notes.push(`deleted ${end - start + 1} bp at ${start}-${end}`);
    return { operation, input_length: sequence.length, output_length: result.length, sequences: [result.length === 0 ? '' : result], notes };
  }

  if (operation === 'replace') {
    requireInteger(start, 'start', 1, sequence.length);
    requireInteger(end, 'end', 1, sequence.length);
    if (start > end) throw new MolbioInputError('replace needs start <= end (1-based inclusive)');
    const fragment = normalizeSequence(replacement ?? '', 'replacement');
    const result = sequence.slice(0, start - 1) + fragment + sequence.slice(end);
    notes.push(`replaced ${end - start + 1} bp at ${start}-${end} with ${fragment.length} bp`);
    return { operation, input_length: sequence.length, output_length: result.length, sequences: [result], notes };
  }

  if (operation === 'split') {
    requireInteger(position, 'position', 1, sequence.length - 1);
    notes.push(`split after base ${position} (1-based; both parts are inclusive)`);
    return {
      operation,
      input_length: sequence.length,
      output_length: position,
      sequences: [sequence.slice(0, position), sequence.slice(position)],
      notes,
    };
  }

  // join
  if (typeof joinWith !== 'string' || joinWith.trim() === '') throw new MolbioInputError('join needs join_with (the second sequence)');
  const second = normalizeSequence(joinWith, 'join_with');
  requireInteger(overlap, 'overlap', 0, Math.min(sequence.length, second.length));
  if (overlap > 0 && sequence.slice(sequence.length - overlap) !== second.slice(0, overlap)) {
    throw new MolbioInputError(`join overlap ${overlap} does not match: the first sequence must end with the second sequence\'s first ${overlap} bases`);
  }
  const result = sequence + second.slice(overlap);
  notes.push(overlap > 0 ? `joined with a verified ${overlap} bp exact overlap` : 'joined end to end (no overlap)');
  return { operation, input_length: sequence.length, output_length: result.length, sequences: [result], notes };
}

export const SEQUENCE_OPS_FORMATS = FORMATS;
export const SEQUENCE_OPS_OPERATIONS = OPERATIONS;