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

import { DNA_BASES, IUPAC_MASKS, MolbioInputError, findRuns, hairpinThermo, normalizeSequence, primerTm, reverseComplement, selfAnyScore } from './lib.mjs';

/** Default SpCas9 PAM. */
export const DEFAULT_PAM = 'NGG';

/**
 * Cas-family geometry, in ONE table.
 *
 * The original design hard-coded SpCas9's shape everywhere: a 3' PAM, a 20 nt
 * protospacer, and a seed at the guide's 3' end. That is correct for SpCas9 and
 * SaCas9, but it is wrong for Cas12a (5' TTTV PAM, 23 nt crRNA, PAM-proximal 5'
 * seed) and meaningless for Cas13 (an RNA target with a PFS preference, not a
 * PAM). The table below is the fact each family is scored against; the geometry
 * and scoring code read it instead of assuming SpCas9.
 *
 * Sources: SpCas9 NGG / 20 nt; SaCas9 NNGRRT / 21 nt; Cas12a (LbCpf1, AsCpf1)
 * 5'-TTTV / 23 nt; LwaCas13a 3' H PFS / 28 nt; PspCas13b 5' D + 3' NAN PFS /
 * 30 nt; RfxCas13d no PFS / 22 nt. PFS preferences are NOT hard PAMs: a guide
 * without the preferred PFS can still work, so it is penalised and reported
 * rather than silently discarded unless the caller sets require_pfs.
 */
export const CAS_FAMILIES = {
  spcas9: {
    id: 'spcas9',
    label: 'SpCas9',
    pam: 'NGG',
    pamSide: '3prime',
    guideLength: 20,
    guideLengthMin: 15,
    guideLengthMax: 30,
    seedSide: '3prime',
    seedLength: 12,
    seedMismatchWindow: 2,
    target: 'DNA',
    tmModel: 'dna',
    positionBonus: { index: 20, base: 'G', points: 4 },
    gcClampNote: true,
    pfs: null,
  },
  sacas9: {
    id: 'sacas9',
    label: 'SaCas9',
    pam: 'NNGRRT',
    pamSide: '3prime',
    guideLength: 21,
    guideLengthMin: 15,
    guideLengthMax: 30,
    seedSide: '3prime',
    seedLength: 12,
    seedMismatchWindow: 2,
    target: 'DNA',
    tmModel: 'dna',
    positionBonus: null,
    gcClampNote: true,
    pfs: null,
  },
  cas12a: {
    id: 'cas12a',
    label: 'Cas12a (Cpf1)',
    pam: 'TTTV',
    pamSide: '5prime',
    guideLength: 23,
    guideLengthMin: 15,
    guideLengthMax: 30,
    seedSide: '5prime',
    seedLength: 8,
    seedMismatchWindow: 2,
    target: 'DNA',
    tmModel: 'dna',
    positionBonus: null,
    gcClampNote: false,
    pfs: null,
  },
  cas13a: {
    id: 'cas13a',
    label: 'Cas13a (LwaCas13a)',
    pam: null,
    pamSide: 'none',
    guideLength: 28,
    guideLengthMin: 15,
    guideLengthMax: 30,
    seedSide: null,
    seedLength: 0,
    seedMismatchWindow: 0,
    target: 'RNA',
    tmModel: 'none',
    positionBonus: null,
    gcClampNote: false,
    pfs: { fivePrime: null, threePrime: 'H', label: "3' H (A/C/U) — a preference, not a PAM" },
  },
  cas13b: {
    id: 'cas13b',
    label: 'Cas13b (PspCas13b)',
    pam: null,
    pamSide: 'none',
    guideLength: 30,
    guideLengthMin: 15,
    guideLengthMax: 30,
    seedSide: null,
    seedLength: 0,
    seedMismatchWindow: 0,
    target: 'RNA',
    tmModel: 'none',
    positionBonus: null,
    gcClampNote: false,
    pfs: { fivePrime: 'D', threePrime: 'NAN', label: "5' D (A/G/U) and 3' NAN — preferences, not a PAM" },
  },
  cas13d: {
    id: 'cas13d',
    label: 'Cas13d (RfxCas13d)',
    pam: null,
    pamSide: 'none',
    guideLength: 22,
    guideLengthMin: 15,
    guideLengthMax: 30,
    seedSide: null,
    seedLength: 0,
    seedMismatchWindow: 0,
    target: 'RNA',
    tmModel: 'none',
    positionBonus: null,
    gcClampNote: false,
    pfs: null,
  },
};

export const CAS_FAMILY_NAMES = Object.keys(CAS_FAMILIES);

/** Look up a family, with a useful error instead of a silent SpCas9 fallback. */
export function resolveCasFamily(raw = 'spcas9') {
  const family = CAS_FAMILIES[raw];
  if (family === undefined) {
    throw new MolbioInputError(`unknown cas_family ${JSON.stringify(raw)}; known: ${CAS_FAMILY_NAMES.join(', ')}`);
  }
  return family;
}

/** Hard caps, so one call cannot enumerate an unbounded search space. */
export const CRISPR_LIMITS = {
  maxSequenceLength: 200_000,
  maxOffTargetGuides: 200,
  maxMismatches: 4,
  maxVariantsPerGuide: 400_000,
  maxReportedSites: 20,
  // A Cas13 scan has no PAM to thin the candidate set: every window of the
  // guide length is a candidate. 200 kb would be ~200,000 windows and each
  // evaluation computes two folding scores, so cap it and ask for a region.
  maxCas13Candidates: 50_000,
};

/** Whether one IUPAC symbol stands for more than one base. */
function isDegenerateSymbol(symbol) {
  const mask = IUPAC_MASKS[symbol];
  if (mask === undefined) return false;
  let count = 0;
  for (let bits = mask; bits !== 0; bits &= bits - 1) count++;
  return count > 1;
}

/**
 * Validate a PAM pattern: IUPAC DNA, 2-6 nt, with the PAM position ADJACENT to
 * the protospacer degenerate.
 *
 * For a 3' PAM (SpCas9 NGG, SaCas9 NNGRRT) that is the 5'-most position, as
 * before. For a 5' PAM (Cas12a TTTV) it is the 3'-most position: the V is the
 * base next to the protospacer. Requiring "N first" for Cas12a would reject the
 * real PAM, so the side is an explicit argument rather than an assumption.
 */
export function assertPamPattern(raw, side = '3prime') {
  if (typeof raw !== 'string') throw new MolbioInputError('pam must be a string');
  const pam = normalizeSequence(raw, 'pam');
  if (pam.length < 2 || pam.length > 6) {
    throw new MolbioInputError(`pam must be 2-6 nt (got ${pam.length})`);
  }
  if (side === '5prime') {
    const anchor = pam[pam.length - 1];
    if (!isDegenerateSymbol(anchor)) {
      throw new MolbioInputError(`a 5' PAM must end with a degenerate position (got ${JSON.stringify(pam)}) — the base next to the protospacer cannot be fixed`);
    }
    return pam;
  }
  if (!isDegenerateSymbol(pam[0])) {
    throw new MolbioInputError(`pam must start with the degenerate position N (got ${JSON.stringify(pam)}) — a fixed first position cannot anchor a protospacer`);
  }
  return pam;
}

/**
 * The PFS observed around one top-strand protospacer window, as read on the
 * guide's own strand.
 *
 * Cas13 PFS elements are preferences, not PAMs, and PspCas13b has one on each
 * side. The flanks are therefore part of the candidate object (reported and
 * optionally filtered), not a reason to drop a window before the caller sees it.
 */
function observedPfs(seq, start, guideLength, strand, pfs) {
  if (pfs === null) return { five: '', three: '', sequence: '', ok: true };
  // For the reverse strand the guide is the reverse complement of the top
  // strand, so its 5' flank is the top-strand base AFTER the protospacer and its
  // 3' flank is the top-strand base BEFORE it. Reading both through the same
  // reverse-complement helper is what keeps the two ends from being swapped.
  const fiveTop = strand === 'forward' ? start - 1 : start + guideLength;
  const threeTop = strand === 'forward' ? start + guideLength : start - 1;
  const read = (from, length) => {
    if (from < 0 || from + length > seq.length) return undefined;
    const top = seq.slice(from, from + length);
    return strand === 'forward' ? top : reverseComplement(top);
  };
  const five = pfs.fivePrime === null ? '' : read(fiveTop, pfs.fivePrime.length) ?? '';
  const three = pfs.threePrime === null ? '' : read(threeTop, pfs.threePrime.length) ?? '';
  const okFive = pfs.fivePrime === null || (five !== '' && pamMatches(five, pfs.fivePrime));
  const okThree = pfs.threePrime === null || (three !== '' && pamMatches(three, pfs.threePrime));
  return { five, three, sequence: [five, three].filter((value) => value !== '').join('/'), ok: okFive && okThree };
}

/**
 * Every PAM-anchored (or, for Cas13, PFS-flanked) protospacer in `seq`.
 *
 * @param {string} seq normalized (ACGT-only) sequence.
 * @param {{pam?: string, pamSide?: '3prime'|'5prime'|'none', guideLength?: number,
 *   family?: object, targetStrand?: 'forward'|'reverse'|'both'}} [options]
 * @returns {Array<{strand: 'forward'|'reverse', start: number, end: number,
 *   sequence: string, pam: string, pam_start: number, pfs?: string, pfs_ok?: boolean}>}
 *   `start`/`end` are 1-based inclusive top-strand positions; `pam_start` is
 *   1-based too. Ordered by top-strand position, forward before reverse at a tie.
 */
export function findProtospacers(seq, options = {}) {
  const pamSide = options.pamSide ?? '3prime';
  const guideLength = options.guideLength ?? options.family?.guideLength ?? 20;
  if (pamSide === 'none') {
    const family = options.family ?? CAS_FAMILIES.cas13a;
    const targetStrand = options.targetStrand ?? 'forward';
    const strands = targetStrand === 'both' ? ['forward', 'reverse'] : [targetStrand];
    const hits = [];
    for (const strand of strands) {
      for (let start = 0; start + guideLength <= seq.length; start++) {
        const pfs = observedPfs(seq, start, guideLength, strand, family.pfs);
        hits.push({
          strand,
          start: start + 1,
          end: start + guideLength,
          sequence: strand === 'forward' ? seq.slice(start, start + guideLength) : reverseComplement(seq.slice(start, start + guideLength)),
          pam: '',
          pam_start: 0,
          pfs: pfs.sequence,
          pfs_ok: pfs.ok,
        });
      }
    }
    hits.sort((a, b) => a.start - b.start || a.end - b.end || a.strand.localeCompare(b.strand));
    return hits;
  }
  const pam = assertPamPattern(options.pam ?? options.family?.pam ?? DEFAULT_PAM, pamSide);
  const pamLength = pam.length;
  const rcPam = reverseComplement(pam);
  const hits = [];
  const scan = (pattern, strand) => {
    const last = seq.length - pattern.length;
    for (let start = 0; start <= last; start++) {
      let matched = true;
      for (let i = 0; i < pattern.length; i++) {
        const base = seq[start + i];
        const allowed = IUPAC_MASKS[pattern[i]];
        if (allowed === undefined || (allowed & IUPAC_MASKS[base]) === 0) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const pamStart = start; // 0-based top-strand PAM start, both strands
      let protospacerStart;
      let protospacerEnd; // 0-based inclusive
      let pamTop;
      if (strand === 'forward') {
        pamTop = seq.slice(pamStart, pamStart + pamLength);
        if (pamSide === '3prime') {
          // PAM is downstream of the protospacer on the top strand.
          protospacerStart = pamStart - guideLength;
          protospacerEnd = pamStart - 1;
        } else {
          // Cas12a: PAM is upstream of the protospacer on the top strand.
          protospacerStart = pamStart + pamLength;
          protospacerEnd = protospacerStart + guideLength - 1;
        }
      } else {
        pamTop = reverseComplement(seq.slice(pamStart, pamStart + pamLength));
        if (pamSide === '3prime') {
          // On the reverse strand the top-strand PAM is UPSTREAM of the
          // top-strand protospacer.
          protospacerStart = pamStart + pamLength;
          protospacerEnd = protospacerStart + guideLength - 1;
        } else {
          // Cas12a on the reverse strand: the top-strand PAM is DOWNSTREAM.
          protospacerEnd = pamStart - 1;
          protospacerStart = protospacerEnd - guideLength + 1;
        }
      }
      if (protospacerStart < 0 || protospacerEnd >= seq.length) continue;
      const topProto = seq.slice(protospacerStart, protospacerEnd + 1);
      hits.push({
        strand,
        start: protospacerStart + 1,
        end: protospacerEnd + 1,
        sequence: strand === 'forward' ? topProto : reverseComplement(topProto),
        pam: pamTop,
        pam_start: pamStart + 1,
      });
    }
  };
  scan(pam, 'forward');
  // Palindromic PAM patterns are legitimate (e.g. an NNNN test pattern), and
  // the reverse-strand geometry is a different site even when the text matches,
  // so both scans run unconditionally.
  scan(rcPam, 'reverse');
  hits.sort((a, b) => a.start - b.start || a.end - b.end || a.strand.localeCompare(b.strand));
  return hits;
}

/** IUPAC symbol → the DNA bases it matches (from `lib.mjs`'s single table). */

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
  const family = options.family ?? CAS_FAMILIES.spcas9;
  const notes = [];
  const rejectReasons = [];
  const gc = gcFraction(guide);
  const gcPercent = Math.round(gc * 1000) / 10;
  let tm = null;
  if (family.tmModel === 'dna') {
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
  } else {
    notes.push('Cas13 targets RNA; the DNA nearest-neighbour Tm is not reported for this guide (it would be a different molecule)');
  }
  const selfAny = round2(selfAnyScore(guide));
  const selfEnd = round2(selfEndScoreSafe(guide));
  const seedAny = family.seedSide === null
    ? 0
    : round2(selfAnyScore(family.seedSide === '5prime' ? guide.slice(0, family.seedLength) : guide.slice(-family.seedLength)));
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
  if (family.gcClampNote && options.avoidGcClamp !== false && (guide[guide.length - 1] === 'G' || guide[guide.length - 1] === 'C') && (guide[guide.length - 2] === 'G' || guide[guide.length - 2] === 'C')) {
    notes.push('3\' end is a GG/GC/CC/CG clamp, which can favour seed-independent extension');
  }
  if (selfEnd >= (options.maxSelfEnd ?? 3)) rejectReasons.push(`3' self-complementarity score ${selfEnd} at or above ${options.maxSelfEnd ?? 3}`);
  if (options.avoidGcRun !== false && /G{4,}|C{4,}/.test(guide)) rejectReasons.push('homopolymer run of 4+ G/C');
  const pfsOk = options.pfsOk ?? true;
  if (family.pfs !== null && options.requirePfs === true && !pfsOk) {
    rejectReasons.push(`the preferred ${family.pfs.label} PFS is absent; a PFS is a preference, so set require_pfs=false to keep this guide`);
  } else if (family.pfs !== null && options.requirePfs !== true && !pfsOk) {
    notes.push(`the preferred ${family.pfs.label} PFS is absent (a preference, not a PAM; it costs ranking points)`);
  }

  const scored = scoreGuide({
    gcPercent,
    tm,
    tRun,
    longestHomopolymer,
    selfAny,
    selfEnd,
    seedAny,
    hairpinTm,
    guide,
    pfsOk,
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
  const family = options.family ?? CAS_FAMILIES.spcas9;
  const cap = (value, max) => Math.min(value, max);
  const penalties = { gc: 0, tm: 0, poly_t: 0, homopolymer: 0, self: 0, seed: 0, hairpin: 0, pfs: 0, off_target: 0 };
  const gcMin = options.gcMin ?? 40;
  const gcMax = options.gcMax ?? 70;
  const tmMin = options.tmMin ?? 50;
  const tmMax = options.tmMax ?? 70;
  if (metrics.gcPercent < gcMin) penalties.gc = cap((gcMin - metrics.gcPercent) * 1.0, 20);
  if (metrics.gcPercent > gcMax) penalties.gc = cap((metrics.gcPercent - gcMax) * 1.0, 20);
  if (family.tmModel === 'dna') {
    if (metrics.tm === null) penalties.tm = 12;
    else if (metrics.tm < tmMin) penalties.tm = cap((tmMin - metrics.tm) * 0.5, 20);
    else if (metrics.tm > tmMax) penalties.tm = cap((metrics.tm - tmMax) * 0.5, 20);
  }
  if (metrics.tRun > 3) penalties.poly_t = cap((metrics.tRun - 3) * 4, 12);
  if (metrics.longestHomopolymer > 4) penalties.homopolymer = cap((metrics.longestHomopolymer - 4) * 4, 12);
  penalties.self = cap(2 * Math.max(0, metrics.selfAny - 8) + 4 * metrics.selfEnd, 16);
  const seedAny = metrics.seedAny ?? 0;
  if (family.seedSide !== null && seedAny >= 6) penalties.seed = cap(4 + 0.5 * (seedAny - 6), 12);
  if (metrics.hairpinTm !== null && metrics.hairpinTm >= (options.maxHairpinTm ?? 47)) {
    penalties.hairpin = cap(2 + (metrics.hairpinTm - (options.maxHairpinTm ?? 47)) * 0.5, 12);
  }
  // A missing preferred PFS is a ranking penalty, never a hard rejection unless
  // require_pfs was set. 10 points puts it near the other strong sequence
  // signals but below an actual off-target site.
  if (family.pfs !== null && metrics.pfsOk === false) penalties.pfs = 10;
  penalties.off_target = 8 * (metrics.offTargetCount ?? 0);
  const total = Object.values(penalties).reduce((sum, value) => sum + value, 0);
  const bonus = family.positionBonus !== null && metrics.guide[family.positionBonus.index - 1] === family.positionBonus.base
    ? family.positionBonus.points
    : 0;
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
  const pamSide = options.pamSide ?? '3prime';
  const requirePam = pamSide !== 'none' && options.requirePam !== false;
  const seedSide = options.seedSide ?? (pamSide === 'none' ? null : '3prime');
  const seedWindow = options.seedMismatchWindow ?? (pamSide === 'none' ? 0 : 2);
  const kmers = mismatchVariants(guide, maxMismatches);
  const seen = new Map();
  for (const [key, distance] of kmers) {
    // The seed is the PAM-proximal end. SpCas9/SaCas9 protect the last two
    // bases; Cas12a protects the first two; Cas13 has no PAM and therefore no
    // hard seed window in this model.
    if (seedWindow > 0 && seedSide !== null) {
      const seed = seedSide === '5prime' ? guide.slice(0, seedWindow) : guide.slice(-seedWindow);
      const candidate = seedSide === '5prime' ? key.slice(0, seedWindow) : key.slice(-seedWindow);
      if (candidate !== seed) continue;
    }
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
  const pamSide = options.pamSide ?? '3prime';
  const pam = options.pam ?? DEFAULT_PAM;
  const pamLength = pamSide === 'none' ? 0 : pam.length;
  const ownStart = options.ownStart;
  const ownStrand = options.ownStrand;
  const sites = [];
  let droppedPam = 0;
  let intended = 0;
  for (const entry of entries) {
    // The index stores every k-mer at its TOP-STRAND start, for both the
    // forward and the reverse table. The old reverse formula subtracted
    // guideLength-1 here, which shifted every reverse-strand off-target by
    // 19 nt and dropped most of them as out of bounds — a silent
    // under-count that the forward-only smoke fixture never exposed.
    const start = entry.position;
    if (start < 0 || start + guideLength > reference.length) continue;
    let pamTop = '';
    let pamIntact = true;
    if (pamSide !== 'none') {
      // The PAM as read on the GUIDE's strand, and its top-strand window.
      // 3' PAM: forward -> downstream; reverse -> upstream.
      // 5' PAM (Cas12a): forward -> upstream; reverse -> downstream.
      const topPamStart = entry.strand === 'forward'
        ? (pamSide === '3prime' ? start + guideLength : start - pamLength)
        : (pamSide === '3prime' ? start - pamLength : start + guideLength);
      const topPamEnd = topPamStart + pamLength;
      if (topPamStart < 0 || topPamEnd > reference.length) {
        droppedPam++;
        continue;
      }
      const topPam = reference.slice(topPamStart, topPamEnd);
      pamTop = entry.strand === 'forward' ? topPam : reverseComplement(topPam);
      pamIntact = pamMatches(pamTop, pam);
      if (requirePam && !pamIntact) {
        droppedPam++;
        continue;
      }
    }
    // The guide's own intended site: same top-strand window and strand, and an
    // exact match. Counted (not listed) so the caller can subtract it.
    const isOwn = ownStart !== undefined && entry.distance === 0 && start + 1 === ownStart && entry.strand === ownStrand;
    if (isOwn) {
      intended++;
      continue;
    }
    const site = {
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
    };
    if (options.pfsSpec !== undefined && options.pfsSpec !== null) {
      const pfs = observedPfs(reference, start, guideLength, entry.strand, options.pfsSpec);
      site.pfs = pfs.sequence;
      site.pfs_ok = pfs.ok;
    }
    sites.push(site);
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
    const allowed = IUPAC_MASKS[pattern[i]];
    if (allowed === undefined || (allowed & IUPAC_MASKS[triple[i]]) === 0) return false;
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
  const family = resolveCasFamily(options.casFamily ?? 'spcas9');
  const pam = family.pam === null ? '' : assertPamPattern(options.pam ?? family.pam, family.pamSide);
  const guideLength = options.guideLength ?? family.guideLength;
  if (guideLength < family.guideLengthMin || guideLength > family.guideLengthMax) {
    throw new MolbioInputError(`guide_length for ${family.id} must be between ${family.guideLengthMin} and ${family.guideLengthMax} nt (got ${guideLength})`);
  }
  const targetStrand = options.targetStrand ?? (family.target === 'RNA' ? 'forward' : 'both');
  const candidates = findProtospacers(sequence, {
    ...family.pam === null ? {} : { pam },
    pamSide: family.pamSide,
    guideLength,
    family,
    targetStrand,
  });
  const regionStart = options.regionStart ?? 1;
  const regionEnd = options.regionEnd ?? sequence.length;
  const inRegion = candidates.filter((hit) => hit.start >= regionStart && hit.end <= regionEnd);
  if (family.pamSide === 'none' && inRegion.length > CRISPR_LIMITS.maxCas13Candidates) {
    throw new MolbioInputError(`the Cas13 scan found ${inRegion.length} candidate windows in the requested region (limit ${CRISPR_LIMITS.maxCas13Candidates}); tighten region_start/region_end`);
  }
  const requirePfs = options.requirePfs === true;
  const evaluated = inRegion.map((hit) => {
    const metrics = evaluateGuide(hit.sequence, { ...options, family, pfsOk: hit.pfs_ok ?? true, requirePfs });
    return {
      sequence: hit.sequence,
      pam: hit.pam,
      strand: hit.strand,
      start: hit.start,
      end: hit.end,
      ...family.target === 'RNA' ? { rna_sequence: hit.sequence.replaceAll('T', 'U') } : {},
      ...hit.pfs === undefined || hit.pfs === '' ? {} : { pfs: hit.pfs.replaceAll('T', 'U'), pfs_ok: hit.pfs_ok ?? true },
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
        pamSide: family.pamSide,
        seedSide: family.seedSide,
        seedMismatchWindow: family.seedMismatchWindow,
        pfsSpec: family.pfs,
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
        const requirement = family.pamSide === 'none' ? 'with no PAM requirement (Cas13)' : 'and an intact PAM';
        guide.notes.push(`${guide.off_target_count} off-target site(s) with <= ${options.maxMismatches ?? 2} mismatch(es) ${requirement} in the supplied reference`);
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
        seedAny: guide.seed_self_any,
        hairpinTm: guide.hairpin_tm,
        guide: guide.sequence,
        pfsOk: guide.pfs_ok ?? true,
        offTargetCount: guide.off_target_count,
      }, { ...options, family });
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
    cas_family: family.id,
    cas_label: family.label,
    pam,
    pam_side: family.pamSide,
    pfs: family.pfs === null ? '' : family.pfs.label,
    target: family.target,
    target_strand: targetStrand,
    require_pfs: requirePfs,
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
