/**
 * dsh-molbio-tools/seqio.mjs
 *
 * FASTA / FASTQ parsing and FASTA writing. Pure text processing; the tools
 * read files through the harness fs service and pass the decoded text here.
 */

import { MolbioInputError } from './lib.mjs';

function cleanSequence(text) {
  return text.toUpperCase().replace(/[\s\d]+/g, '');
}

/**
 * Parse FASTA text.
 * @returns {Array<{id: string, description: string, sequence: string}>}
 */
export function parseFasta(text) {
  const entries = [];
  let current = undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('>')) {
      if (current !== undefined && current.sequence !== '') entries.push(current);
      const header = line.slice(1).trim();
      const space = header.search(/\s/);
      current = {
        id: space === -1 ? header : header.slice(0, space),
        description: space === -1 ? '' : header.slice(space + 1),
        sequence: '',
      };
      continue;
    }
    if (current === undefined) throw new MolbioInputError('not valid FASTA: sequence data before the first header');
    current.sequence += cleanSequence(line);
  }
  if (current !== undefined && current.sequence !== '') entries.push(current);
  if (entries.length === 0) throw new MolbioInputError('no FASTA entries found');
  return entries;
}

/**
 * Parse FASTQ text (4-line blocks; tolerates multi-line sequences).
 * @returns {Array<{id: string, description: string, sequence: string, quality: string}>}
 */
export function parseFastq(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    if (header === undefined || header === '') break;
    if (!header.startsWith('@')) throw new MolbioInputError(`not valid FASTQ at line ${i + 1}: expected a header starting with "@"`);
    i++;
    let sequence = '';
    while (i < lines.length && !lines[i].startsWith('+')) {
      sequence += cleanSequence(lines[i]);
      i++;
    }
    if (i >= lines.length) throw new MolbioInputError(`not valid FASTQ: missing "+" line for ${header}`);
    i++;
    let quality = '';
    while (quality.length < sequence.length && i < lines.length) {
      quality += lines[i].trim();
      i++;
    }
    if (quality.length < sequence.length) throw new MolbioInputError(`not valid FASTQ: quality shorter than sequence for ${header}`);
    const idPart = header.slice(1).trim();
    const space = idPart.search(/\s/);
    entries.push({
      id: space === -1 ? idPart : idPart.slice(0, space),
      description: space === -1 ? '' : idPart.slice(space + 1),
      sequence,
      quality: quality.slice(0, sequence.length),
    });
  }
  if (entries.length === 0) throw new MolbioInputError('no FASTQ entries found');
  return entries;
}

/** Render entries as FASTA text. */
export function toFasta(entries) {
  return entries.map((entry) => `>${entry.id}${entry.description !== '' ? ' ' + entry.description : ''}\n${entry.sequence}`).join('\n') + '\n';
}

/** Summary statistics over parsed entries. */
export function entryStats(entries, qualityMode = false) {
  const lengths = entries.map((entry) => entry.sequence.length);
  let gc = 0;
  let at = 0;
  for (const entry of entries) {
    for (const base of entry.sequence) {
      if (base === 'G' || base === 'C') gc++;
      else if (base === 'A' || base === 'T') at++;
    }
  }
  const stats = {
    entries: entries.length,
    total_bases: lengths.reduce((sum, len) => sum + len, 0),
    min_length: Math.min(...lengths),
    max_length: Math.max(...lengths),
    mean_length: Math.round((lengths.reduce((sum, len) => sum + len, 0) / lengths.length) * 100) / 100,
    gc_percent: gc + at === 0 ? 0 : Math.round((gc / (gc + at)) * 1000) / 10,
  };
  if (qualityMode) {
    const allQ = entries.flatMap((entry) => [...entry.quality].map((ch) => ch.charCodeAt(0) - 33));
    if (allQ.length > 0) {
      const mean = allQ.reduce((sum, q) => sum + q, 0) / allQ.length;
      const low = allQ.filter((q) => q < 20).length / allQ.length;
      stats.quality_mean = Math.round(mean * 100) / 100;
      stats.quality_min = Math.min(...allQ);
      stats.quality_max = Math.max(...allQ);
      stats.low_quality_fraction = Math.round(low * 1000) / 1000;
      const maxLen = Math.min(150, Math.max(...entries.map((e) => e.sequence.length)));
      const perPosition = [];
      for (let pos = 0; pos < maxLen; pos++) {
        const values = entries.filter((e) => e.sequence.length > pos).map((e) => e.quality.charCodeAt(pos) - 33);
        if (values.length === 0) break;
        perPosition.push(Math.round((values.reduce((s, q) => s + q, 0) / values.length) * 100) / 100);
      }
      stats.quality_per_position_mean = perPosition;
    }
  }
  return stats;
}
