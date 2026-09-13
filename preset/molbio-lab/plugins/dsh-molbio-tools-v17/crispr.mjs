/**
 * dsh-molbio-tools/crispr.mjs
 *
 * CRISPR guide-RNA design: PAM-anchored protospacer scanning on both strands,
 * oligo quality metrics, a stated ranking heuristic, and a mismatch-tolerant
 * off-target search over a reference sequence. Pure computation —
 * deterministic, synchronous, lossless JSON, zero dependencies.
 *
 * Geometry (SpCas9 conventions, stated once and used everywhere):
 * - A guide is a 20 nt protospacer immediately 5' of a 3 nt PAM on the SAME
 *   strand. For the default `NGG` PAM the top-strand hit at 0-based `pamStart`
 *   (where seq[pamStart+1..pamStart+2] === 'GG') has its protospacer at
 *   [pamStart-20, pamStart); the guide's 5'→3' sequence is exactly that
 *   slice. For the reverse strand the PAM is the reverse complement (`CCN`)
 *   and the guide is the reverse complement of the top-strand slice.
 * - `start`/`end` in every output are 1-based inclusive coordinates ON THE TOP
 *   STRAND. `sequence` is always the guide as ordered (5'→3'), `pam` is the
 *   PAM as it reads on the strand the guide targets (so it always matches the
 *   requested pattern, e.g. `NGG`).
 *
 * Off-target search reuses the v12 primer-mispriming idea: index every k-mer
 * of the reference (and its reverse complement) once, then enumerate the
 * guide's variants at up to `max_mismatches` substitutions and look each one
 * up. Bulge/indel off-targets are NOT modelled — only substitutions.
 *
 * Every score here is a documented heuristic for RANKING candidates, not a
 * validated prediction of cutting efficiency or of true off-target activity.
 */

import { DNA_BASES, MolbioInputError, findRuns, hairpinThermo, normalizeSequence, primerTm, reverseComplement, selfAnyScore } from './lib.mjs';

/** Default SpCas9 PAM. */
export const DEFAULT_PAM = 'NGG';

/** Hard caps, so one call cannot enumerate an unbounded search space. */
export const CRISPR_LIMITS = {
  maxSequenceLength: 200_000,
  maxOffTargetGuides: 200,
  maxMismatches: 4,
  maxVariantsPerGuide: 400_000,
  maxReportedSites: 20,
};

/**
 * Validate a PAM pattern: IUPAC DNA, 2-6 nt, with the 5'-most position
 * degenerate (`N`) — the invariant that makes a PAM a PAM rather than a fixed
 * site, and the reason a protospacer can always be found upstream of a hit.
 */
export function assertPamPattern(raw) {
  if (typeof raw !== 'string') throw new MolbioInputError('pam must be a string');
  const pam = normalizeSequence(raw, 'pam');
  if (pam.length < 2 || pam.length > 6) {
    throw new MolbioInputError(`pam must be 2-6 nt (got ${pam.length})`);
  }
  if (pam[0] !== 'N') {
    throw new MolbioInputError(`pam must start with the degenerate position N (got ${JSON.stringify(pam)}) — a fixed first position cannot anchor a protospacer`);
  }
  return pam;
}

/**
 * Every PAM-anchored protospacer in `seq`, both strands.
 * @param {string} seq normalized (ACGT-only) sequence.
 * @param {{pam?: string, guideLength?: number}} [options]
 * @returns {Array<{strand: 'forward'|'reverse', start: number, end: number,
 *   sequence: string, pam: string, pam_start: number}>} `start`/`end` are
 *   1-based inclusive top-strand positions; `pam_start` is 1-based too.
 *   Ordered by top-strand position, forward before reverse at a tie.
 */
export function findProtospacers(seq, options = {}) {
  const pam = assertPamPattern(options.pam ?? DEFAULT_PAM);
  const guideLength = options.guideLength ?? 20;
  const rcPam = reverseComplement(pam);
  const hits = [];
  const scan = (pattern, strand) => {
    const last = seq.length - pattern.length;
    for (let start = 0; start <= last; start++) {
      let matched = true;
      for (let i = 0; i < pattern.length; i++) {
        const base = seq[start + i];
        const allowed = IUPAC_ALLOWED[pattern[i]];
        if (allowed === undefined || !allowed.has(base)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      if (strand === 'forward') {
        const protospacerStart = start - guideLength;
        if (protospacerStart < 0) continue; // PAM too close to the 5' end
        hits.push({
          strand: 'forward',
          start: protospacerStart + 1,
          end: start,
          sequence: seq.slice(protospacerStart, start),
          pam: seq.slice(start, start + pattern.length),
          pam_start: start + 1,
        });
      } else {
        // Reverse strand: the PAM triple occupies `start` .. `start + L - 1`
        // on the TOP strand, and the protospacer is the guideLength bases
        // DOWNSTREAM of it — NOT including the PAM itself. (Slicing PAM +
        // guideLength and reverse-complementing the lot was the first version
        // of this function and produced 23 nt "guides".)
        const pamEnd = start + pattern.length;
        const protospacerEnd = pamEnd + guideLength;
        if (protospacerEnd > seq.length) continue; // PAM too close to the 3' end
        hits.push({
          strand: 'reverse',
          start: pamEnd + 1,
          end: protospacerEnd,
          sequence: reverseComplement(seq.slice(pamEnd, protospacerEnd)),
          pam: reverseComplement(seq.slice(start, pamEnd)),
          pam_start: start + 1,
        });
      }
    }
  };
  scan(pam, 'forward');
  if (rcPam !== pam) scan(rcPam, 'reverse');
  hits.sort((a, b) => a.start - b.start || a.end - b.end || a.strand.localeCompare(b.strand));
  return hits;
}

/** IUPAC symbol → the DNA bases it matches (only ACGT are consulted). */
const IUPAC_ALLOWED = {
  A: new Set(['A']), C: new Set(['C']), G: new Set(['G']), T: new Set(['T']),
  R: new Set(['A', 'G']), Y: new Set(['C', 'T']), S: new Set(['C', 'G']), W: new Set(['A', 'T']),
  K: new Set(['G', 'T']), M: new Set(['A', 'C']),
  B: new Set(['C', 'G', 'T']), D: new Set(['A', 'G', 'T']), H: new Set(['A', 'C', 'T']), V: new Set(['A', 'C', 'G']),
  N: new Set(['A', 'C', 'G', 'T']),
};

/** Fraction of G+C over the guide (0-1). */
export function gcFraction(seq) {
  let gc = 0;
  for (const base of seq) if (base === 'G' || base === 'C') gc++;
  return seq.length === 0 ? 0 : gc / seq.length;
}

/** Longest consecutive T run — a Pol III terminator signal in U6 cassettes. */
export function longestTRun(seq) {
  let best = 0;
  let run = 0;
  for (const base of seq) {
    run = base === 'T' ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Rank one protospacer. All penalties are stated in {@link scoreGuide} and the
 * result is a deterministic heuristic ordering aid, not a prediction.
 * @returns {{gc_percent: number, tm_celsius: number|null, self_any: number,
 *   self_end: number, hairpin_tm: number|null, longest_t_run: number,
 *   longest_homopolymer: number, score: number, notes: string[],
 *   reject_reasons: string[]}}
 */
export function evaluateGuide(guide, options = {}) {
  const notes = [];
  const rejectReasons = [];
  const gc = gcFraction(guide);
  const gcPercent = Math.round(gc * 1000) / 10;
  let tm = null;
  try {
    tm = primerTm(guide, {
      naMm: options.naMm ?? 50,
      mgMm: options.mgMm ?? 1.5,
      dntpMm: options.dntpMm ?? 0.8,
      primerNm: options.primerNm ?? 200,
    }).tm_celsius;
  } catch {
    tm = null; // outside the physical regime of the NN model
    notes.push('Tm could not be estimated with the NN model for this sequence');
  }
  const selfAny = round2(selfAnyScore(guide));
  const selfEnd = round2(selfEndScoreSafe(guide));
  const seedAny = round2(selfAnyScore(guide.slice(-12)));
  let hairpinTm = null;
  try {
    const hairpins = hairpinThermo(guide);
    hairpinTm = hairpins.length > 0 ? hairpins[0].tm : null;
    if (hairpinTm !== null && hairpinTm >= (options.maxHairpinTm ?? 47)) {
      notes.push(`hairpin Tm ${hairpinTm} °C at or above the ${options.maxHairpinTm ?? 47} °C threshold`);
    }
  } catch {
    hairpinTm = null;
  }
  const tRun = longestTRun(guide);
  const runs = findRuns(guide, 4);
  const longestHomopolymer = runs.length === 0 ? 1 : Math.max(...runs.map((run) => run.count));

  // Rejections first: a rejected guide is still returned (flagged), so the
  // caller can see how many candidates the filters removed and why.
  const gcMin = options.gcMin ?? 40;
  const gcMax = options.gcMax ?? 70;
  if (gcPercent < gcMin) rejectReasons.push(`GC ${gcPercent}% below the minimum ${gcMin}%`);
  if (gcPercent > gcMax) rejectReasons.push(`GC ${gcPercent}% above the maximum ${gcMax}%`);
  if (tRun > (options.maxTRun ?? 4)) rejectReasons.push(`poly-T run of ${tRun} (limit ${options.maxTRun ?? 4}) — a U6 terminator signal`);
  if (options.avoidGcClamp !== false && (guide[guide.length - 1] === 'G' || guide[guide.length - 1] === 'C') && (guide[guide.length - 2] === 'G' || guide[guide.length - 2] === 'C')) {
    notes.push('3\' end is a GG/GC/CC/CG clamp, which can favour seed-independent extension');
  }
  if (selfEnd >= (options.maxSelfEnd ?? 3)) rejectReasons.push(`3' self-complementarity score ${selfEnd} at or above ${options.maxSelfEnd ?? 3}`);
  if (options.avoidGcRun !== false && /G{4,}|C{4,}/.test(guide)) rejectReasons.push('homopolymer run of 4+ G/C');

  const scored = scoreGuide({
    gcPercent,
    tm,
    tRun,
    longestHomopolymer,
    selfAny,
    selfEnd,
    hairpinTm,
    guide,
    offTargetCount: options.offTargetCount ?? 0,
  }, options);
  return {
    gc_percent: gcPercent,
    tm_celsius: tm,
    self_any: selfAny,
    self_end: selfEnd,
    seed_self_any: seedAny,
    hairpin_tm: hairpinTm,
    longest_t_run: tRun,
    longest_homopolymer: longestHomopolymer,
    score: scored.score,
    penalties: scored.penalties,
    notes,
    reject_reasons: rejectReasons,
  };
}

/**
 * The ranking heuristic, in full. It returns `{ score, penalties }`: `score`
 * starts at 100 and every penalty is subtracted, clamped to [0, 100].
 *
 *   - gc           : 1.0 per point outside [gcMin, gcMax]
 *   - tm           : 0.5 per °C outside [tmMin, tmMax]; 12.0 when the NN model
 *                    cannot estimate a Tm for the sequence at all
 *   - poly_t       : 4.0 per T beyond 3 in the longest T run
 *   - homopolymer  : 4.0 per base beyond 4 in the longest run
 *   - self         : 2.0 * max(0, self_any - 8) + 4.0 * self_end — on the
 *                    Primer3-style 1.0/match scale the library already uses,
 *                    where a fully paired 20 nt duplex would score 20
 *   - seed         : 4.0 when the 3'-terminal 12 nt (the PAM-proximal seed)
 *                    reach a self-any score of 6 on their own (a perfect 6 bp
 *                    seed duplex), +0.5 per point above that
 *   - hairpin      : 2.0 + 0.5 per °C at or above the hairpin threshold
 *   - off_target   : 8.0 per off-target site (only when the off-target search
 *                    ran — this is the criterion that matters most, so it is
 *                    weighted above every sequence-intrinsic penalty)
 *   - bonus        : +4 when guide position 20 is G, the one position with a
 *                    well-replicated SpCas9 preference
 *
 * Every individual penalty is capped (gc 20, tm 20, poly-T 12, homopolymer 12,
 * self 16, seed 12, hairpin 12); off-target has no cap, which is what drives a
 * heavily off-targeting guide to the bottom. Each cap exists so one metric
 * cannot silently dominate the rest. These weights are a ranking convention,
 * NOT fitted parameters.
 */
function scoreGuide(metrics, options) {
  const cap = (value, max) => Math.min(value, max);
  const penalties = { gc: 0, tm: 0, poly_t: 0, homopolymer: 0, self: 0, seed: 0, hairpin: 0, off_target: 0 };
  const gcMin = options.gcMin ?? 40;
  const gcMax = options.gcMax ?? 70;
  const tmMin = options.tmMin ?? 50;
  const tmMax = options.tmMax ?? 70;
  if (metrics.gcPercent < gcMin) penalties.gc = cap((gcMin - metrics.gcPercent) * 1.0, 20);
  if (metrics.gcPercent > gcMax) penalties.gc = cap((metrics.gcPercent - gcMax) * 1.0, 20);
  if (metrics.tm === null) penalties.tm = 12;
  else if (metrics.tm < tmMin) penalties.tm = cap((tmMin - metrics.tm) * 0.5, 20);
  else if (metrics.tm > tmMax) penalties.tm = cap((metrics.tm - tmMax) * 0.5, 20);
  if (metrics.tRun > 3) penalties.poly_t = cap((metrics.tRun - 3) * 4, 12);
  if (metrics.longestHomopolymer > 4) penalties.homopolymer = cap((metrics.longestHomopolymer - 4) * 4, 12);
  penalties.self = cap(2 * Math.max(0, metrics.selfAny - 8) + 4 * metrics.selfEnd, 16);
  const seedAny = selfAnyScore(metrics.guide.slice(-12));
  if (seedAny >= 6) penalties.seed = cap(4 + 0.5 * (seedAny - 6), 12);
  if (metrics.hairpinTm !== null && metrics.hairpinTm >= (options.maxHairpinTm ?? 47)) {
    penalties.hairpin = cap(2 + (metrics.hairpinTm - (options.maxHairpinTm ?? 47)) * 0.5, 12);
  }
  penalties.off_target = 8 * (metrics.offTargetCount ?? 0);
  const total = Object.values(penalties).reduce((sum, value) => sum + value, 0);
  const bonus = metrics.guide[metrics.guide.length - 1] === 'G' ? 4 : 0;
  const score = Math.round(Math.max(0, Math.min(100, 100 - total + bonus)) * 10) / 10;
  return { score, penalties };
}

/**
 * Index every k-mer of `sequence` and of its reverse complement.
 * @returns {{forward: Map<string, number[]>, reverse: Map<string, number[]>}}
 *   values are 0-based start positions in top-strand coordinates.
 */
export function buildOffTargetIndex(sequence, k) {
  const forward = new Map();
  const reverse = new Map();
  for (let i = 0; i + k <= sequence.length; i++) {
    const key = sequence.slice(i, i + k);
    if (!isCanonical(key)) continue;
    push(forward, key, i);
    push(reverse, reverseComplement(key), i);
  }
  return { forward, reverse };
}

/**
 * Every sequence within `maxMismatches` substitutions of `sequence`, paired
 * with its Hamming distance, ordered deterministic (exact first, then by
 * ascending distance, then lexicographic). Throws when the enumeration would
 * exceed `maxVariants`.
 */
export function mismatchVariants(sequence, maxMismatches, maxVariants = CRISPR_LIMITS.maxVariantsPerGuide) {
  const keys = [[sequence, 0]];
  const bases = ['A', 'C', 'G', 'T'];
  for (let distance = 1; distance <= maxMismatches; distance++) {
    const positions = combinations(sequence.length, distance);
    for (const combo of positions) {
      const slots = [];
      for (const position of combo) slots.push([position, bases.filter((base) => base !== sequence[position])]);
      for (const substitution of cartesian(slots)) {
        const chars = sequence.split('');
        for (let i = 0; i < combo.length; i++) chars[combo[i]] = substitution[i];
        keys.push([chars.join(''), distance]);
      }
      if (keys.length > maxVariants) {
        throw new MolbioInputError(`off-target search would enumerate more than ${maxVariants} variants for one guide; lower max_mismatches`);
      }
    }
  }
  return keys;
}

/**
 * Off-target sites of one guide in an indexed reference.
 * The guide's PAM-proximal dinucleotide is never allowed to mismatch (a seed
 * constraint, and the reason the shortest useful search key is 3 nt).
 * @returns {{sites: Array, count: number, truncated: boolean}}
 */
export function offTargetSites(guide, index, options = {}) {
  const maxMismatches = options.maxMismatches ?? 2;
  const requirePam = options.requirePam !== false;
  const kmers = mismatchVariants(guide, maxMismatches);
  const seen = new Map();
  for (const [key, distance] of kmers) {
    // Seed constraint: positions length-2 and length-1 must match exactly.
    if (key.slice(-2) !== guide.slice(-2)) continue;
    for (const [table, strand] of [[index.forward, 'forward'], [index.reverse, 'reverse']]) {
      const positions = table.get(key);
      if (positions === undefined) continue;
      for (const position of positions) {
        const id = `${strand}:${position}:${distance}`;
        if (seen.has(id)) continue;
        seen.set(id, { strand, position, distance });
      }
    }
  }
  return finalizeSites([...seen.values()], options, requirePam, guide);
}

function finalizeSites(entries, options, requirePam, guideSequence) {
  const reference = options.reference;
  const guideLength = options.guideLength ?? 20;
  const ownStart = options.ownStart;
  const ownStrand = options.ownStrand;
  const sites = [];
  let droppedPam = 0;
  let intended = 0;
  for (const entry of entries) {
    // Protospacer top-strand window: 0-based [start, start+20).
    const start = entry.strand === 'forward' ? entry.position : entry.position - (guideLength - 1);
    if (start < 0 || start + guideLength > reference.length) continue;
    const topSlice = reference.slice(start + guideLength - 1, start + guideLength + 2);
    if (topSlice.length < 3) continue;
    const pamTop = entry.strand === 'forward' ? reference.slice(start + guideLength, start + guideLength + 3) : reverseComplement(topSlice);
    const pamIntact = pamMatches(pamTop, options.pam ?? DEFAULT_PAM);
    if (requirePam && !pamIntact) {
      droppedPam++;
      continue;
    }
    // The guide's own intended site: same top-strand window and strand, and an
    // exact match. Counted (not listed) so the caller can subtract it.
    const isOwn = ownStart !== undefined && entry.distance === 0 && start + 1 === ownStart && entry.strand === ownStrand;
    if (isOwn) {
      intended++;
      continue;
    }
    sites.push({
      strand: entry.strand,
      start: start + 1,
      end: start + guideLength,
      pam: pamTop,
      pam_intact: pamIntact,
      mismatches: entry.distance,
      mismatch_positions: mismatchPositions(
        entry.strand === 'forward' ? reference.slice(start, start + guideLength) : reverseComplement(reference.slice(start, start + guideLength)),
        guideSequence ?? '',
      ),
    });
  }
  sites.sort((a, b) => a.mismatches - b.mismatches || a.start - b.start || a.strand.localeCompare(b.strand));
  return {
    sites: sites.slice(0, options.maxReportedSites ?? CRISPR_LIMITS.maxReportedSites),
    count: sites.length,
    intended_count: intended,
    dropped_pam_disrupted: droppedPam,
  };
}

/** Whether a concrete PAM triple satisfies an IUPAC PAM pattern. */
export function pamMatches(triple, pattern) {
  if (triple.length !== pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const allowed = IUPAC_ALLOWED[pattern[i]];
    if (allowed === undefined || !allowed.has(triple[i])) return false;
  }
  return true;
}

/**
 * Full gRNA design over a sequence.
 * @param {string} normalized ACGT sequence.
 * @param {object} options see the molbio_grna_design tool schema.
 * @returns {{guides: Array, candidate_count: number, rejected_count: number,
 *   off_target_scanned: number, pam: string, guide_length: number}} guides
 *   sorted by score desc, then position. When `check_off_target` ran, the
 *   off-target penalty is already part of every scanned guide's score.
 */
export function designGrnas(sequence, options = {}) {
  const pam = assertPamPattern(options.pam ?? DEFAULT_PAM);
  const guideLength = options.guideLength ?? 20;
  const candidates = findProtospacers(sequence, { pam, guideLength });
  const regionStart = options.regionStart ?? 1;
  const regionEnd = options.regionEnd ?? sequence.length;
  const inRegion = candidates.filter((hit) => hit.start >= regionStart && hit.end <= regionEnd);
  const evaluated = inRegion.map((hit) => {
    const metrics = evaluateGuide(hit.sequence, options);
    return {
      sequence: hit.sequence,
      pam: hit.pam,
      strand: hit.strand,
      start: hit.start,
      end: hit.end,
      gc_percent: metrics.gc_percent,
      tm_celsius: metrics.tm_celsius,
      self_any: metrics.self_any,
      self_end: metrics.self_end,
      seed_self_any: metrics.seed_self_any,
      hairpin_tm: metrics.hairpin_tm,
      longest_t_run: metrics.longest_t_run,
      score: metrics.score,
      penalties: metrics.penalties,
      notes: metrics.notes,
      rejected: metrics.reject_reasons.length > 0,
      reject_reasons: metrics.reject_reasons,
    };
  });

  // Off-target pass: index the reference once, then scan the best surviving
  // candidates (rejected guides are never ordered, so they are not scanned).
  // Scanning is a separate pass from scoring because the off-target penalty is
  // part of the score — the two would otherwise be circular.
  const passing = evaluated.filter((guide) => !guide.rejected);
  const offTargetBudget = options.maxOffTargetGuides ?? CRISPR_LIMITS.maxOffTargetGuides;
  let scanned = 0;
  if (options.checkOffTarget && passing.length > 0) {
    const index = buildOffTargetIndex(sequence, guideLength);
    const scanOrder = [...passing].sort((a, b) => b.score - a.score || a.start - b.start || a.strand.localeCompare(b.strand));
    for (const guide of scanOrder.slice(0, offTargetBudget)) {
      scanned++;
      const result = offTargetSites(guide.sequence, index, {
        ...options,
        reference: sequence,
        guideLength,
        pam,
        guideSequence: guide.sequence,
        ownStart: guide.start,
        ownStrand: guide.strand,
      });
      // `finalizeSites` excludes and counts the guide's own intended site
      // before reporting, so the off-target count never includes it — however
      // many variant spellings collapsed onto that one position.
      guide.off_target_count = result.count;
      guide.off_target_sites = result.sites;
      guide.pam_disrupted_sites = result.dropped_pam_disrupted;
      if (guide.off_target_count > 0) {
        guide.notes.push(`${guide.off_target_count} off-target site(s) with <= ${options.maxMismatches ?? 2} mismatch(es) and an intact PAM in the supplied reference`);
      }
      // Re-score with the off-target penalty included (the only penalty that
      // depends on the search, and the one weighted above all the others).
      const rescored = scoreGuide({
        gcPercent: guide.gc_percent,
        tm: guide.tm_celsius,
        tRun: guide.longest_t_run,
        longestHomopolymer: longestRun(guide.sequence),
        selfAny: guide.self_any,
        selfEnd: guide.self_end,
        hairpinTm: guide.hairpin_tm,
        guide: guide.sequence,
        offTargetCount: guide.off_target_count,
      }, options);
      guide.score = rescored.score;
      guide.penalties = rescored.penalties;
    }
  }

  const accepted = evaluated.filter((guide) => !guide.rejected);
  accepted.sort((a, b) => b.score - a.score || a.start - b.start || a.strand.localeCompare(b.strand));
  const limit = options.maxGuides ?? 20;
  return {
    guides: accepted.slice(0, limit),
    candidate_count: evaluated.length,
    rejected_count: evaluated.length - accepted.length,
    accepted_count: accepted.length,
    off_target_scanned: scanned,
    pam,
    guide_length: guideLength,
  };
}

/** Longest homopolymer run length in a sequence (1 for a sequence with none). */
function longestRun(seq) {
  const runs = findRuns(seq, 4);
  return runs.length === 0 ? 1 : Math.max(...runs.map((run) => run.count));
}

// ── helpers ─────────────────────────────────────────────────────────────────

function selfEndScoreSafe(guide) {
  try {
    return selfEndScore(guide);
  } catch {
    return 0;
  }
}

function isCanonical(seq) {
  for (const base of seq) if (!DNA_BASES.has(base)) return false;
  return true;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function combinations(length, count) {
  const out = [];
  const current = [];
  const walk = (start) => {
    if (current.length === count) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < length; i++) {
      current.push(i);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

function cartesian(slots) {
  let out = [[]];
  for (const [, values] of slots) {
    const next = [];
    for (const prefix of out) for (const value of values) next.push([...prefix, value]);
    out = next;
  }
  return out;
}

function mismatchPositions(siteSequence, guideSequence) {
  const positions = [];
  for (let i = 0; i < guideSequence.length && i < siteSequence.length; i++) {
    if (siteSequence[i] !== guideSequence[i]) positions.push(i + 1);
  }
  return positions;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
