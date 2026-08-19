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
  dimerThermo,
  endGcCount5,
  endStability5,
  findRuns,
  hairpinThermo,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfAnyScore,
  selfEndScore,
} from './lib.mjs';

// Design-time PCR conditions for the NN Tm model. v13: these are the DEFAULT
// salt/concentration knobs; resolveDesignOptions validates user overrides and
// derives per-call `tmOpts`/`ctMolar` on the options object. The constants
// below only serve as fallbacks when the engine is called directly with
// hand-built options (as the smoke tests do).
const DEFAULT_TM_OPTS = { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: 200 };

/** Molar primer concentration used for the hairpin/dimer folding Tm. */
const DEFAULT_CT_MOLAR = DEFAULT_TM_OPTS.primerNm * 1e-9;

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
 * canonical (no IUPAC ambiguity). Cheap checks run first; the structural
 * checks are the Primer3-style thermodynamic models (self-any/self-end
 * alignment scores, hairpin folding Tm, end stability, end GC).
 */
export function evaluateSeq(seq, opts, tmCenter) {
  const {
    gcMin, gcMax, maxRun, gcClamp,
    maxSelfAny, maxSelfEnd, maxHairpinTm,
    maxEndStability, maxEndGc, tmMin, tmMax,
  } = opts;
  const { gc, at } = baseCounts(seq);
  const gcPercent = (gc / (gc + at)) * 100;
  if (gcPercent < gcMin || gcPercent > gcMax) return { reason: 'gc', gcPercent };
  if (findRuns(seq, maxRun + 1).length > 0) return { reason: 'run' };
  if (gcClamp > 0) {
    let clamp = 0;
    for (let i = seq.length - 1; i >= 0 && (seq[i] === 'G' || seq[i] === 'C'); i--) clamp++;
    if (clamp < gcClamp) return { reason: 'clamp', clamp };
  }
  const endGc = endGcCount5(seq);
  if (endGc > maxEndGc) return { reason: 'end_gc', endGc };
  const endStability = endStability5(seq);
  if (endStability < -maxEndStability) return { reason: 'end_stability', endStability };
  const selfAny = selfAnyScore(seq);
  if (selfAny > maxSelfAny) return { reason: 'self', selfAny };
  const selfEnd = selfEndScore(seq);
  if (selfEnd > maxSelfEnd) return { reason: 'self_end', selfEnd };
  const hairpin = hairpinThermo(seq, opts.ctMolar ?? DEFAULT_CT_MOLAR)[0];
  const hairpinTm = hairpin === undefined ? 0 : hairpin.tm;
  if (hairpinTm > maxHairpinTm) return { reason: 'hairpin', hairpinTm };
  let tm;
  try {
    tm = primerTm(seq, opts.tmOpts ?? DEFAULT_TM_OPTS).tm_celsius;
  } catch {
    return { reason: 'tm' };
  }
  if (tm < tmMin || tm > tmMax) return { reason: 'tm', tm };
  return {
    tm: round1(tm),
    gc_percent: round1(gcPercent),
    tmDelta: Math.abs(tm - tmCenter),
    self_any: round1(selfAny),
    self_end: round1(selfEnd),
    hairpin_tm: hairpinTm,
    end_stability_kcal: endStability,
    end_gc_count: endGc,
  };
}

/**
 * Whether mismatch variants are worth attempting for a window: a handful of
 * substitutions can realistically only rescue GC balance, run breaking, or a
 * MARGINAL Tm miss — never clamp/end rules or structural folds. Returning
 * false skips the variant search entirely, which keeps mismatch mode fast on
 * large templates.
 */
function mismatchesCouldRescue(failure, seed, opts) {
  const maxMismatches = opts.maxMismatches ?? DESIGN_DEFAULTS.maxMismatches;
  // a mismatch can break a run, rebalance GC, or nudge a marginal Tm — nothing else
  if (failure.reason === 'run') return true;
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
  return false; // clamp, end_gc, end_stability, self, self_end, hairpin
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
    // break runs: substitute one base inside each run that exceeds the limit.
    // Positions are ordered by distance from the run's center so that
    // evenly-spread splits (the minimal-substitution repair) are tried first
    // within the per-window evaluation budget.
    for (const run of findRuns(seed, opts.maxRun + 1)) {
      const center = run.start + run.count / 2;
      const positions = [];
      for (let i = run.start; i < run.start + run.count; i++) positions.push(i);
      positions.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
      for (const i of positions) {
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

// ── mispriming check (non-specific 3' annealing on the template) ────────────

/** Index of every canonical k-mer of `seq` (IUPAC-ambiguous k-mers are skipped). */
function buildKmerIndex(seq, k) {
  const index = new Map();
  for (let i = 0; i + k <= seq.length; i++) {
    const key = seq.slice(i, i + k);
    let canonical = true;
    for (const base of key) {
      if (!DNA_BASES.has(base)) {
        canonical = false;
        break;
      }
    }
    if (!canonical) continue;
    let list = index.get(key);
    if (list === undefined) {
      list = [];
      index.set(key, list);
    }
    list.push(i);
  }
  return index;
}

/**
 * All tail keys that bind a template position with at most `maxMismatches`
 * substitutions. The primer's 3'-TERMINAL base must always pair, so variant
 * substitutions are only generated for the other tail positions. Order is
 * deterministic: exact first, then one substitution, then two.
 */
function tailVariantKeys(tail, maxMismatches) {
  const bases = ['A', 'C', 'G', 'T'];
  const keys = [tail];
  if (maxMismatches >= 1) {
    for (let p = 0; p < tail.length - 1; p++) {
      for (const base of bases) {
        if (base === tail[p]) continue;
        keys.push(tail.slice(0, p) + base + tail.slice(p + 1));
      }
    }
  }
  if (maxMismatches >= 2) {
    for (let i = 0; i < tail.length - 2; i++) {
      for (let j = i + 1; j < tail.length - 1; j++) {
        for (const bi of bases) {
          if (bi === tail[i]) continue;
          for (const bj of bases) {
            if (bj === tail[j]) continue;
            keys.push(tail.slice(0, i) + bi + tail.slice(i + 1, j) + bj + tail.slice(j + 1));
          }
        }
      }
    }
  }
  return keys;
}

/**
 * Extra (non-intended) template positions where a candidate's 3' tail anneals:
 * top-strand occurrences of RC(tail) mean the primer binds the TOP strand;
 * top-strand occurrences of tail mean it binds the BOTTOM strand. Sites inside
 * the primer's own binding window [intendedPos, intendedPos+k) are excluded
 * (position-range exclusion is robust even when the primer carries designed
 * mismatches inside its tail). Returns { count, sites } with up to 8 reported
 * sites; the result is memoized on the candidate.
 */
function misprimingForCandidate(candidate, tail, templateIndex, opts, intendedPos) {
  if (candidate._mispriming !== undefined) return candidate._mispriming;
  const k = tail.length;
  const seen = new Set();
  const sites = [];
  for (const key of tailVariantKeys(tail, opts.misprimingMaxMismatches ?? DESIGN_DEFAULTS.misprimingMaxMismatches)) {
    const mismatches = hamming(key, tail);
    for (const [lookupKey, strand] of [[key, 'bottom'], [reverseComplement(key), 'top']]) {
      const list = templateIndex.get(lookupKey);
      if (list === undefined) continue;
      for (const pos of list) {
        if (pos >= intendedPos && pos < intendedPos + k) continue; // the primer's own binding window
        const id = `${pos}:${lookupKey}`;
        if (seen.has(id)) continue;
        seen.add(id);
        sites.push({ position: pos + 1, strand, matches: k - mismatches });
      }
    }
  }
  const result = { count: sites.length, sites: sites.slice(0, 8) };
  candidate._mispriming = result;
  return result;
}

/** Hamming distance between two equal-length strings (canonical bases only). */
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
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

  // v13 target position preference: the ranking penalty pulls primer 3' ends
  // toward the given template position (SNP / site-directed design).
  const targetPosition = opts.targetPosition;
  if (targetPosition !== undefined && (!Number.isInteger(targetPosition) || targetPosition < 1 || targetPosition > length)) {
    throw new MolbioInputError(`target_position ${targetPosition} is outside the template (length ${length})`);
  }
  const targetWeight = opts.targetPenalty ?? DESIGN_DEFAULTS.targetPenalty;

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

  // Optional mispriming check: k-mer index of the template built once.
  const misprimingIndex = opts.checkMispriming
    ? buildKmerIndex(template, opts.mispriming3PrimeBases ?? DESIGN_DEFAULTS.mispriming3PrimeBases)
    : undefined;
  const maxSites = opts.misprimingMaxSites ?? DESIGN_DEFAULTS.misprimingMaxSites;

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
      const dimer = dimerThermo(f.sequence, r.sequence, opts.ctMolar ?? DEFAULT_CT_MOLAR);
      if (dimer.any_tm > opts.maxDimerTm || dimer.end_tm > opts.maxDimerEndTm) continue;
      const ampliconStart = r.anchor;
      const ampliconEnd = fwdEnd;
      const ampliconLength = ampliconEnd - ampliconStart + 1;
      if (ampliconLength < opts.ampliconMin || ampliconLength > opts.ampliconMax) continue;
      let fMispriming = { count: 0, sites: [] };
      let rMispriming = { count: 0, sites: [] };
      if (misprimingIndex !== undefined) {
        const misK = opts.mispriming3PrimeBases ?? DESIGN_DEFAULTS.mispriming3PrimeBases;
        fMispriming = misprimingForCandidate(f, f.sequence.slice(-misK), misprimingIndex, opts, f.start);
        if (fMispriming.count > maxSites) continue;
        rMispriming = misprimingForCandidate(r, r.sequence.slice(-misK), misprimingIndex, opts, r.anchor);
        if (rMispriming.count > maxSites) continue;
      }
      const fMismatches = mismatchReport(f, template, f.start, false);
      const rMismatches = mismatchReport(r, template, r.anchor, true);
      const zone = opts.mismatch3PrimeZone ?? DESIGN_DEFAULTS.mismatch3PrimeZone;
      let fTargetDistance;
      let rTargetDistance;
      let targetDistance;
      if (targetPosition !== undefined) {
        fTargetDistance = Math.abs(f.start + f.length - targetPosition); // 1-based 3' end
        rTargetDistance = Math.abs(r.anchor + 1 - targetPosition);       // 1-based 3' end
        targetDistance = Math.min(fTargetDistance, rTargetDistance);
      }
      const penalty =
        0.6 * Math.abs(f.tm - r.tm) + Math.abs(f.tm - tmCenter) + Math.abs(r.tm - tmCenter)
        + 0.5 * Math.max(0, f.self_any - 4) + 0.5 * Math.max(0, r.self_any - 4)
        + 1.0 * Math.max(0, f.self_end - 1) + 1.0 * Math.max(0, r.self_end - 1)
        + 0.2 * Math.max(0, f.hairpin_tm - 40) + 0.2 * Math.max(0, r.hairpin_tm - 40)
        + 0.2 * Math.max(0, dimer.any_tm - 40) + 0.2 * Math.max(0, dimer.end_tm - 40)
        + mismatchPenalty(fMismatches, zone)
        + mismatchPenalty(rMismatches, zone)
        + 8 * fMispriming.count + 8 * rMispriming.count
        + (targetDistance !== undefined ? targetWeight * targetDistance : 0);
      pairs.push({
        forward: {
          sequence: f.sequence,
          start: f.start + 1,
          end: f.start + f.length,
          length: f.length,
          tm: f.tm,
          gc_percent: f.gc_percent,
          self_any: f.self_any,
          self_end: f.self_end,
          hairpin_tm: f.hairpin_tm,
          end_stability_kcal: f.end_stability_kcal,
          end_gc_count: f.end_gc_count,
          mismatch_count: fMismatches.length,
          mismatches: fMismatches,
          mispriming_count: fMispriming.count,
          mispriming_sites: fMispriming.sites,
          ...(fTargetDistance !== undefined ? { target_distance: fTargetDistance } : {}),
        },
        reverse: {
          sequence: r.sequence,
          start: r.anchor + 1,
          end: r.anchor + r.length,
          length: r.length,
          tm: r.tm,
          gc_percent: r.gc_percent,
          self_any: r.self_any,
          self_end: r.self_end,
          hairpin_tm: r.hairpin_tm,
          end_stability_kcal: r.end_stability_kcal,
          end_gc_count: r.end_gc_count,
          mismatch_count: rMismatches.length,
          mismatches: rMismatches,
          mispriming_count: rMispriming.count,
          mispriming_sites: rMispriming.sites,
          ...(rTargetDistance !== undefined ? { target_distance: rTargetDistance } : {}),
        },
        amplicon: {
          start: ampliconStart + 1,
          end: ampliconEnd + 1,
          length: ampliconLength,
        },
        ...(targetDistance !== undefined ? { target_distance: targetDistance } : {}),
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
  // v12: Primer3-style structural constraints (thresholds match Primer3 defaults).
  gcClamp: 1,            // consecutive G/C bases required at the 3' end (0-3)
  maxRun: 3,
  maxSelfAny: 8,         // local alignment score, match +1 / mismatch -1 / gap -0.25
  maxSelfEnd: 3,         // 3'-anchored alignment score
  maxHairpinTm: 47,      // hairpin folding Tm °C
  maxDimerTm: 47,        // most stable primer dimer Tm °C
  maxDimerEndTm: 47,     // dimer Tm when a 3' end participates
  maxEndStability: 9,    // |ΔG(37°C)| of the last 5 bases, kcal/mol
  maxEndGc: 5,           // G/C bases allowed in the last 5 bases
  maxTmDelta: 3,
  maxResults: 5,
  maxCandidates: 2000,
  // v13: PCR reaction-condition knobs for the NN Tm model (Primer3-aligned).
  naMm: 50,             // monovalent cation concentration, mM (von Ahsen 2001 equivalence)
  mgMm: 1.5,            // Mg2+ concentration, mM
  dntpMm: 0.8,          // dNTP concentration, mM
  primerNm: 200,        // primer concentration, nM
  // v13: 3' target position preference (SNP / site-directed design).
  targetPenalty: 0.5,   // ranking penalty per bp between the nearer primer 3' end and target_position
  // v12 mismatch tolerance: 0 = exact match required (v11 behavior).
  maxMismatches: 0,
  max3PrimeMismatches: 0,
  mismatch3PrimeZone: 5,
  // v12 mispriming (non-specific 3' annealing) check on the template.
  checkMispriming: false,
  mispriming3PrimeBases: 8,
  misprimingMaxMismatches: 1,
  misprimingMaxSites: 1,
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
  if (!Number.isInteger(opts.gcClamp) || opts.gcClamp < 0 || opts.gcClamp > 3) throw new MolbioInputError('gc_clamp must be an integer between 0 and 3');
  if (!Number.isInteger(opts.maxEndGc) || opts.maxEndGc < 0 || opts.maxEndGc > 5) throw new MolbioInputError('max_end_gc must be an integer between 0 and 5');
  if (!(typeof opts.maxSelfAny === 'number' && opts.maxSelfAny >= 0)) throw new MolbioInputError('max_self_any must be a non-negative number');
  if (!(typeof opts.maxSelfEnd === 'number' && opts.maxSelfEnd >= 0)) throw new MolbioInputError('max_self_end must be a non-negative number');
  if (!(typeof opts.maxHairpinTm === 'number' && opts.maxHairpinTm >= 0)) throw new MolbioInputError('max_hairpin_tm must be a non-negative number (°C)');
  if (!(typeof opts.maxDimerTm === 'number' && opts.maxDimerTm >= 0)) throw new MolbioInputError('max_dimer_tm must be a non-negative number (°C)');
  if (!(typeof opts.maxDimerEndTm === 'number' && opts.maxDimerEndTm >= 0)) throw new MolbioInputError('max_dimer_end_tm must be a non-negative number (°C)');
  if (!(typeof opts.maxEndStability === 'number' && opts.maxEndStability >= 0)) throw new MolbioInputError('max_end_stability must be a non-negative number (kcal/mol)');
  if (!Number.isInteger(opts.mispriming3PrimeBases) || opts.mispriming3PrimeBases < 6 || opts.mispriming3PrimeBases > 10) throw new MolbioInputError('mispriming_3prime_bases must be an integer between 6 and 10');
  if (!Number.isInteger(opts.misprimingMaxMismatches) || opts.misprimingMaxMismatches < 0 || opts.misprimingMaxMismatches > 2) throw new MolbioInputError('mispriming_max_mismatches must be an integer between 0 and 2');
  if (!Number.isInteger(opts.misprimingMaxSites) || opts.misprimingMaxSites < 0 || opts.misprimingMaxSites > 20) throw new MolbioInputError('mispriming_max_sites must be an integer between 0 and 20');
  if (!Number.isInteger(opts.maxMismatches) || opts.maxMismatches < 0 || opts.maxMismatches > 5) throw new MolbioInputError('max_mismatches must be an integer between 0 and 5');
  if (!Number.isInteger(opts.max3PrimeMismatches) || opts.max3PrimeMismatches < 0 || opts.max3PrimeMismatches > opts.maxMismatches) throw new MolbioInputError('max_3prime_mismatches must be an integer between 0 and max_mismatches');
  if (!Number.isInteger(opts.mismatch3PrimeZone) || opts.mismatch3PrimeZone < 1 || opts.mismatch3PrimeZone > 10) throw new MolbioInputError('mismatch_3prime_zone must be an integer between 1 and 10');
  // v13 reaction-condition knobs: validate, then derive the per-call Tm options
  // and the molar concentration used for the hairpin/dimer folding Tm.
  if (!(typeof opts.naMm === 'number' && opts.naMm >= 1 && opts.naMm <= 1000)) throw new MolbioInputError('na_mm must be a number between 1 and 1000 (mM monovalent cations)');
  if (!(typeof opts.mgMm === 'number' && opts.mgMm >= 0 && opts.mgMm <= 300)) throw new MolbioInputError('mg_mm must be a number between 0 and 300 (mM Mg2+)');
  if (!(typeof opts.dntpMm === 'number' && opts.dntpMm >= 0 && opts.dntpMm <= 10)) throw new MolbioInputError('dntp_mm must be a number between 0 and 10 (mM dNTP)');
  if (!(typeof opts.primerNm === 'number' && opts.primerNm >= 1 && opts.primerNm <= 5000)) throw new MolbioInputError('primer_nm must be a number between 1 and 5000 (nM primer)');
  if (opts.targetPosition !== undefined && (!Number.isInteger(opts.targetPosition) || opts.targetPosition < 1)) throw new MolbioInputError('target_position must be a 1-based integer position on the template');
  if (opts.targetPenalty !== undefined && !(typeof opts.targetPenalty === 'number' && opts.targetPenalty >= 0)) throw new MolbioInputError('target_penalty must be a non-negative number');
  opts.tmOpts = { naMm: opts.naMm, mgMm: opts.mgMm, dntpMm: opts.dntpMm, primerNm: opts.primerNm };
  opts.ctMolar = opts.primerNm * 1e-9;
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

  // v13 target position preference (coordinates on the spliced transcript).
  const targetPosition = opts.targetPosition;
  if (targetPosition !== undefined && (!Number.isInteger(targetPosition) || targetPosition < 1 || targetPosition > spliced.length)) {
    throw new MolbioInputError(`target_position ${targetPosition} is outside the spliced transcript (length ${spliced.length})`);
  }
  const targetWeight = opts.targetPenalty ?? DESIGN_DEFAULTS.targetPenalty;

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
  const misprimingIndex = opts.checkMispriming
    ? buildKmerIndex(spliced, opts.mispriming3PrimeBases ?? DESIGN_DEFAULTS.mispriming3PrimeBases)
    : undefined;
  const maxSites = opts.misprimingMaxSites ?? DESIGN_DEFAULTS.misprimingMaxSites;
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
      const dimer = dimerThermo(f.sequence, r.sequence, opts.ctMolar ?? DEFAULT_CT_MOLAR);
      if (dimer.any_tm > opts.maxDimerTm || dimer.end_tm > opts.maxDimerEndTm) continue;
      let fMispriming = { count: 0, sites: [] };
      let rMispriming = { count: 0, sites: [] };
      if (misprimingIndex !== undefined) {
        const misK = opts.mispriming3PrimeBases ?? DESIGN_DEFAULTS.mispriming3PrimeBases;
        fMispriming = misprimingForCandidate(f, f.sequence.slice(-misK), misprimingIndex, opts, f.start);
        if (fMispriming.count > maxSites) continue;
        // the reported reverse sequence follows the sense-substring convention:
        // the real oligo is its reverse complement, so its 3' tail is the RC
        // of the FIRST k bases and the intended site is r.start
        const rTail = reverseComplement(r.sequence.slice(0, misK));
        rMispriming = misprimingForCandidate(r, rTail, misprimingIndex, opts, r.start);
        if (rMispriming.count > maxSites) continue;
      }
      const fMismatches = intronMismatchReport(f, spliced, splicedToGenomic);
      const rMismatches = intronMismatchReport(r, spliced, splicedToGenomic);
      const zone = opts.mismatch3PrimeZone ?? DESIGN_DEFAULTS.mismatch3PrimeZone;
      let fTargetDistance;
      let rTargetDistance;
      let targetDistance;
      if (targetPosition !== undefined) {
        fTargetDistance = Math.abs(f.start + f.length - targetPosition); // spliced 1-based 3' end
        rTargetDistance = Math.abs(r.start + 1 - targetPosition);
        targetDistance = Math.min(fTargetDistance, rTargetDistance);
      }
      const penalty = 0.6 * Math.abs(f.tm - r.tm) + Math.abs(f.tm - tmCenter) + Math.abs(r.tm - tmCenter)
        + 0.5 * Math.max(0, f.self_any - 4) + 0.5 * Math.max(0, r.self_any - 4)
        + 1.0 * Math.max(0, f.self_end - 1) + 1.0 * Math.max(0, r.self_end - 1)
        + 0.2 * Math.max(0, f.hairpin_tm - 40) + 0.2 * Math.max(0, r.hairpin_tm - 40)
        + 0.2 * Math.max(0, dimer.any_tm - 40) + 0.2 * Math.max(0, dimer.end_tm - 40)
        + mismatchPenalty(fMismatches, zone)
        + mismatchPenalty(rMismatches, zone)
        + 8 * fMispriming.count + 8 * rMispriming.count
        + (targetDistance !== undefined ? targetWeight * targetDistance : 0);
      pairs.push({
        forward: {
          sequence: f.sequence,
          length: f.length,
          tm: f.tm,
          gc_percent: f.gc_percent,
          self_any: f.self_any,
          self_end: f.self_end,
          hairpin_tm: f.hairpin_tm,
          end_stability_kcal: f.end_stability_kcal,
          end_gc_count: f.end_gc_count,
          spliced_start: f.start + 1,
          spliced_end: f.start + f.length,
          genomic_start: splicedToGenomic[f.start] + 1,
          genomic_end: splicedToGenomic[f.start + f.length - 1] + 1,
          exons: [String(f.junction.up + 1), String(f.junction.down + 1)],
          junction_left: f.junction_left,
          junction_right: f.junction_right,
          mismatch_count: fMismatches.length,
          mismatches: fMismatches,
          mispriming_count: fMispriming.count,
          mispriming_sites: fMispriming.sites.map((site) => ({
            position: site.position,
            genomic_position: splicedToGenomic[site.position - 1] + 1,
            strand: site.strand,
            matches: site.matches,
          })),
          ...(fTargetDistance !== undefined ? { target_distance: fTargetDistance } : {}),
        },
        reverse: {
          sequence: r.sequence,
          length: r.length,
          tm: r.tm,
          gc_percent: r.gc_percent,
          self_any: r.self_any,
          self_end: r.self_end,
          hairpin_tm: r.hairpin_tm,
          end_stability_kcal: r.end_stability_kcal,
          end_gc_count: r.end_gc_count,
          spliced_start: r.start + 1,
          spliced_end: r.start + r.length,
          genomic_start: splicedToGenomic[r.start] + 1,
          genomic_end: splicedToGenomic[r.start + r.length - 1] + 1,
          exon: r.exon + 1,
          mismatch_count: rMismatches.length,
          mismatches: rMismatches,
          mispriming_count: rMispriming.count,
          mispriming_sites: rMispriming.sites.map((site) => ({
            position: site.position,
            genomic_position: splicedToGenomic[site.position - 1] + 1,
            strand: site.strand,
            matches: site.matches,
          })),
          ...(rTargetDistance !== undefined ? { target_distance: rTargetDistance } : {}),
        },
        spliced_amplicon: { start: r.start + 1, end: fwdEnd + 1, length: fwdEnd - r.start + 1 },
        genomic_amplicon_length: gEnd - gStart + 1,
        ...(targetDistance !== undefined ? { target_distance: targetDistance } : {}),
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
