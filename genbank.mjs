/**
 * dsh-molbio-tools/genbank.mjs
 *
 * Minimal GenBank flatfile parser: LOCUS / DEFINITION / ACCESSION / FEATURES /
 * ORIGIN. Locations are reduced to a start/end span plus strand
 * (complement()/join()/order() handled for span purposes); qualifiers keep
 * /gene, /product, /label, /note. Pure text processing, no dependencies.
 */

import { MolbioInputError, normalizeSequence } from './lib.mjs';

/** Parse one LOCUS header line. */
function parseLocus(line) {
  const match = /^LOCUS\s+(\S+)\s+(\d+)\s+bp\s+(?:ss-|ds-|ms-)?(\S+)\s*(?:linear|circular)?/i.exec(line);
  if (match === null) return undefined;
  const topology = /circular/i.test(line) ? 'circular' : /linear/i.test(line) ? 'linear' : undefined;
  return {
    name: match[1],
    length: Number(match[2]),
    topology,
  };
}

/**
 * Parse a raw feature location into a numeric span and strand.
 * Handles: plain spans, complement(), join(), order(), one-of, single bases,
 * and partial markers (<, >, ?, ^).
 */
function parseLocation(raw) {
  const cleaned = raw.replace(/[<>\?^]/g, '');
  const numbers = [...cleaned.matchAll(/\d+/g)].map((match) => Number(match[0]));
  if (numbers.length === 0) return undefined;
  return {
    start: Math.min(...numbers),
    end: Math.max(...numbers),
    strand: /complement/i.test(raw) ? -1 : 1,
    raw: raw.trim(),
  };
}

/** Parse one qualifier line:  /key="value"  (or unquoted value). */
function parseQualifier(line) {
  const match = /^\s*\/?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|(\S+))/.exec(line);
  if (match === null) return undefined;
  return { key: match[1].toLowerCase(), value: (match[2] ?? match[3] ?? '').trim() };
}

/**
 * Parse a GenBank flatfile.
 * @param {string} text - the whole record.
 * @returns {object} { name, accession, definition, length, topology, features, sequence }
 */
export function parseGenBank(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new MolbioInputError('genbank text must be a non-empty string');
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const locusIndex = lines.findIndex((line) => /^LOCUS\s/.test(line));
  if (locusIndex === -1) throw new MolbioInputError('not a GenBank record: missing LOCUS line');
  const locus = parseLocus(lines[locusIndex]);
  if (locus === undefined) throw new MolbioInputError('could not parse the LOCUS line');

  let accession = '';
  let definition = '';
  const features = [];
  const sequenceChunks = [];

  let inFeatures = false;
  let inOrigin = false;
  let currentFeature = undefined;
  let currentQualifier = undefined;

  for (let i = locusIndex; i < lines.length; i++) {
    const line = lines[i];
    if (inOrigin) {
      if (/^\/\//.test(line)) break;
      sequenceChunks.push(line.replace(/[\s\d]/g, ''));
      continue;
    }
    if (inFeatures) {
      if (/^ORIGIN/.test(line)) {
        inFeatures = false;
        inOrigin = true;
        continue;
      }
      if (/^\s{5}\S/.test(line)) {
        // New feature: 5 spaces, then type and location.
        const match = /^\s{5}(\S+)\s*(.*)$/.exec(line);
        if (match === null) continue;
        currentFeature = {
          type: match[1],
          location: parseLocation(match[2] ?? ''),
          qualifiers: {},
        };
        if (currentFeature.location === undefined) continue; // unparseable location: skip the feature
        features.push(currentFeature);
        continue;
      }
      if (/^\s{21}\//.test(line) && currentFeature !== undefined) {
        const parsed = parseQualifier(line);
        if (parsed === undefined) continue;
        currentQualifier = { key: parsed.key, value: parsed.value };
        if (currentFeature.qualifiers[currentQualifier.key] === undefined) {
          currentFeature.qualifiers[currentQualifier.key] = currentQualifier.value;
        }
        continue;
      }
      if (/^\s{21}[^\s/]/.test(line) && currentQualifier !== undefined && currentFeature !== undefined) {
        // Continuation of a quoted qualifier value.
        currentFeature.qualifiers[currentQualifier.key] += line.trim();
        continue;
      }
      continue;
    }
    // Header fields before FEATURES.
    if (/^FEATURES/.test(line)) {
      inFeatures = true;
      continue;
    }
    if (/^ACCESSION\s/.test(line)) {
      accession = line.replace(/^ACCESSION\s+/, '').split(/\s+/)[0];
      continue;
    }
    if (/^DEFINITION\s/.test(line)) {
      definition = line.replace(/^DEFINITION\s+/, '').trim();
      // Wrapped continuation lines keep the same leading column.
      let j = i + 1;
      while (j < lines.length && /^\s{12}\S/.test(lines[j])) {
        definition += ' ' + lines[j].trim();
        j++;
      }
      i = j - 1;
      continue;
    }
  }

  let sequence = '';
  if (sequenceChunks.length > 0) {
    try {
      sequence = normalizeSequence(sequenceChunks.join(''), 'genbank sequence');
    } catch (error) {
      throw new MolbioInputError(`ORIGIN sequence could not be read: ${error.message}`);
    }
  }

  const projected = features.map((feature) => {
    const q = feature.qualifiers;
    const label = q.product ?? q.gene ?? q.label ?? q.locus_tag ?? feature.type;
    return {
      type: feature.type,
      start: feature.location.start,
      end: feature.location.end,
      strand: feature.location.strand,
      label,
      ...q.gene !== undefined ? { gene: q.gene } : {},
      ...q.product !== undefined ? { product: q.product } : {},
      ...q.note !== undefined ? { note: q.note } : {},
    };
  });

  return {
    name: locus.name,
    ...accession !== '' ? { accession } : {},
    ...definition !== '' ? { definition } : {},
    length: sequence !== '' ? sequence.length : locus.length,
    ...locus.topology !== undefined ? { topology: locus.topology } : {},
    features: projected,
    sequence,
  };
}
