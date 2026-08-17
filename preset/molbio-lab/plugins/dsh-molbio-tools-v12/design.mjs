/**
 * dsh-molbio-tools/design.mjs
 *
 * Automatic PCR primer pair design. Pure computation: scans the template for
 * forward primers, scans the reverse complement for reverse primers, then
 * pairs them within the amplicon window and ranks by Tm balance.
 */

import {
  DNA_BASES,
  MolbioInputError,
  baseCounts,
  complement,
  dimerPotential,
  findHairpins,
  findRuns,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfComplementarity,
} from './lib.mjs';

// Design-time PCR conditions for the NN Tm model.
const DESIGN_TM_OPTS = { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: 200 };

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Upper bound on how many mismatch variants are tried per window per mismatch count.
 */
const MAX_MISMATCH_VARIANTS_PER_K = 400;

/** Cap on how many PASSING variants are kept per window at the lowest mismatch count that yields any. */
const MAX_PASSING_VARIANTS_PER_WINDOW = 24;

/** Total variant evaluations allowed per window across ALL mismatch counts (k=1,2,3...). */
const MAX_MISMATCH_EVALS_PER_WINDOW = 150;

/**
 * Evaluate the full design filter chain for one primer sequence against the
 * template. Returns the candidate-quality fields on success, or
 * `{ reason, ... }` describing the FIRST failing constraint. `seq` must be
 * canonical (no IUPAC ambiguity). Reasons are cheap-first so the expensive
 * structural checks only run when the cheap ones already passed.
 */
export function evaluateSeq(seq, opts, tmCenter) {
  const {
    gcMin, gcMax, maxRun, requireGcClamp,
    maxSelfScore, maxSelfConsecutive, maxHairpinScore, tmMin, tmMax,
  } = opts;
  const { gc, at } = baseCounts(seq);
  const gcPercent = (gc / (gc + at)) * 100;
  if (gcPercent < gcMin || gcPercent > gcMax) return { reason: 'gc', gcPercent };
  if (findRuns(seq, maxRun + 1).length > 0) return { reason: 'run' };
  if (requireGcClamp && seq[seq.length - 1] !== 'G' && seq[seq.length - 1] !== 'C') return { reason: 'clamp' };
  const sc = selfComplementarity(seq);
  if (sc.bestScore > maxSelfScore || sc.bestConsecutive > maxSelfConsecutive) return { reason: 'self' };
  const hairpin = findHairpins(seq, 1)[0];
  if (hairpin !== undefined && hairpin.score > maxHairpinScore) return { reason: 'hairpin' };
  let tm;
  try {
    tm = primerTm(seq, DESIGN_TM_OPTS).tm_celsius;
  } catch {
    return { reason: 'tm' };
  }
  if (tm < tmMin || tm > tmMax) return { reason: 'tm', tm };
  return { tm: round1(tm), gc_percent: round1(gcPercent), tmDelta: Math.abs(tm - tmCenter) };
}

/**
 * Whether mismatch variants are worth attempting for a window: a handful of
 * substitutions can realistically only rescue GC balance, run breaking, or a
 * MARGINAL Tm miss — never clamp, self-complementarity, hairpins, or a Tm
 * that is far outside the window. Returning false skips the variant search
 * entirely, which keeps mismatch mode fast on large templates.
 */
function mismatchesCouldRescue(failure, seed, opts) {
  const maxMismatches = opts.maxMismatches ?? DESIGN_DEFAULTS.maxMismatches;
  // a mismatch can break a run, rebalance GC, or nudge a marginal Tm — nothing else
  if (failure.reason === 'run') return true;
  if (failure.reason === 'clamp' || failure.reason === 'self' || failure.reason === 'hairpin') return false;
  if (failure.reason === 'gc') {
    const len = seed.length;
    // each substitution moves GC% by 1/len; estimate the substitutions needed
    const needed = Math.ceil((Math.max(0, opts.gcMin - failure.gcPercent, failure.gcPercent - opts.gcMax) * len) / 100);
    return needed <= maxMismatches;
  }
  if (failure.reason === 'tm') {
    // a substitution shifts the NN Tm by roughly 1-3 °C; a miss further out
    // cannot be repaired within the mismatch budget
    const tol = 3 + 1.5 * maxMismatches;
    return failure.tm !== undefined && (failure.tm < opts.tmMin + tol || failure.tm > opts.tmMax - tol);
  }
  return false;
}

/**
 * Deterministic, bounded substitution variants of a primer window with exactly
 * `k` mismatches (v12 mismatch tolerance). Rules:
 *  - the 3'-TERMINAL base is never substituted — a terminal mismatch kills
 *    polymerase extension, so it is never offered;
 *  - the 3' critical zone (last `mismatch3PrimeZone` bases before the
 *    terminal) is off-limits unless `max3PrimeMismatches` tolerates it, and
 *    then at most that many zone positions per variant;
 *  - substitutions are TARGETED at the failing constraint: the failure reason
 *    selects which positions and which replacement bases matter (raising or
 *    lowering GC/Tm, breaking a run), so the search stays small on large
 *    templates — generic all-position enumerations would be quadratic.
 * Returns [{ sequence, offsets: [{ p, base }] }] where `p` is the 0-based
 * position in the primer (5'→3') and `base` the substituted base. Generation
 * order is deterministic (positions from the 5' side, bases sorted).
 */
export function mismatchVariants(seed, k, opts, failure) {
  const mismatch3PrimeZone = opts.mismatch3PrimeZone ?? DESIGN_DEFAULTS.mismatch3PrimeZone;
  const max3PrimeMismatches = opts.max3PrimeMismatches ?? DESIGN_DEFAULTS.max3PrimeMismatches;
  const len = seed.length;
  const zoneFrom = Math.max(1, len - mismatch3PrimeZone - 1); // 0-based index of the first 3'-zone position (distance ≤ zone)

  // Build the pool of (position → candidate bases) moves that can actually
  // repair this window's failure. Positions are ordered 5' first.
  const moves = [];
  const addMoves = (p, bases) => {
    if (p >= zoneFrom && max3PrimeMismatches < 1) return;
    moves.push({ p, zone: p >= zoneFrom, bases: bases.filter((b) => b !== seed[p]) });
  };
  if (failure.reason === 'run') {
    // break runs: substitute one base inside each run that exceeds the limit
    for (const run of findRuns(seed, opts.maxRun + 1)) {
      for (let i = run.start; i < run.start + run.count; i++) {
        addMoves(i, ['A', 'C', 'G', 'T']);
      }
    }
  } else if (failure.reason === 'gc' || failure.reason === 'tm') {
    // rebalance toward the window: raise GC/Tm by swapping A/T for C/G, or
    // lower it by swapping G/C for A/T
    let raise = false;
    let lower = false;
    if (failure.reason === 'gc') {
      raise = failure.gcPercent < opts.gcMin;
      lower = failure.gcPercent > opts.gcMax;
    } else {
      raise = failure.tm < opts.tmMin;
      lower = failure.tm > opts.tmMax;
    }
    for (let p = 0; p < len - 1; p++) {
      if (raise && (seed[p] === 'A' || seed[p] === 'T')) addMoves(p, ['C', 'G']);
      else if (lower && (seed[p] === 'G' || seed[p] === 'C')) addMoves(p, ['A', 'T']);
    }
  }

  // Bounded search: combos of k moves, capped so pathological windows stay fast.
  const pool = moves;
  if (pool.length < k) return [];

  const variants = [];
  const seen = new Set();
  const combo = [];
  const build = (comboPos, seq, offsets) => {
    if (comboPos === k) {
      if (!seen.has(seq)) {
        seen.add(seq);
        variants.push({ sequence: seq, offsets });
      }
      return;
    }
    const { p } = combo[comboPos];
    for (const base of combo[comboPos].bases) {
      build(comboPos + 1, seq.slice(0, p) + base + seq.slice(p + 1), [...offsets, { p, base }]);
    }
  };
  const gen = (start) => {
    if (combo.length === k) {
      const zoneCount = combo.filter((entry) => entry.zone).length;
      if (zoneCount <= max3PrimeMismatches) build(0, seed, []);
      return;
    }
    for (let i = start; i < pool.length; i++) {
      combo.push(pool[i]);
      gen(i + 1);
      combo.pop();
    }
  };
  gen(0);
  return variants;
}

/** One passing primer candidate on the scanned strand (forward: template, reverse: reverse complement). */
export function scanCandidates(strand, from, to, opts, clampFrom) {
  const { lenMin, lenMax, maxCandidates } = opts;
  const allowedMismatches = opts.maxMismatches ?? DESIGN_DEFAULTS.maxMismatches;
  const candidates = [];
  const tmCenter = (opts.tmMin + opts.tmMax) / 2;
  for (let start = from; start <= to; start++) {
    for (let len = lenMin; len <= lenMax; len++) {
      if (start + len > strand.length) break;
      const seed = strand.slice(start, start + len);
      let ambiguous = false;
      for (const base of seed) {
        if (!DNA_BASES.has(base)) {
          ambiguous = true;
          break;
        }
      }
      if (ambiguous) continue;
      const exact = evaluateSeq(seed, opts, tmCenter);
      if (exact.reason === undefined) {
        // Perfect match always wins — no mismatch variants are needed here.
        candidates.push({ ...exact, start, length: len, sequence: seed, mismatches: [] });
        continue;
      }
      if (allowedMismatches === 0) continue;
      if (!mismatchesCouldRescue(exact, seed, opts)) continue;
      // v12 mismatch tolerance: rescue windows whose exact sequence fails a
      // constraint, using the FEWEST substitutions that make it pass. All
      // passing variants at that count are kept; any variant is preferred over
      // nothing, but exact primers always outrank them in pair ranking.
      let hitAny = false;
      let sawFixableFailure = false; // a variant failed on gc/run — more substitutions could help
      let budget = MAX_MISMATCH_EVALS_PER_WINDOW;
      for (let k = 1; k <= allowedMismatches && !hitAny && budget > 0; k++) {
        const variants = mismatchVariants(seed, k, opts, exact).slice(0, Math.min(MAX_MISMATCH_VARIANTS_PER_K, budget));
        budget -= variants.length;
        let kept = 0;
        for (const variant of variants) {
          const evaluated = evaluateSeq(variant.sequence, opts, tmCenter);
          if (evaluated.reason !== undefined) {
            if (evaluated.reason === 'gc' || evaluated.reason === 'run') sawFixableFailure = true;
            continue;
          }
          candidates.push({ ...evaluated, start, length: len, sequence: variant.sequence, mismatches: variant.offsets });
          hitAny = true;
          if (++kept >= MAX_PASSING_VARIANTS_PER_WINDOW) break;
        }
        // More substitutions can only rescue a window whose variants still fail
        // on GC/run balance; structural failures (clamp/self/hairpin/tm) are
        // not fixable by adding mismatches, so stop searching this window.
        if (!sawFixableFailure) break;
      }
    }
  }
  candidates.sort((a, b) => a.tmDelta - b.tmDelta || a.start - b.start || a.length - b.length);
  return candidates.slice(0, maxCandidates ?? 2000);
}

/**
 * Translate a candidate's raw mismatch offsets into the reported shape.
 * `template` is the forward-strand sequence; `anchorStart` is the 0-based
 * start of the primer window ON THE TEMPLATE FORWARD STRAND (for reverse
 * candidates this is `anchor`, not the RC-scan start). Convention:
 * `template_base` is the base a PERFECTLY MATCHING primer would carry at that
 * position — for forward primers the template base itself, for reverse
 * primers its complement — so `primer_base !== template_base` always marks a
 * real mismatch on both strands.
 */
function mismatchReport(candidate, template, anchorStart, isReverse) {
  const len = candidate.length;
  return candidate.mismatches.map(({ p, base }) => {
    let templateBase;
    let templatePosition;
    let distanceFrom3Prime = len - 1 - p;
    if (!isReverse) {
      templatePosition = anchorStart + p + 1; // 1-based on the template
      templateBase = template[anchorStart + p];
    } else {
      const forwardIndex = anchorStart + len - 1 - p; // antiparallel position on the template
      templatePosition = forwardIndex + 1;
      templateBase = complement(template[forwardIndex]);
    }
    return {
      position: p + 1,
      template_base: templateBase,
      primer_base: base,
      template_position: templatePosition,
      distance_from_3prime: distanceFrom3Prime,
    };
  });
}

/**
 * Ranking penalty for the mismatches carried by one primer (added to the pair
 * penalty). Heavy enough that an exact primer pair on the same amplicon always
 * outranks a mismatched one, while a window with NO exact rescue can still
 * surface a mismatched candidate.
 */
function mismatchPenalty(offsets, zone) {
  return offsets.reduce((sum, m) => sum + 8 + (m.distanceFrom3Prime <= zone ? 4 : 0), 0);
}

/**
 * Design primer pairs flanking an amplicon inside `template`.
 *
 * @param {string} template - normalized template sequence.
 * @param {object} opts - constraints, see DESIGN_DEFAULTS.
 * @returns {Array} ranked pairs.
 */
export function designPrimerPairs(template, opts) {
  const length = template.length;
  const rc = reverseComplement(template);

  // Amplicon window, 0-based inclusive template positions.
  const regionStart = (opts.regionStart ?? 1) - 1;
  const regionEnd = (opts.regionEnd ?? length) - 1;
  if (regionStart < 0 || regionEnd >= length || regionStart >= regionEnd) {
    throw new MolbioInputError(`region ${regionStart + 1}-${regionEnd + 1} is outside the template (length ${length})`);
  }

  // Forward candidates: 3' end must stay inside the region.
  const fwd = scanCandidates(template, regionStart, regionEnd - opts.lenMin + 1, opts);
  // Reverse candidates on the reverse complement, mapped to template coordinates.
  const revOnRc = scanCandidates(rc, 0, rc.length - opts.lenMin, opts);
  const rev = revOnRc
    .map((candidate) => {
      const q = candidate.start;
      const a = length - (q + candidate.length); // 0-based template position of the 3' end
      return { ...candidate, anchor: a };
    })
    .sort((x, y) => x.anchor - y.anchor);
  const anchors = rev.map((candidate) => candidate.anchor);

  const pairs = [];
  const tmCenter = (opts.tmMin + opts.tmMax) / 2;
  for (const f of fwd) {
    const fwdEnd = f.start + f.length - 1; // 0-based 3' end on template
    const aMin = fwdEnd - opts.ampliconMax + 1;
    const aMax = fwdEnd - opts.ampliconMin + 1;
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid] < aMin) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < rev.length; i++) {
      const r = rev[i];
      if (r.anchor > aMax) break;
      if (r.anchor < 0 || r.anchor + r.length - 1 > regionEnd) continue;
      if (Math.abs(f.tm - r.tm) > opts.maxTmDelta) continue;
      const dimer = dimerPotential(f.sequence, r.sequence);
      if (dimer.score > opts.maxDimerScore) continue;
      const ampliconStart = r.anchor;
      const ampliconEnd = fwdEnd;
      const ampliconLength = ampliconEnd - ampliconStart + 1;
      if (ampliconLength < opts.ampliconMin || ampliconLength > opts.ampliconMax) continue;
      const fMismatches = mismatchReport(f, template, f.start, false);
      const rMismatches = mismatchReport(r, template, r.anchor, true);
      const zone = opts.mismatch3PrimeZone ?? DESIGN_DEFAULTS.mismatch3PrimeZone;
      const penalty =
        0.6 * Math.abs(f.tm - r.tm) + Math.abs(f.tm - tmCenter) + Math.abs(r.tm - tmCenter) + dimer.score / 10
        + mismatchPenalty(fMismatches, zone)
        + mismatchPenalty(rMismatches, zone);
      pairs.push({
        forward: {
          sequence: f.sequence,
          start: f.start + 1,
          end: f.start + f.length,
          length: f.length,
          tm: f.tm,
          gc_percent: f.gc_percent,
          mismatch_count: fMismatches.length,
          mismatches: fMismatches,
        },
        reverse: {
          sequence: r.sequence,
          start: r.anchor + 1,
          end: r.anchor + r.length,
          length: r.length,
          tm: r.tm,
          gc_percent: r.gc_percent,
          mismatch_count: rMismatches.length,
          mismatches: rMismatches,
        },
        amplicon: {
          start: ampliconStart + 1,
          end: ampliconEnd + 1,
          length: ampliconLength,
        },
        penalty: Math.round(penalty * 100) / 100,
      });
    }
  }
  pairs.sort((a, b) => a.penalty - b.penalty || a.amplicon.start - b.amplicon.start);
  // Dedupe identical amplicon spans.
  const seen = new Set();
  const unique = [];
  for (const pair of pairs) {
    const key = `${pair.amplicon.start}:${pair.amplicon.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pair);
  }
  return unique.slice(0, opts.maxResults ?? 5);
}

/** Bounds for the designer tool. */
export const DESIGN_DEFAULTS = {
  lenMin: 18,
  lenMax: 28,
  tmMin: 55,
  tmMax: 65,
  gcMin: 40,
  gcMax: 60,
  ampliconMin: 80,
  ampliconMax: 1000,
  requireGcClamp: true,
  maxRun: 3,
  maxSelfScore: 8,
  maxSelfConsecutive: 4,
  maxHairpinScore: 10,
  maxDimerScore: 12,
  maxTmDelta: 3,
  maxResults: 5,
  maxCandidates: 2000,
  // v12 mismatch tolerance: 0 = exact match required (v11 behavior).
  maxMismatches: 0,
  max3PrimeMismatches: 0,
  mismatch3PrimeZone: 5,
};

/** Merge user options over the defaults with basic range validation. */
export function resolveDesignOptions(raw) {
  // Full merge, not just known defaults: regionStart/regionEnd and the
  // intron-only keys (minJunctionBases/minGenomicSpan) are NOT part of
  // DESIGN_DEFAULTS and must reach the engine intact.
  const opts = { ...DESIGN_DEFAULTS };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined && value !== null) opts[key] = value;
  }
  if (!Number.isInteger(opts.lenMin) || opts.lenMin < 12) throw new MolbioInputError('primer_len_min must be an integer >= 12');
  if (!Number.isInteger(opts.lenMax) || opts.lenMax > 40 || opts.lenMax < opts.lenMin) throw new MolbioInputError('primer_len_max must be an integer between primer_len_min and 40');
  if (!(opts.tmMin < opts.tmMax)) throw new MolbioInputError('tm_min must be lower than tm_max');
  if (!(opts.gcMin < opts.gcMax)) throw new MolbioInputError('gc_min must be lower than gc_max');
  if (!(opts.ampliconMin <= opts.ampliconMax) || opts.ampliconMin < 1) throw new MolbioInputError('amplicon_min must be >= 1 and <= amplicon_max');
  if (opts.minJunctionBases !== undefined && (!Number.isInteger(opts.minJunctionBases) || opts.minJunctionBases < 3 || opts.minJunctionBases > 15)) throw new MolbioInputError('min_junction_bases must be an integer between 3 and 15');
  if (opts.minGenomicSpan !== undefined && (!Number.isInteger(opts.minGenomicSpan) || opts.minGenomicSpan < 0)) throw new MolbioInputError('min_genomic_span must be a non-negative integer');
  if (!Number.isInteger(opts.maxMismatches) || opts.maxMismatches < 0 || opts.maxMismatches > 5) throw new MolbioInputError('max_mismatches must be an integer between 0 and 5');
  if (!Number.isInteger(opts.max3PrimeMismatches) || opts.max3PrimeMismatches < 0 || opts.max3PrimeMismatches > opts.maxMismatches) throw new MolbioInputError('max_3prime_mismatches must be an integer between 0 and max_mismatches');
  if (!Number.isInteger(opts.mismatch3PrimeZone) || opts.mismatch3PrimeZone < 1 || opts.mismatch3PrimeZone > 10) throw new MolbioInputError('mismatch_3prime_zone must be an integer between 1 and 10');
  return opts;
}

/** Full entry point used by the tool: normalize + design. */
export function designPrimers(rawTemplate, rawOptions) {
  const template = normalizeSequence(rawTemplate);
  if (template.length < 24) throw new MolbioInputError(`template is too short for primer design (${template.length} bases; need >= 24)`);
  const opts = resolveDesignOptions(rawOptions);
  const pairs = designPrimerPairs(template, opts);
  return { pairs, opts };
}

// ── cross-intron primer design ──────────────────────────────────────────────

/**
 * Mismatch report for cross-intron candidates. Both primer scans run on the
 * spliced transcript in the sense orientation (the reported reverse.sequence
 * follows the established sense-substring convention of this tool), so the
 * mapping is uniform: `template_base` is what a perfectly matching primer
 * carries at the position on the spliced transcript, and coordinates come back
 * both spliced and genomic.
 */
function intronMismatchReport(candidate, spliced, splicedToGenomic) {
  const len = candidate.length;
  return candidate.mismatches.map(({ p, base }) => ({
    position: p + 1,
    template_base: spliced[candidate.start + p],
    primer_base: base,
    spliced_position: candidate.start + p + 1,
    genomic_position: splicedToGenomic[candidate.start + p] + 1,
    distance_from_3prime: len - 1 - p,
  }));
}

/**
 * Design qPCR primer pairs where the forward primer spans an exon-exon
 * junction (>= min_junction_bases on each side) so genomic DNA cannot be
 * amplified, and the reverse primer sits in a different exon. Coordinates are
 * reported both on the spliced transcript and on the genomic sequence.
 */
export function designIntronSpanningPrimers(genomic, exons, opts) {
  if (!Array.isArray(exons) || exons.length < 2) throw new MolbioInputError('exons must be an array of at least two {start, end} spans');
  const sorted = [...exons].sort((a, b) => a.start - b.start);
  for (const exon of sorted) {
    if (!Number.isInteger(exon.start) || !Number.isInteger(exon.end) || exon.start < 1 || exon.end > genomic.length || exon.start > exon.end) {
      throw new MolbioInputError(`exon ${JSON.stringify(exon)} is outside the genomic sequence (length ${genomic.length})`);
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) throw new MolbioInputError('exons must not overlap');
  }
  const minSide = opts.minJunctionBases ?? 6;
  const minGenomicSpan = opts.minGenomicSpan ?? 0;

  // Build the spliced transcript plus coordinate maps.
  let spliced = '';
  const splicedToGenomic = [];
  const splicedToExon = [];
  const junctionPositions = [];
  sorted.forEach((exon, exonIndex) => {
    if (exonIndex > 0) junctionPositions.push({ splicedPos: spliced.length, up: exonIndex - 1, down: exonIndex });
    for (let g = exon.start - 1; g < exon.end; g++) {
      splicedToGenomic.push(g);
      splicedToExon.push(exonIndex);
      spliced += genomic[g];
    }
  });
  if (spliced.length < 24) throw new MolbioInputError('the spliced transcript is too short for primer design');

  // Forward candidates must span a junction with minSide bases on each side.
  const fwd = [];
  for (const candidate of scanCandidates(spliced, 0, spliced.length - opts.lenMin, opts)) {
    for (const junction of junctionPositions) {
      const left = junction.splicedPos - candidate.start;
      const right = candidate.start + candidate.length - junction.splicedPos;
      if (left >= minSide && right >= minSide) {
        fwd.push({ ...candidate, junction, junction_left: left, junction_right: right });
        break;
      }
    }
  }

  // Reverse candidates sit entirely inside one exon.
  const rev = scanCandidates(spliced, 0, spliced.length - opts.lenMin, opts)
    .filter((candidate) => splicedToExon[candidate.start] === splicedToExon[candidate.start + candidate.length - 1])
    .map((candidate) => ({ ...candidate, exon: splicedToExon[candidate.start] }))
    .sort((a, b) => a.start - b.start);
  const revStarts = rev.map((candidate) => candidate.start);

  const tmCenter = (opts.tmMin + opts.tmMax) / 2;
  const pairs = [];
  for (const f of fwd) {
    const fwdEnd = f.start + f.length - 1;
    const aMin = fwdEnd - opts.ampliconMax + 1;
    const aMax = fwdEnd - opts.ampliconMin + 1;
    let lo = 0;
    let hi = revStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (revStarts[mid] < aMin) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < rev.length; i++) {
      const r = rev[i];
      if (r.start > aMax) break;
      if (r.exon === f.junction.down) continue; // reverse primer must sit in a different exon
      const gEnd = splicedToGenomic[fwdEnd];
      const gStart = splicedToGenomic[r.start];
      if (gEnd - gStart + 1 < minGenomicSpan) continue;
      if (Math.abs(f.tm - r.tm) > opts.maxTmDelta) continue;
      const dimer = dimerPotential(f.sequence, r.sequence);
      if (dimer.score > opts.maxDimerScore) continue;
      const fMismatches = intronMismatchReport(f, spliced, splicedToGenomic);
      const rMismatches = intronMismatchReport(r, spliced, splicedToGenomic);
      const zone = opts.mismatch3PrimeZone ?? DESIGN_DEFAULTS.mismatch3PrimeZone;
      const penalty = 0.6 * Math.abs(f.tm - r.tm) + Math.abs(f.tm - tmCenter) + Math.abs(r.tm - tmCenter) + dimer.score / 10
        + mismatchPenalty(fMismatches, zone)
        + mismatchPenalty(rMismatches, zone);
      pairs.push({
        forward: {
          sequence: f.sequence,
          length: f.length,
          tm: f.tm,
          gc_percent: f.gc_percent,
          spliced_start: f.start + 1,
          spliced_end: f.start + f.length,
          genomic_start: splicedToGenomic[f.start] + 1,
          genomic_end: splicedToGenomic[f.start + f.length - 1] + 1,
          exons: [String(f.junction.up + 1), String(f.junction.down + 1)],
          junction_left: f.junction_left,
          junction_right: f.junction_right,
          mismatch_count: fMismatches.length,
          mismatches: fMismatches,
        },
        reverse: {
          sequence: r.sequence,
          length: r.length,
          tm: r.tm,
          gc_percent: r.gc_percent,
          spliced_start: r.start + 1,
          spliced_end: r.start + r.length,
          genomic_start: splicedToGenomic[r.start] + 1,
          genomic_end: splicedToGenomic[r.start + r.length - 1] + 1,
          exon: r.exon + 1,
          mismatch_count: rMismatches.length,
          mismatches: rMismatches,
        },
        spliced_amplicon: { start: r.start + 1, end: fwdEnd + 1, length: fwdEnd - r.start + 1 },
        genomic_amplicon_length: gEnd - gStart + 1,
        penalty: Math.round(penalty * 100) / 100,
      });
    }
  }
  pairs.sort((a, b) => a.penalty - b.penalty || a.spliced_amplicon.start - b.spliced_amplicon.start);
  const seen = new Set();
  const unique = [];
  for (const pair of pairs) {
    const key = `${pair.spliced_amplicon.start}:${pair.spliced_amplicon.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pair);
  }
  return unique.slice(0, opts.maxResults ?? 5);
}

/** Entry point used by the tool: normalize + validate + design. */
export function designIntronPrimers(rawGenomic, exons, rawOptions) {
  const genomic = normalizeSequence(rawGenomic, 'genomic');
  const opts = resolveDesignOptions(rawOptions);
  const pairs = designIntronSpanningPrimers(genomic, exons, opts);
  return { pairs, opts };
}
