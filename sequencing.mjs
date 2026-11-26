/**
 * dsh-molbio-tools/sequencing.mjs
 *
 * Read-set interpretation for Sanger work:
 *   - assemble several reads into one quality-aware consensus contig
 *     (greedy overlap-layout, both orientations, exact-overlap circular closure
 *     when asked);
 *   - collapse reads aligned to a reference into allele clusters and classify
 *     each cluster's protein effect inside an optional CDS.
 *
 * Both are read-level methods. They do NOT deconvolve mixed Sanger peaks: the
 * editing tool groups reads by the variants each read carries, and its
 * frequencies are fractions of the aligned reads — not TIDE's peak model.
 */

import { CODON_TABLE, MolbioInputError, normalizeSequence, reverseComplement } from './lib.mjs';
import { alignToReference } from './align.mjs';

export const SEQUENCING_LIMITS = {
  maxReads: 24,
  maxReadLength: 5000,
  minReadLength: 15,
};

const DEFAULT_QUALITY = 30;

function validateReads(reads, label) {
  if (!Array.isArray(reads) || reads.length === 0) throw new MolbioInputError(`${label} needs at least one read`);
  if (reads.length > SEQUENCING_LIMITS.maxReads) throw new MolbioInputError(`${reads.length} ${label} exceeds the limit of ${SEQUENCING_LIMITS.maxReads}`);
  return reads.map((read, index) => {
    if (read === null || typeof read !== 'object') throw new MolbioInputError(`read ${index + 1} must be an object with a sequence`);
    const sequence = normalizeSequence(read.sequence, `read ${index + 1}`);
    if (sequence.length > SEQUENCING_LIMITS.maxReadLength) throw new MolbioInputError(`read ${index + 1} is ${sequence.length} bases; the limit is ${SEQUENCING_LIMITS.maxReadLength}`);
    let qualities;
    if (read.qualities !== undefined) {
      if (!Array.isArray(read.qualities) || read.qualities.length !== sequence.length) throw new MolbioInputError(`read ${index + 1} qualities must be an array with one value per base`);
      qualities = read.qualities.map((q) => Number(q));
      if (qualities.some((q) => !Number.isFinite(q) || q < 0 || q > 100)) throw new MolbioInputError(`read ${index + 1} qualities must be numbers between 0 and 100`);
    }
    return { name: String(read.name ?? `read${index + 1}`), sequence, qualities };
  });
}

function trimByQuality(sequence, qualities, minQuality) {
  if (qualities === undefined || !(minQuality > 0)) return { sequence, qualities, trimmedStart: 0, trimmedEnd: 0 };
  let start = 0;
  let end = sequence.length;
  while (start < end && qualities[start] < minQuality) start++;
  while (end > start && qualities[end - 1] < minQuality) end--;
  return {
    sequence: sequence.slice(start, end),
    qualities: qualities.slice(start, end),
    trimmedStart: start,
    trimmedEnd: sequence.length - end,
  };
}

/** Longest acceptable suffix(a)/prefix(b) overlap, or null. */
function rightOverlap(a, b, { minOverlap, maxOverlap, maxMismatchFraction }) {
  const max = Math.min(maxOverlap, a.length, b.length);
  for (let overlap = max; overlap >= minOverlap; overlap--) {
    const allowed = Math.floor(overlap * maxMismatchFraction);
    let mismatches = 0;
    let ok = true;
    for (let i = 0; i < overlap; i++) {
      if (a[a.length - overlap + i] !== b[i]) {
        mismatches++;
        if (mismatches > allowed) { ok = false; break; }
      }
    }
    if (ok) return { overlap, mismatches };
  }
  return null;
}

function consensusOf(placed) {
  let minOffset = Infinity;
  let maxEnd = -Infinity;
  for (const read of placed) {
    minOffset = Math.min(minOffset, read.offset);
    maxEnd = Math.max(maxEnd, read.offset + read.sequence.length);
  }
  const length = maxEnd - minOffset;
  const bases = [];
  const scores = [];
  for (let column = 0; column < length; column++) {
    const totals = new Map();
    let depth = 0;
    for (const read of placed) {
      const index = column - read.offset;
      if (index < 0 || index >= read.sequence.length) continue;
      depth++;
      const base = read.sequence[index];
      const quality = read.qualities?.[index] ?? DEFAULT_QUALITY;
      totals.set(base, (totals.get(base) ?? 0) + quality);
    }
    let bestBase = null;
    let bestScore = -Infinity;
    for (const [base, score] of totals) {
      if (score > bestScore || (score === bestScore && bestBase !== null && base < bestBase)) {
        bestBase = base;
        bestScore = score;
      }
    }
    bases.push(bestBase);
    scores.push(depth);
  }
  return {
    sequence: bases.join(''),
    placed: placed.map((read) => ({ ...read, offset: read.offset - minOffset })),
    columnCounts: scores,
  };
}

function overlapsOf(contig, read, options) {
  const right = rightOverlap(contig, read, options);
  const left = rightOverlap(read, contig, options);
  return {
    right: right === null ? null : { ...right, side: 'right' },
    left: left === null ? null : { ...left, side: 'left' },
  };
}

function circularClosure(contig, options) {
  const max = Math.min(options.maxOverlap, Math.floor(contig.length / 3));
  for (let overlap = max; overlap >= options.minOverlap; overlap--) {
    const allowed = Math.floor(overlap * options.maxMismatchFraction);
    let mismatches = 0;
    for (let i = 0; i < overlap; i++) {
      if (contig[contig.length - overlap + i] !== contig[i]) mismatches++;
    }
    if (mismatches <= allowed) return { overlap, mismatches };
  }
  return null;
}

/**
 * Greedy overlap-layout assembly of a handful of Sanger reads.
 *
 * Reads are tried in both orientations; the longest acceptable overlap wins,
 * ties are broken by fewer mismatches, then by read name so the result is
 * deterministic. After every placement the contig is rebuilt from the quality-
 * weighted consensus, so a low-quality miscall cannot silently propagate.
 */
export function assembleReads(reads, options = {}) {
  const input = validateReads(reads, 'assembly');
  const minOverlap = options.minOverlap ?? 20;
  if (!Number.isInteger(minOverlap) || minOverlap < 5 || minOverlap > 500) throw new MolbioInputError('min_overlap must be an integer between 5 and 500');
  const maxOverlap = options.maxOverlap ?? 250;
  if (!Number.isInteger(maxOverlap) || maxOverlap < minOverlap || maxOverlap > 2000) throw new MolbioInputError('max_overlap must be an integer between min_overlap and 2000');
  const maxMismatchFraction = options.maxMismatchFraction ?? 0.1;
  if (!(typeof maxMismatchFraction === 'number') || maxMismatchFraction < 0 || maxMismatchFraction > 0.5) throw new MolbioInputError('max_mismatch_fraction must be a number between 0 and 0.5');
  const trimQuality = options.trimQuality ?? 20;
  if (!(typeof trimQuality === 'number') || trimQuality < 0 || trimQuality > 60) throw new MolbioInputError('trim_quality must be a number between 0 (off) and 60');
  const circular = options.circular === true;

  const prepared = [];
  const dropped = [];
  for (const read of input) {
    const trimmed = trimByQuality(read.sequence, read.qualities, trimQuality);
    if (trimmed.sequence.length < SEQUENCING_LIMITS.minReadLength) {
      dropped.push({ name: read.name, reason: `only ${trimmed.sequence.length} bases left after quality trimming` });
      continue;
    }
    prepared.push({ ...read, ...trimmed, originalLength: read.sequence.length });
  }
  if (prepared.length === 0) throw new MolbioInputError('every read was shorter than the minimum after quality trimming');

  const optionsForOverlap = { minOverlap, maxOverlap, maxMismatchFraction };
  prepared.sort((a, b) => b.sequence.length - a.sequence.length || a.name.localeCompare(b.name));
  const placed = [{ ...prepared[0], offset: 0, orientation: 'forward', overlapLeft: 0, overlapRight: 0, mismatchesLeft: 0, mismatchesRight: 0 }];
  let contig = prepared[0].sequence;
  const remaining = prepared.slice(1);

  while (remaining.length > 0) {
    let best = null;
    for (const read of remaining) {
      for (const orientation of ['forward', 'reverse']) {
        const sequence = orientation === 'forward' ? read.sequence : reverseComplement(read.sequence);
        const qualities = orientation === 'forward' ? read.qualities : read.qualities === undefined ? undefined : [...read.qualities].reverse();
        for (const [side, overlap] of Object.entries(overlapsOf(contig, sequence, optionsForOverlap))) {
          if (overlap === null) continue;
          const score = overlap.overlap - 2 * overlap.mismatches;
          const candidate = { read, sequence, qualities, orientation, side, ...overlap, score };
          if (best === null || candidate.score > best.score
            || (candidate.score === best.score && candidate.overlap > best.overlap)
            || (candidate.score === best.score && candidate.overlap === best.overlap && candidate.read.name < best.read.name)) {
            best = candidate;
          }
        }
      }
    }
    if (best === null) break;
    const offset = best.side === 'right' ? contig.length - best.overlap : -best.overlap;
    placed.push({
      name: best.read.name,
      sequence: best.sequence,
      qualities: best.qualities,
      trimmedStart: best.read.trimmedStart,
      trimmedEnd: best.read.trimmedEnd,
      originalLength: best.read.originalLength,
      offset,
      orientation: best.orientation,
      overlapLeft: best.side === 'left' ? best.overlap : 0,
      overlapRight: best.side === 'right' ? best.overlap : 0,
      mismatchesLeft: best.side === 'left' ? best.mismatches : 0,
      mismatchesRight: best.side === 'right' ? best.mismatches : 0,
    });
    remaining.splice(remaining.indexOf(best.read), 1);
    const rebuilt = consensusOf(placed);
    contig = rebuilt.sequence;
    placed.length = 0;
    placed.push(...rebuilt.placed);
  }

  const rebuilt = consensusOf(placed);
  contig = rebuilt.sequence;
  const finalPlaced = rebuilt.placed;

  let conflicts = 0;
  const conflictPositions = [];
  for (const read of finalPlaced) {
    for (let i = 0; i < read.sequence.length; i++) {
      const column = read.offset + i;
      if (column >= 0 && column < contig.length && read.sequence[i] !== contig[column]) {
        conflicts++;
        if (conflictPositions.length < 50) conflictPositions.push(column + 1);
      }
    }
  }

  let circularClosureResult = null;
  if (circular) {
    circularClosureResult = circularClosure(contig, { minOverlap, maxOverlap, maxMismatchFraction });
    if (circularClosureResult !== null) contig = contig.slice(0, contig.length - circularClosureResult.overlap);
  }

  const coverage = rebuilt.columnCounts;
  const coverageMean = coverage.reduce((sum, n) => sum + n, 0) / coverage.length;
  const coverageMin = coverage.reduce((min, n) => Math.min(min, n), Infinity);
  const readsOut = finalPlaced.map((read) => ({
    name: read.name,
    orientation: read.orientation,
    start: read.offset + 1,
    end: read.offset + read.sequence.length,
    length: read.sequence.length,
    trimmed_bases: read.trimmedStart + read.trimmedEnd,
    overlap_left: read.overlapLeft,
    overlap_right: read.overlapRight,
    mismatches: read.mismatchesLeft + read.mismatchesRight,
  })).sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));

  const unplaced = remaining.map((read) => ({ name: read.name, reason: 'no acceptable overlap with the growing contig' }));
  const notes = [
    'Consensus is quality-weighted (Phred from .ab1; 30 where a plain sequence carries no qualities).',
    'This is a greedy overlap-layout consensus for a handful of Sanger reads, not a genome assembler; repeats longer than min_overlap can collapse.',
  ];
  if (circular && circularClosureResult === null) notes.push('circular closure was requested but no acceptable end overlap was found; the contig is linear');
  if (circularClosureResult !== null) notes.push('coverage and read offsets describe the assembled linear contig before the closing overlap was removed');
  if (dropped.length > 0) notes.push(`${dropped.length} read(s) were dropped before assembly (see unplaced)`);

  return {
    name: options.name ?? 'contig',
    sequence: contig,
    length: contig.length,
    read_count: input.length,
    placed_count: finalPlaced.length,
    coverage_mean: Math.round(coverageMean * 100) / 100,
    coverage_min: Number.isFinite(coverageMin) ? coverageMin : 0,
    conflicts,
    conflict_positions: conflictPositions,
    circular_requested: circular,
    circularized: circularClosureResult !== null,
    circular_overlap: circularClosureResult === null ? 0 : circularClosureResult.overlap,
    reads: readsOut,
    unplaced: [...dropped, ...unplaced],
    notes,
  };
}

// ── editing outcome clustering (#31) ───────────────────────────────────────

/** Collapse consecutive differences into variant records. */
function describeVariants(differences) {
  const sorted = [...differences].sort((a, b) => a.ref_pos - b.ref_pos || (a.trace_pos ?? 0) - (b.trace_pos ?? 0));
  const variants = [];
  let i = 0;
  while (i < sorted.length) {
    const current = sorted[i];
    if (current.kind === 'mismatch') {
      variants.push({ kind: 'mismatch', position: current.ref_pos, ref: current.ref_base, alt: current.trace_base, length: 1 });
      i++;
    } else if (current.kind === 'deletion') {
      let end = current.ref_pos;
      let ref = current.ref_base;
      let j = i + 1;
      while (j < sorted.length && sorted[j].kind === 'deletion' && sorted[j].ref_pos === end + 1) {
        end = sorted[j].ref_pos;
        ref += sorted[j].ref_base;
        j++;
      }
      variants.push({ kind: 'deletion', position: current.ref_pos, end, ref, alt: '', length: end - current.ref_pos + 1 });
      i = j;
    } else {
      let alt = current.trace_base;
      let j = i + 1;
      while (j < sorted.length && sorted[j].kind === 'insertion' && sorted[j].ref_pos === current.ref_pos
        && sorted[j].trace_pos === sorted[j - 1].trace_pos + 1) {
        alt += sorted[j].trace_base;
        j++;
      }
      variants.push({ kind: 'insertion', position: current.ref_pos, ref: '', alt, length: alt.length });
      i = j;
    }
  }
  return variants;
}

function labelOf(variants) {
  if (variants.length === 0) return 'wild type';
  return variants.map((variant) => variant.kind === 'mismatch'
    ? `${variant.ref}${variant.position}${variant.alt}`
    : variant.kind === 'deletion'
      ? (variant.length === 1 ? `del ${variant.position}` : `del ${variant.position}-${variant.end}`)
      : `ins ${variant.alt} at ${variant.position}`).join(' + ');
}

function signatureOf(variants) {
  if (variants.length === 0) return 'wild_type';
  return variants.map((v) => v.kind === 'insertion'
    ? `ins:${v.position}:${v.alt}`
    : v.kind === 'deletion'
      ? `del:${v.position}:${v.end}`
      : `sub:${v.position}:${v.ref}>${v.alt}`).join('|');
}

function translateCds(cds) {
  let protein = '';
  const table = CODON_TABLE.standard;
  for (let i = 0; i + 3 <= cds.length; i += 3) protein += table[cds.slice(i, i + 3)] ?? 'X';
  return protein;
}

/** Apply variants (positions relative to the CDS, 1-based) to a CDS. */
function mutateCds(cds, variants) {
  let out = '';
  let cursor = 1;
  for (const variant of [...variants].sort((a, b) => a.position - b.position)) {
    if (variant.position < cursor) continue;
    if (variant.kind === 'mismatch') {
      out += cds.slice(cursor - 1, variant.position - 1) + variant.alt;
      cursor = variant.position + 1;
    } else if (variant.kind === 'deletion') {
      out += cds.slice(cursor - 1, variant.position - 1);
      cursor = variant.end + 1;
    } else {
      out += cds.slice(cursor - 1, variant.position - 1) + variant.alt;
      cursor = variant.position;
    }
  }
  out += cds.slice(cursor - 1);
  return out;
}

function classifyEffect(reference, cdsStart, cdsEnd, variants) {
  if (cdsStart === undefined || cdsEnd === undefined) return { effect: 'not_evaluated', protein_change: '' };
  const inCds = variants.filter((variant) => {
    const end = variant.kind === 'deletion' ? variant.end : variant.position;
    return variant.position <= cdsEnd && end >= cdsStart;
  });
  if (inCds.length === 0) return { effect: 'outside_cds', protein_change: '' };
  const relative = inCds.map((variant) => ({
    ...variant,
    position: variant.position - cdsStart + 1,
    ...variant.kind === 'deletion' ? { end: variant.end - cdsStart + 1 } : {},
  }));
  const referenceCds = reference.slice(cdsStart - 1, cdsEnd);
  const mutatedCds = mutateCds(referenceCds, relative);
  const referenceProtein = translateCds(referenceCds);
  const mutatedProtein = translateCds(mutatedCds);
  // Net length change, not the per-variant lengths: a deletion can be split
  // across two alignment gaps without changing what it does to the frame.
  if ((mutatedCds.length - referenceCds.length) % 3 !== 0) return { effect: 'frameshift', protein_change: '' };
  // A length change that is a multiple of 3 is the event itself; whether the
  // shifted stop looks 'early' is a consequence, not a second mutation.
  if (mutatedCds.length !== referenceCds.length) return { effect: 'in_frame_indel', protein_change: '' };
  if (mutatedProtein === referenceProtein) return { effect: 'silent', protein_change: '' };
  const firstDifference = [...referenceProtein].findIndex((aa, index) => aa !== mutatedProtein[index]);
  const change = firstDifference === -1 ? '' : `${referenceProtein[firstDifference]}${firstDifference + 1}${mutatedProtein[firstDifference] ?? '*'}`;
  const referenceStop = referenceProtein.indexOf('*');
  const mutatedStop = mutatedProtein.indexOf('*');
  if (mutatedStop !== -1 && (referenceStop === -1 || mutatedStop < referenceStop)) return { effect: 'nonsense', protein_change: change };
  return { effect: 'missense', protein_change: change };
}

/**
 * Collapse a read set into allele clusters against a reference.
 *
 * Each read is aligned in both orientations and the better one is kept; reads
 * below `identity_threshold` are counted as unaligned rather than forced into
 * an allele. Clusters are exact variant signatures, so two reads with the same
 * edit group together; the reported frequency is a fraction of the ALIGNED
 * reads. This is a read-fraction method, not TIDE's mixed-peak decomposition.
 */
export function callEditingOutcomes(reads, reference, options = {}) {
  const ref = normalizeSequence(reference, 'reference');
  const input = validateReads(reads, 'editing-outcome analysis');
  const circular = options.circular !== false;
  const minFrequency = options.minFrequency ?? 0.01;
  if (!(typeof minFrequency === 'number') || minFrequency < 0 || minFrequency > 1) throw new MolbioInputError('min_frequency must be a number between 0 and 1');
  const identityThreshold = options.identityThreshold ?? 0.6;
  if (!(typeof identityThreshold === 'number') || identityThreshold < 0 || identityThreshold > 1) throw new MolbioInputError('identity_threshold must be a number between 0 and 1');
  const cdsStart = options.cdsStart;
  const cdsEnd = options.cdsEnd;
  if ((cdsStart === undefined) !== (cdsEnd === undefined)) throw new MolbioInputError('give both cds_start and cds_end, or neither');
  if (cdsStart !== undefined) {
    if (!Number.isInteger(cdsStart) || !Number.isInteger(cdsEnd) || cdsStart < 1 || cdsEnd > ref.length || cdsStart > cdsEnd) {
      throw new MolbioInputError(`invalid CDS span ${cdsStart}-${cdsEnd} (reference length ${ref.length})`);
    }
  }

  const aligned = [];
  const unaligned = [];
  for (const read of input) {
    let best = null;
    for (const orientation of ['forward', 'reverse']) {
      const sequence = orientation === 'forward' ? read.sequence : reverseComplement(read.sequence);
      try {
        const result = alignToReference(sequence, ref, circular);
        if (best === null || result.identity_percent > best.result.identity_percent) {
          best = { orientation, sequence, result };
        }
      } catch {
        /* try the other orientation; a read with no local alignment is unaligned */
      }
    }
    const minimumSpan = Math.min(read.sequence.length, Math.max(20, Math.floor(read.sequence.length * 0.5)));
    if (best === null || best.result.identity_percent < identityThreshold * 100 || best.result.aligned_columns < minimumSpan) {
      unaligned.push({ name: read.name, identity: best === null ? 0 : best.result.identity_percent });
      continue;
    }
    const variants = describeVariants(best.result.differences);
    aligned.push({ name: read.name, orientation: best.orientation, identity: best.result.identity_percent, variants, signature: signatureOf(variants) });
  }
  if (aligned.length === 0) throw new MolbioInputError('no read aligned to the reference; check that the reference is the right molecule');

  const groups = new Map();
  for (const read of aligned) {
    const group = groups.get(read.signature) ?? { signature: read.signature, variants: read.variants, count: 0, identities: [], representative: read.name };
    group.count++;
    group.identities.push(read.identity);
    groups.set(read.signature, group);
  }

  const alleles = [];
  for (const group of groups.values()) {
    const frequency = group.count / aligned.length;
    const effect = group.signature === 'wild_type'
      ? { effect: 'wild_type', protein_change: '' }
      : classifyEffect(ref, cdsStart, cdsEnd, group.variants);
    let from = null;
    let to = null;
    for (const variant of group.variants) {
      const start = variant.position;
      const end = variant.kind === 'deletion' ? variant.end : variant.position;
      from = from === null ? start : Math.min(from, start);
      to = to === null ? end : Math.max(to, end);
    }
    const meanIdentity = group.identities.reduce((sum, value) => sum + value, 0) / group.identities.length;
    alleles.push({
      signature: group.signature,
      label: labelOf(group.variants),
      count: group.count,
      frequency: Math.round(frequency * 10000) / 10000,
      variants: group.variants,
      variant_count: group.variants.length,
      edited_from: from ?? 0,
      edited_to: to ?? 0,
      effect: effect.effect,
      protein_change: effect.protein_change,
      representative: group.representative,
      mean_identity: Math.round(meanIdentity * 100) / 100,
    });
  }
  alleles.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  const reported = alleles.filter((allele) => allele.frequency >= minFrequency);
  const notes = [
    'Alleles are exact variant signatures over the aligned read span; frequencies are fractions of the aligned reads.',
    'This is read-fraction clustering, not TIDE: mixed Sanger peaks inside one trace are not decomposed.',
    'A read must align over at least half its length (minimum 20 bases) as well as pass the identity threshold, so a short spurious local match cannot become an allele.',
    'Variants are called only inside each read\'s aligned span; a read end that fails to align is not reported as an edit.',
  ];
  if (circular) notes.push('the reference is treated as circular (reads spanning the origin align against a doubled reference)');
  if (cdsStart !== undefined) notes.push('effect is classified inside the given CDS; variants outside it are reported but do not change the call');
  if (reported.length < alleles.length) notes.push(`${alleles.length - reported.length} allele(s) below min_frequency were omitted`);
  // The failure this catches: a hand-copied reference that is actually one of the
  // reads (or a trimmed copy of it) makes every read look edited. A fully edited
  // sample legitimately has no wild-type read too, so the note is phrased as a
  // check, not as an error.
  if (!alleles.some((allele) => allele.signature === 'wild_type')) {
    notes.push('no read matches the reference exactly; this is expected for a fully edited sample, but if you expected wild-type reads, check that `reference` is the COMPLETE molecule and not one of the reads or a trimmed copy');
  }

  return {
    reference_length: ref.length,
    circular,
    total_reads: input.length,
    aligned_reads: aligned.length,
    unaligned_reads: unaligned.length,
    unaligned,
    alleles: reported,
    allele_count: reported.length,
    cds_start: cdsStart ?? 0,
    cds_end: cdsEnd ?? 0,
    notes,
  };
}