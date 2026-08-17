/**
 * dsh-molbio-tools/sanger.mjs
 *
 * Sanger sequencing support: ABIF (.ab1) binary parsing (base calls + quality
 * values), plain .seq/.txt trace reading, and clone verification against a
 * reference (circular-aware alignment via align.mjs).
 */

import { CODON_TABLE, MolbioInputError, normalizeSequence } from './lib.mjs';
import { alignToReference } from './align.mjs';

// ── ABIF parsing ────────────────────────────────────────────────────────────

/**
 * Parse an ABIF file (.ab1): return called bases and, when present, per-base
 * quality values. Prefers PBAS2 (edited calls) over PBAS1, PCON2 over PCON1.
 * @param {Uint8Array} bytes
 */
export function parseAbif(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 28) {
    throw new MolbioInputError('not an ABIF file (too short)');
  }
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'ABIF') {
    throw new MolbioInputError('not an ABIF file (missing magic)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getInt32(18);
  // Directory may start at 28 (ABI standard) with small variations in the wild.
  const candidates = [28, 26, 30, 32];
  let dirStart = -1;
  for (const candidate of candidates) {
    if (entryCount <= 0 || entryCount * 28 + candidate > bytes.length) continue;
    let namesOk = true;
    for (let i = 0; i < Math.min(3, entryCount); i++) {
      const name = String.fromCharCode(...bytes.slice(candidate + i * 28, candidate + i * 28 + 4));
      if (!/^[A-Za-z0-9 ]{4}$/.test(name)) {
        namesOk = false;
        break;
      }
    }
    if (namesOk) {
      dirStart = candidate;
      break;
    }
  }
  if (dirStart === -1) throw new MolbioInputError('could not locate the ABIF directory; unsupported variant');

  const entries = {};
  for (let i = 0; i < entryCount; i++) {
    const off = dirStart + i * 28;
    if (off + 28 > bytes.length) break;
    const name = String.fromCharCode(...bytes.slice(off, off + 4)).trim();
    const num = view.getInt32(off + 4);
    const elementType = view.getInt16(off + 8);
    const elementSize = view.getInt16(off + 10);
    const elementCount = view.getInt32(off + 12);
    const dataOffset = view.getInt32(off + 20);
    entries[`${name}.${num}`] = { elementType, elementSize, elementCount, dataOffset };
  }

  const basesEntry = entries['PBAS.2'] ?? entries['PBAS.1'];
  if (basesEntry === undefined) throw new MolbioInputError('no base calls found (PBAS1/PBAS2 missing)');
  const bases = readBases(bytes, basesEntry);

  const qualityEntry = entries['PCON.2'] ?? entries['PCON.1'];
  const qualities = qualityEntry === undefined ? undefined : readQualities(bytes, qualityEntry);

  return { bases, qualities };
}

function readBases(bytes, entry) {
  const { elementSize, elementCount, dataOffset } = entry;
  if (elementSize !== 1 && elementSize !== 2) throw new MolbioInputError('unsupported base-call element size');
  let out = '';
  for (let i = 0; i < elementCount; i++) {
    const code = elementSize === 1 ? bytes[dataOffset + i] : (bytes[dataOffset + i * 2] | bytes[dataOffset + i * 2 + 1] << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  const cleaned = out.toUpperCase().replace(/[\s\0]+$/g, '').trim();
  if (cleaned.length < 20 || cleaned.length > 20000) throw new MolbioInputError('ABIF base calls look invalid (unexpected length)');
  for (const base of cleaned) {
    if (!'ACGTNRYKMSWBDHV'.includes(base)) throw new MolbioInputError('ABIF base calls contain unexpected characters');
  }
  return cleaned;
}

function readQualities(bytes, entry) {
  const { elementSize, elementCount, dataOffset } = entry;
  const out = [];
  for (let i = 0; i < elementCount; i++) {
    if (elementSize === 1) out.push(bytes[dataOffset + i]);
    else if (elementSize === 2) out.push(bytes[dataOffset + i * 2] | bytes[dataOffset + i * 2 + 1] << 8);
    else return undefined;
  }
  return out.length > 0 ? out : undefined;
}

// ── trace reading ───────────────────────────────────────────────────────────

/**
 * Read a Sanger trace file by extension:
 * .ab1/.abif → ABIF; .seq/.txt/.fasta → plain text bases.
 * @param {Uint8Array} bytes - raw file content.
 * @param {string} path - used to pick the format.
 */
export function readTraceFromBytes(bytes, path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ab1') || lower.endsWith('.abif')) {
    return parseAbif(bytes);
  }
  if (lower.endsWith('.seq') || lower.endsWith('.txt') || lower.endsWith('.fasta') || lower.endsWith('.fa')) {
    const text = new TextDecoder().decode(bytes);
    let bases = text.replace(/^>.*$/gm, '').replace(/[\s\d]+/g, '').toUpperCase();
    if (bases === '') throw new MolbioInputError('the trace file contains no sequence');
    bases = normalizeSequence(bases, 'trace');
    return { bases, qualities: undefined };
  }
  throw new MolbioInputError(`unsupported trace format ${JSON.stringify(lower)}; expected .ab1, .abif, .seq, .txt, .fasta`);
}

// ── verification ────────────────────────────────────────────────────────────

/** Report amino-acid consequences of single-base changes inside a CDS window. */
function aaConsequences(reference, differences, cdsStart, cdsEnd) {
  const out = [];
  const inside = differences.filter((d) => d.kind !== 'insertion' && d.ref_pos >= cdsStart && d.ref_pos <= cdsEnd);
  for (const d of inside.slice(0, 50)) {
    if (d.kind === 'deletion') {
      out.push({ ref_pos: d.ref_pos, kind: 'frameshift', note: 'deletion shifts the reading frame' });
      continue;
    }
    // substitution: translate the original and mutated codon (frame relative to cdsStart)
    const codonIndex = Math.floor((d.ref_pos - cdsStart) / 3);
    const codonStart = cdsStart - 1 + codonIndex * 3;
    const codonEnd = codonStart + 3;
    if (codonEnd > reference.length) continue;
    const originalCodon = reference.slice(codonStart, codonEnd);
    const mutatedCodon = originalCodon.slice(0, d.ref_pos - cdsStart) + d.trace_base + originalCodon.slice(d.ref_pos - cdsStart + 1);
    const aaBefore = codonToAa(originalCodon);
    const aaAfter = codonToAa(mutatedCodon);
    out.push({
      ref_pos: d.ref_pos,
      kind: aaBefore === aaAfter ? 'silent' : aaBefore === '*' || aaAfter === '*' ? 'stop_codon_change' : 'missense',
      codon_before: originalCodon,
      codon_after: mutatedCodon,
      aa_before: aaBefore,
      aa_after: aaAfter,
    });
  }
  return out;
}

function codonToAa(codon) {
  return CODON_TABLE.standard[codon] ?? 'X';
}

/**
 * Verify a Sanger trace against a reference sequence.
 * @returns {object} aligned span, identity, differences (annotated with
 *   quality), amino-acid consequences when a CDS window is given, and a verdict.
 */
export function verifySanger({ traceBases, traceQualities, reference, circular = true, cdsStart, cdsEnd }) {
  if (traceBases.length < 20) throw new MolbioInputError('trace is too short to verify');
  const alignment = alignToReference(traceBases, reference, circular);
  const qualityAt = (tracePos) => traceQualities === undefined ? undefined : traceQualities[tracePos - 1];
  const differences = alignment.differences.map((d) => {
    const quality = d.trace_pos !== undefined ? qualityAt(d.trace_pos) : undefined;
    return quality === undefined ? { ...d } : { ...d, quality };
  });
  const lowQuality = differences.filter((d) => d.quality !== undefined && d.quality < 20);
  const highConfidence = differences.filter((d) => !(d.quality !== undefined && d.quality < 20));
  let verdict;
  if (highConfidence.length === 0 && differences.length === 0) verdict = 'match';
  else if (highConfidence.length === 0) verdict = 'match_with_low_quality_positions';
  else verdict = 'differences_found';

  const aaChanges = cdsStart !== undefined && cdsEnd !== undefined
    ? aaConsequences(reference, differences, cdsStart, cdsEnd)
    : undefined;

  const qualityMean = traceQualities === undefined || traceQualities.length === 0
    ? undefined
    : Math.round(traceQualities.reduce((sum, q) => sum + q, 0) / traceQualities.length * 10) / 10;

  return {
    verdict,
    trace_length: traceBases.length,
    reference_length: reference.length,
    aligned_span: { start: alignment.b_start + 1, end: alignment.b_end },
    identity_percent: alignment.identity_percent,
    differences,
    ...qualityMean !== undefined ? { quality_mean: qualityMean } : {},
    ...aaChanges !== undefined ? { aa_changes: aaChanges } : {},
  };
}
