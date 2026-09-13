/**
 * dsh-molbio-tools/taqman.mjs
 *
 * TaqMan (hydrolysis probe) design on top of the v11-v13 primer engine: the
 * primer pair comes from design.mjs unchanged, and this module adds the probe
 * that makes a 5'-nuclease assay work.
 *
 * The probe rules encoded here are the standard assay-design heuristics every
 * probe-design guide states (Applied Biosystems / IDT / Primer3's
 * `PRIMER_TASK=pick_hyb_probe` family):
 *
 *   - the probe sits INSIDE the amplicon and overlaps neither primer — the
 *     preferred orientation is the amplicon's 5' gap (same reading direction as
 *     the forward primer, so it is cleaved as the polymerase extends); when no
 *     candidate fits there, the same chemistry is offered reverse-oriented, and
 *     the result says so;
 *   - a 5' guanine quenches the reporter even before cleavage, so the probe's
 *     5' base must not be G (the classic "no G at the 5' end" rule);
 *   - the probe Tm must exceed the primer Tm by a margin (`min_tm_delta`, 5 °C
 *     by default) so the probe stays annealed while the polymerase extends;
 *   - short probes (<= 30 nt) are extended by the polymerase even without
 *     cleavage, so a 3' terminal G is discouraged (`allow_3prime_g` opts in);
 *   - no mononucleotide runs (a G run in particular quenches and mis-hybridizes).
 *
 * Everything is an ESTIMATE from the same SantaLucia-1998 nearest-neighbour
 * model the primer tools use; none of it predicts assay efficiency.
 */

import {
  MolbioInputError,
  dimerThermo,
  findRepeats,
  findRuns,
  hairpinThermo,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfAnyScore,
  selfEndScore,
} from './lib.mjs';
import { designPrimers, resolveDesignOptions } from './design.mjs';

/** Probe-design bounds (primer bounds live in DESIGN_DEFAULTS). */
export const PROBE_DEFAULTS = {
  probeLenMin: 18,
  probeLenMax: 27,
  probeTmMin: 58,
  probeTmMax: 72,
  probeGcMin: 40,
  probeGcMax: 65,
  minTmDelta: 5,
  maxRun: 4,
  maxSelfAny: 8,
  minDistanceFromPrimer: 1,
  maxProbesPerAmplicon: 3,
  maxAmplicons: 5,
};

const round2 = (value) => Math.round(value * 100) / 100;

function pairTm(pair) {
  return Math.max(pair.forward.tm, pair.reverse.tm);
}

/** GC percent of a short DNA string (integer percent). */
function gcPercent(seq) {
  let gc = 0;
  for (const base of seq) {
    if (base === 'G' || base === 'C') gc++;
  }
  return seq.length === 0 ? 0 : round2((gc / seq.length) * 100);
}

function safeSelfAny(seq) {
  try {
    return selfAnyScore(seq);
  } catch {
    return 0;
  }
}

function safeSelfEnd(seq) {
  try {
    return selfEndScore(seq);
  } catch {
    return 0;
  }
}

function safeHairpinTm(seq, ctMolar) {
  try {
    const hairpins = hairpinThermo(seq, ctMolar); // sorted by Tm, highest first
    return hairpins.length === 0 ? 0 : hairpins[0].tm;
  } catch {
    return 0;
  }
}

function safeDimerAnyTm(a, b, ctMolar) {
  try {
    const dimer = dimerThermo(a, b, ctMolar);
    return dimer.any_tm ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Evaluate one probe candidate: thermodynamics, structure, and the heuristic
 * flags a designer must know before ordering it.
 */
export function evaluateProbe(seq, { tmOpts, ctMolar, primerTmMax, maxRun, maxSelfAny }) {
  const lower = seq.toUpperCase();
  const tm = primerTm(lower, tmOpts).tm_celsius;
  const gc = gcPercent(lower);
  const runs = findRuns(lower, maxRun + 1);
  const repeats = findRepeats(lower);
  const hairpin = safeHairpinTm(lower, ctMolar);
  const selfAny = safeSelfAny(lower);
  const selfEnd = safeSelfEnd(lower);
  const notes = [];
  if (lower[0] === 'G') notes.push('5\' terminal G: the guanine quenches the reporter even before cleavage — move the probe or pick the reverse strand');
  if (lower[lower.length - 1] === 'G') notes.push('3\' terminal G: a short probe is extended by the polymerase without cleavage — prefer a different 3\' base');
  if (runs.length > 0) notes.push(`mononucleotide run >= ${maxRun + 1} bases (${runs.map((run) => `${run.base}${run.count}`).join(', ')})`);
  if (repeats.length > 0) notes.push(`repeat motif ${repeats.map((repeat) => `${repeat.motif}x${repeat.count}`).join(', ')}`);
  if (hairpin > 45) notes.push(`stable hairpin (Tm ${round2(hairpin)} °C)`);
  if (selfAny > maxSelfAny) notes.push(`self-complementarity score ${selfAny} above ${maxSelfAny}`);
  const tmDelta = primerTmMax === undefined ? undefined : round2(tm - primerTmMax);
  if (tmDelta !== undefined && tmDelta < 0) notes.push(`probe Tm is ${Math.abs(tmDelta)} °C BELOW the hotter primer (target >= 0)`);
  const penalty =
    2.0 * Math.max(0, (primerTmMax ?? tm) - tm)
    + Math.abs(gc - 50) * 0.1
    + 0.3 * Math.max(0, hairpin - 40)
    + 0.4 * selfAny
    + 0.8 * selfEnd
    + 3.0 * runs.length
    + 2.0 * repeats.length
    + (lower[0] === 'G' ? 50 : 0)
    + (lower[lower.length - 1] === 'G' ? 20 : 0);
  return {
    sequence: lower,
    length: lower.length,
    tm: round2(tm),
    gc_percent: gc,
    tm_delta_vs_primer: tmDelta,
    hairpin_tm: round2(hairpin),
    self_any: selfAny,
    self_end: selfEnd,
    repeats: repeats.length,
    runs: runs.map((run) => ({ base: run.base, count: run.count, start: run.start })),
    five_prime_g: lower[0] === 'G',
    three_prime_g: lower[lower.length - 1] === 'G',
    notes,
    penalty: round2(penalty),
  };
}

/**
 * All probe candidates for one amplicon, ranked best-first.
 *
 * The primer pair is given as the two primers' binding intervals on the TOP
 * strand: `forwardInterval` (its 3' end is `end`) and `reverseInterval` (read
 * 5'→3' on the bottom strand, so ITS 3' end is the LOW coordinate `start`).
 *
 * An amplicon has two gaps between its primers, and each primer's 3' end faces
 * exactly one of them:
 *
 *            gap 1                        gap 2
 *   ... [reverse] 3' ------> 3' [forward] 5' ...    (forward primer on the right)
 *   ... [forward] 3' ------> 3' [reverse] 5' ...    (forward primer on the left)
 *
 * A hydrolysis probe is read outward from the primer whose 3' end faces its gap:
 *
 *   - `orientation: 'forward'` reads on the top strand out of the gap the
 *     FORWARD primer's 3' end faces — the standard design, in the same direction
 *     the polymerase extends;
 *   - `orientation: 'reverse'` reads on the bottom strand out of the gap the
 *     REVERSE primer's 3' end faces, reported reverse-complemented.
 *
 * In both cases the probe keeps `minGap` bases clear of that primer's 3' end and
 * stops before the other primer's 5' end, so it can never overlap a primer
 * binding site — a probe on a primer's site competes with that primer instead of
 * reporting the amplicon. One of the two gaps is often empty (primers sitting at
 * the template's edge leave room on one strand only), which is why the caller
 * falls back to the other orientation.
 *
 * `primerTmMax` is the hotter primer's Tm, used for the reported Tm margin.
 */
export function probeCandidates(template, forwardInterval, reverseInterval, opts, primerTmMax, { reverse = false } = {}) {
  const minGap = opts.minDistanceFromPrimer;
  const n = template.length;
  // The amplicon's single physical gap, on the top strand: the stretch between
  // the two primer binding sites, whichever order they are in. A probe only ever
  // lives in here.
  const forwardUpstream = forwardInterval.end < reverseInterval.start;
  const gap = forwardUpstream
    ? [forwardInterval.end - 1, reverseInterval.start - 1]
    : [reverseInterval.end - 1, forwardInterval.start - 1];
  // The primer whose 3' end opens the gap: it is the one the probe is read
  // outward from, and the 3' end the reported distance is measured against.
  const stem = forwardUpstream ? forwardInterval : reverseInterval;
  const work = reverse ? reverseComplement(template) : template;
  // On `work`, a top-strand interval [s, e] corresponds to [n-1-e, n-1-s].
  const windowStart = reverse ? n - 1 - gap[1] : gap[0] + minGap;
  const windowEnd = reverse ? n - 1 - gap[0] - minGap : gap[1] - minGap;
  const candidates = [];
  for (let length = opts.probeLenMin; length <= opts.probeLenMax; length++) {
    for (let start = windowStart; start + length - 1 <= windowEnd; start++) {
      const sequence = work.slice(start, start + length);
      const evaluated = evaluateProbe(sequence, {
        tmOpts: opts.tmOpts,
        ctMolar: opts.ctMolar,
        primerTmMax,
        maxRun: opts.maxRun,
        maxSelfAny: opts.maxSelfAny,
      });
      if (evaluated.gc_percent < opts.probeGcMin || evaluated.gc_percent > opts.probeGcMax) continue;
      if (evaluated.tm < opts.probeTmMin || evaluated.tm > opts.probeTmMax) continue;
      if (evaluated.five_prime_g) continue;
      if (evaluated.three_prime_g && opts.allowThreePrimeG !== true) continue;
      if (evaluated.runs.length > 0) continue;
      if (evaluated.repeats > 0) continue;
      if (evaluated.self_any > opts.maxSelfAny) continue;
      const templateStart = reverse ? n - (start + length) : start; // 0-based top-strand start
      const templateEnd = templateStart + length - 1;
      // Belt and braces: whatever the window arithmetic did, the probe must not
      // overlap either primer's binding site on the top strand.
      const overlaps = (interval) => templateStart <= interval.end - 1 && templateEnd >= interval.start - 1;
      if (overlaps(forwardInterval) || overlaps(reverseInterval)) continue;
      // Gap between the probe's 5' end and the 3' end of the primer it is read
      // from, in top-strand coordinates for both orientations.
      const distance = reverse ? stem.start - 1 - templateEnd : templateStart - (stem.end - 1);
      candidates.push({
        ...evaluated,
        orientation: reverse ? 'reverse' : 'forward',
        start: templateStart + 1,
        end: templateEnd + 1,
        distance_from_primer_3prime: distance,
        // Signed position of the probe's midpoint against the amplicon centre,
        // so a caller can see whether the probe sits centred or skewed.
        midpoint_offset: round2((templateStart + templateEnd) / 2 + 1 - (forwardInterval.end + reverseInterval.start) / 2),
      });
    }
  }
  candidates.sort((a, b) => a.penalty - b.penalty || a.start - b.start || a.length - b.length);
  // Drop candidates that differ only by a shifted window: keep the best of each
  // overlapping cluster so the caller gets distinct choices.
  const kept = [];
  for (const candidate of candidates) {
    if (kept.some((other) => other.orientation === candidate.orientation && candidate.start <= other.end && candidate.end >= other.start)) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * Design TaqMan assays on a template.
 *
 * @param {string} rawTemplate template sequence (IUPAC).
 * @param {object} rawOptions probe + primer options (snake_case, as the tool takes them).
 * @returns {{assays: Array, conditions: object, primer_options: object, notes: string[]}}
 */
export function designTaqmanProbes(rawTemplate, rawOptions = {}) {
  const template = normalizeSequence(rawTemplate);
  const opts = { ...PROBE_DEFAULTS };
  for (const [key, value] of Object.entries(rawOptions)) {
    if (value !== undefined && value !== null) opts[key] = value;
  }
  // A hydrolysis-probe assay is deliberately short (the amplicon is the stretch
  // the polymerase must traverse before it reaches and cleaves the probe), so
  // the primer engine runs with qPCR-style windows unless the caller overrides
  // them through primer_options. The primer engine's own ranking knows nothing
  // about probes, so it is asked for a POOL several times the number of assays
  // wanted — otherwise a high-ranking amplicon with no usable probe window
  // would hide every workable one behind it.
  const primerOptions = {
    ampliconMin: 70,
    ampliconMax: 200,
    // The engine leaves region_start undefined when it is not given (meaning
    // "the whole template"), which would surface as a null in the reported
    // windows — state the window explicitly instead.
    regionStart: 1,
    regionEnd: template.length,
    maxResults: Math.min(50, Math.max(10, opts.maxAmplicons * 4)),
    ...primerEngineOptions(rawOptions.primer_options ?? {}),
  };
  const { pairs, opts: primerOpts } = designPrimers(template, primerOptions);
  opts.tmOpts = primerOpts.tmOpts;
  opts.ctMolar = primerOpts.ctMolar;

  const conditions = {
    na_mm: primerOpts.naMm,
    mg_mm: primerOpts.mgMm,
    dntp_mm: primerOpts.dntpMm,
    primer_nm: primerOpts.primerNm,
  };
  const notes = [];
  const emptyAmplicons = [];
  const assays = [];
  for (const pair of pairs) {
    const hotter = pairTm(pair);
    const window = (orientation) => probeCandidates(
      template,
      { start: pair.forward.start, end: pair.forward.end },
      { start: pair.reverse.start, end: pair.reverse.end },
      opts,
      hotter,
      { reverse: orientation === 'reverse' },
    );
    // Preference order, stated rather than hidden: (1) a probe in the amplicon's
    // 5' gap that clears the Tm margin, (2) one on the other strand that does,
    // (3) the best candidate that exists even if the margin is short. Only a
    // probe that exists at all can be reported.
    const forwardOriented = window('forward');
    const reverseOriented = forwardOriented.length === 0 ? window('reverse') : [];
    const clears = (probe) => (probe.tm_delta_vs_primer ?? 0) >= opts.minTmDelta;
    const pooled = forwardOriented.length > 0 ? forwardOriented : reverseOriented;
    const strict = pooled.filter(clears);
    if (strict.length === 0 && pooled.length > 0) {
      notes.push(`amplicon ${pair.amplicon.start}-${pair.amplicon.end}: no probe clears the ${opts.minTmDelta} °C Tm margin over the primers; the best available probe(s) are reported and flagged`);
    } else if (forwardOriented.length === 0 && reverseOriented.length > 0) {
      notes.push(`amplicon ${pair.amplicon.start}-${pair.amplicon.end}: no probe fits the amplicon's 5' gap, so the probe is reported reverse-oriented (same chemistry, opposite strand: order the sequence as given and use it as the probe, or reverse-complement it to read it on the forward strand)`);
    }
    const used = (strict.length > 0 ? strict : pooled).slice(0, opts.maxProbesPerAmplicon);
    for (const probe of used) {
      // The probe must also be independent of the primers at the sequence level:
      // a probe that self-dimerizes with a primer out-competes the amplicon.
      probe.dimer_tm_vs_forward = round2(safeDimerAnyTm(probe.sequence, pair.forward.sequence, opts.ctMolar));
      probe.dimer_tm_vs_reverse = round2(safeDimerAnyTm(probe.sequence, pair.reverse.sequence, opts.ctMolar));
      if (Math.max(probe.dimer_tm_vs_forward, probe.dimer_tm_vs_reverse) > 47) {
        probe.notes = [...probe.notes, 'probe forms a stable dimer with a primer (Tm > 47 °C) — prefer another probe'];
      }
      assays.push({
        forward: pair.forward,
        reverse: pair.reverse,
        amplicon: pair.amplicon,
        probe,
        pair_penalty: pair.penalty,
        assay_penalty: round2(pair.penalty + probe.penalty),
      });
    }
    if (used.length === 0) {
      emptyAmplicons.push(`${pair.amplicon.start}-${pair.amplicon.end}`);
    }
  }
  if (emptyAmplicons.length > 0) {
    const shown = emptyAmplicons.slice(0, 5).join(', ');
    notes.push(`${emptyAmplicons.length} amplicon(s) yielded no probe inside the Tm/GC/length window (${shown}${emptyAmplicons.length > 5 ? ', …' : ''}) — widen probe_len_min/max, probe_tm_min/max or probe_gc_min/max`);
  }
  if (pairs.length === 0) {
    notes.push('no primer pair satisfied the primer constraints — relax the primer windows (Tm/GC/amplicon) and retry');
  }
  assays.sort((a, b) => a.assay_penalty - b.assay_penalty || a.amplicon.start - b.amplicon.start);
  const best = [];
  const seenAmplicons = new Set();
  for (const assay of assays) {
    const key = `${assay.amplicon.start}:${assay.amplicon.end}`;
    if (!seenAmplicons.has(key)) {
      if (seenAmplicons.size >= opts.maxAmplicons) continue;
      seenAmplicons.add(key);
    }
    best.push(assay);
  }
  return {
    assays: best,
    conditions,
    primer_options: {
      region: [primerOpts.regionStart, primerOpts.regionEnd ?? template.length],
      amplicon: [primerOpts.ampliconMin, primerOpts.ampliconMax],
      tm: [primerOpts.tmMin, primerOpts.tmMax],
      gc: [primerOpts.gcMin, primerOpts.gcMax],
    },
    probe_options: {
      length: [opts.probeLenMin, opts.probeLenMax],
      tm: [opts.probeTmMin, opts.probeTmMax],
      gc: [opts.probeGcMin, opts.probeGcMax],
      min_tm_delta_vs_primer: opts.minTmDelta,
    },
    notes,
  };
}

/**
 * The primer-engine option names (camelCase, as `designPrimers` takes them) for
 * the snake_case keys this module's callers pass in `primer_options`. Without
 * this map a mistyped option would silently fall back to a default instead of
 * being validated — 0.9.0 shipped that bug for one test run, which is why the
 * mapping is explicit here rather than a convention.
 */
const PRIMER_OPTION_KEYS = {
  region_start: 'regionStart',
  region_end: 'regionEnd',
  primer_len_min: 'lenMin',
  primer_len_max: 'lenMax',
  tm_min: 'tmMin',
  tm_max: 'tmMax',
  gc_min: 'gcMin',
  gc_max: 'gcMax',
  amplicon_min: 'ampliconMin',
  amplicon_max: 'ampliconMax',
  gc_clamp: 'gcClamp',
  max_run: 'maxRun',
  max_self_any: 'maxSelfAny',
  max_self_end: 'maxSelfEnd',
  max_hairpin_tm: 'maxHairpinTm',
  max_dimer_tm: 'maxDimerTm',
  max_dimer_end_tm: 'maxDimerEndTm',
  max_end_stability: 'maxEndStability',
  max_end_gc: 'maxEndGc',
  max_tm_delta: 'maxTmDelta',
  max_mismatches: 'maxMismatches',
  max_3prime_mismatches: 'max3PrimeMismatches',
  mismatch_3prime_zone: 'mismatch3PrimeZone',
  check_mispriming: 'checkMispriming',
  mispriming_3prime_bases: 'mispriming3PrimeBases',
  mispriming_max_mismatches: 'misprimingMaxMismatches',
  mispriming_max_sites: 'misprimingMaxSites',
  max_results: 'maxResults',
  na_mm: 'naMm',
  mg_mm: 'mgMm',
  dntp_mm: 'dntpMm',
  primer_nm: 'primerNm',
  target_position: 'targetPosition',
  target_penalty: 'targetPenalty',
};

/** Translate snake_case `primer_options` into the engine's camelCase options. */
export function primerEngineOptions(raw = {}) {
  const translated = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const engineKey = PRIMER_OPTION_KEYS[key];
    if (engineKey === undefined) {
      throw new MolbioInputError(`primer_options has an unknown option ${JSON.stringify(key)}; known: ${Object.keys(PRIMER_OPTION_KEYS).join(', ')}`);
    }
    translated[engineKey] = value;
  }
  return translated;
}

/**
 * Validate the probe option ranges the tool accepts. The nested primer options
 * are translated to the engine's own option names and validated by
 * `resolveDesignOptions`, so both halves of an assay are checked by the code
 * that will run them.
 */
export function resolveProbeOptions(raw = {}) {
  const opts = { ...PROBE_DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== null && key !== 'primer_options') opts[key] = value;
  }
  if (!Number.isInteger(opts.probeLenMin) || opts.probeLenMin < 12) throw new MolbioInputError('probe_len_min must be an integer >= 12');
  if (!Number.isInteger(opts.probeLenMax) || opts.probeLenMax > 40 || opts.probeLenMax < opts.probeLenMin) throw new MolbioInputError('probe_len_max must be an integer between probe_len_min and 40');
  if (!(opts.probeTmMin < opts.probeTmMax)) throw new MolbioInputError('probe_tm_min must be lower than probe_tm_max');
  if (!(opts.probeGcMin < opts.probeGcMax)) throw new MolbioInputError('probe_gc_min must be lower than probe_gc_max');
  if (!(typeof opts.minTmDelta === 'number' && opts.minTmDelta >= 0)) throw new MolbioInputError('min_tm_delta must be a non-negative number (°C)');
  if (!Number.isInteger(opts.maxRun) || opts.maxRun < 2 || opts.maxRun > 8) throw new MolbioInputError('probe_max_run must be an integer between 2 and 8');
  if (!(typeof opts.maxSelfAny === 'number' && opts.maxSelfAny >= 0)) throw new MolbioInputError('probe_max_self_any must be a non-negative number');
  if (!Number.isInteger(opts.minDistanceFromPrimer) || opts.minDistanceFromPrimer < 0 || opts.minDistanceFromPrimer > 12) throw new MolbioInputError('probe_min_distance_from_primer must be an integer between 0 and 12 (bp the probe keeps clear of each primer)');
  if (!Number.isInteger(opts.maxProbesPerAmplicon) || opts.maxProbesPerAmplicon < 1 || opts.maxProbesPerAmplicon > 10) throw new MolbioInputError('max_probes_per_amplicon must be an integer between 1 and 10');
  if (!Number.isInteger(opts.maxAmplicons) || opts.maxAmplicons < 1 || opts.maxAmplicons > 50) throw new MolbioInputError('max_amplicons must be an integer between 1 and 50');
  // Reuse the primer engine's own validation for the nested primer options.
  resolveDesignOptions(primerEngineOptions(raw.primer_options ?? {}));
  return opts;
}
