/**
 * dsh-molbio-tools/multiplex.mjs
 *
 * Multiplex PCR compatibility checking: given several amplicons designed on the
 * same template (each a named primer pair), report the interactions that make a
 * multiplex fail — primer cross-dimers between different targets, primers that
 * anneal at an unintended site (in their own or another target's template), and
 * amplicons that are too close in size to be told apart on a gel.
 *
 * Everything reuses the v12 thermodynamics (`lib.mjs`): dimer Tm and hairpin Tm
 * are the same Primer3-aligned NN folding temperatures the single-target primer
 * designer uses, so a number here means the same thing it means there.
 *
 * All values are ESTIMATES for ranking and triage; a real multiplex still has to
 * be optimized at the bench.
 */

import {
  MolbioInputError,
  DNA_BASES,
  dimerThermo,
  findRuns,
  hairpinThermo,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfAnyScore,
  selfEndScore,
} from './lib.mjs';

/** Bounds for the multiplex checker. */
export const MULTIPLEX_DEFAULTS = {
  maxTargets: 30,
  maxSequenceLength: 50000,
  /** Dimer Tm at which a primer pair interaction is reported as conflicting. */
  dimerTmThreshold: 47,
  /** Amplicon size difference below which two bands are called indistinguishable. */
  minSizeSeparationBp: 20,
  /** Amplicon size difference below which two bands are called close. */
  warnSizeSeparationBp: 40,
  /** Length of the 3' tail checked for unintended annealing. */
  mispriming3PrimeBases: 8,
  misprimingMaxMismatches: 1,
  /** Sites reported per primer (the count is always complete). */
  maxSitesReported: 6,
  /** Concentration used for folding Tm (nM primer -> molar). */
  primerNm: 200,
  /** Annealing-temperature recommendation: lowest primer Tm minus this offset. */
  annealingOffsetC: 3,
  /** Half-width of the recommended annealing window, °C. */
  annealingWindowC: 1,
  /** A primer-Tm spread above this makes one annealing temperature a compromise. */
  tmSpreadWarnC: 5,
  /** Starting primer concentration for every target, nM. */
  primerConcentrationNm: 200,
};

const round2 = (value) => Math.round(value * 100) / 100;

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
    const hairpins = hairpinThermo(seq, ctMolar);
    return hairpins.length === 0 ? 0 : hairpins[0].tm;
  } catch {
    return 0;
  }
}

function safeDimerThermo(a, b, ctMolar) {
  try {
    return dimerThermo(a, b, ctMolar);
  } catch {
    return { any_tm: 0, end_tm: 0 };
  }
}

/**
 * Build a k-mer index over one template for the 3'-tail annealing check.
 * Canonical k-mers only (an ambiguous template base disqualifies its windows,
 * which is the honest reading: an ambiguous base may or may not pair).
 */
function buildKmerIndex(seq, k) {
  const index = new Map();
  for (let start = 0; start + k <= seq.length; start++) {
    const key = seq.slice(start, start + k);
    if (![...key].every((base) => DNA_BASES.has(base))) continue;
    const list = index.get(key);
    if (list === undefined) index.set(key, [start]);
    else list.push(start);
  }
  return index;
}

/** Every spelling of `tail` within `maxMismatches` substitutions (tail <= 10). */
function tailVariants(tail, maxMismatches, limit = 400) {
  const bases = ['A', 'C', 'G', 'T'];
  const out = [tail];
  if (maxMismatches >= 1) {
    for (let i = 0; i < tail.length; i++) {
      for (const base of bases) {
        if (base !== tail[i]) out.push(tail.slice(0, i) + base + tail.slice(i + 1));
      }
    }
  }
  if (maxMismatches >= 2) {
    for (let i = 0; i < tail.length; i++) {
      for (let j = i + 1; j < tail.length; j++) {
        for (const a of bases) {
          if (a === tail[i]) continue;
          for (const b of bases) {
            if (b === tail[j]) continue;
            out.push(tail.slice(0, i) + a + tail.slice(i + 1, j) + b + tail.slice(j + 1));
          }
        }
      }
    }
  }
  return out.slice(0, limit);
}

/** Hamming distance between equal-length canonical strings. */
function hamming(a, b) {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

/**
 * Sites where `tail` (a primer's 3' end) can anneal on either strand of
 * `template`. The caller filters out the primer's own binding site by comparing
 * the full primer length at each hit, so no position has to be special-cased
 * here.
 */
function annealSites(tail, template, index, opts) {
  const k = tail.length;
  const found = new Map();
  for (const key of tailVariants(tail, opts.misprimingMaxMismatches)) {
    const mismatches = hamming(key, tail);
    for (const [lookup, strand] of [[key, 'bottom'], [reverseComplement(key), 'top']]) {
      const positions = index.get(lookup);
      if (positions === undefined) continue;
      for (const position of positions) {
        const id = `${strand}:${position}`;
        if (found.has(id)) continue;
        found.set(id, { strand, position: position + 1, matches: k - mismatches });
      }
    }
  }
  return [...found.values()].sort((a, b) => b.matches - a.matches || a.position - b.position);
}

/**
 * Check a set of multiplex amplicons for mutual interference.
 *
 * @param {Array<{name, sequence, forward?, reverse?, forward_tm?, reverse_tm?, amplicon_start?, amplicon_end?}>} targets
 *   One entry per amplicon. `sequence` is the template the pair was designed on
 *   (each target may have its own, e.g. different genes); `forward`/`reverse`
 *   are the primer sequences (5'→3', as ordered).
 * @param {object} [rawOptions] overrides for {@link MULTIPLEX_DEFAULTS}.
 */
export function checkMultiplex(rawTargets, rawOptions = {}) {
  const opts = { ...MULTIPLEX_DEFAULTS };
  for (const [key, value] of Object.entries(rawOptions)) {
    if (value !== undefined && value !== null) opts[key] = value;
  }
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) throw new MolbioInputError('targets must be a non-empty array of {name, sequence, forward, reverse}');
  if (rawTargets.length > opts.maxTargets) throw new MolbioInputError(`targets has ${rawTargets.length} entries; the limit is ${opts.maxTargets} per call`);
  if (!(opts.dimerTmThreshold > 0)) throw new MolbioInputError('dimer_tm_threshold must be a positive temperature in °C');
  if (!Number.isInteger(opts.minSizeSeparationBp) || opts.minSizeSeparationBp < 0) throw new MolbioInputError('min_size_separation_bp must be a non-negative integer');
  if (!(typeof opts.annealingOffsetC === 'number' && Number.isFinite(opts.annealingOffsetC) && opts.annealingOffsetC >= 0 && opts.annealingOffsetC <= 15)) {
    throw new MolbioInputError('annealing_offset_c must be a number between 0 and 15 (°C below the lowest primer Tm)');
  }
  if (!(typeof opts.annealingWindowC === 'number' && Number.isFinite(opts.annealingWindowC) && opts.annealingWindowC >= 0 && opts.annealingWindowC <= 5)) {
    throw new MolbioInputError('annealing_window_c must be a number between 0 and 5 (°C on each side of the recommendation)');
  }
  if (!(typeof opts.tmSpreadWarnC === 'number' && Number.isFinite(opts.tmSpreadWarnC) && opts.tmSpreadWarnC >= 0 && opts.tmSpreadWarnC <= 20)) {
    throw new MolbioInputError('tm_spread_warn_c must be a number between 0 and 20');
  }
  if (!(typeof opts.primerConcentrationNm === 'number' && Number.isFinite(opts.primerConcentrationNm) && opts.primerConcentrationNm >= 20 && opts.primerConcentrationNm <= 1000)) {
    throw new MolbioInputError('primer_concentration_nm must be a number between 20 and 1000');
  }

  const ctMolar = opts.primerNm * 1e-9;
  const targets = rawTargets.map((target, index) => {
    const label = target?.name ?? `target${index + 1}`;
    if (typeof target?.sequence !== 'string' || target.sequence === '') throw new MolbioInputError(`target ${JSON.stringify(label)} needs a template sequence`);
    const template = normalizeSequence(target.sequence, `target ${label} sequence`);
    if (template.length > opts.maxSequenceLength) {
      throw new MolbioInputError(`target ${JSON.stringify(label)} is ${template.length} bp; the limit is ${opts.maxSequenceLength} bp per target`);
    }
    const forward = target.forward === undefined ? undefined : normalizeSequence(target.forward, `target ${label} forward primer`);
    const reverse = target.reverse === undefined ? undefined : normalizeSequence(target.reverse, `target ${label} reverse primer`);
    if ((forward === undefined) !== (reverse === undefined)) {
      throw new MolbioInputError(`target ${JSON.stringify(label)} must give both forward and reverse primers, or neither`);
    }
    return {
      name: String(label),
      template,
      forward,
      reverse,
      forwardTm: target.forward_tm ?? (forward === undefined ? undefined : primerTm(forward, { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: opts.primerNm }).tm_celsius),
      reverseTm: target.reverse_tm ?? (reverse === undefined ? undefined : primerTm(reverse, { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: opts.primerNm }).tm_celsius),
      ampliconStart: target.amplicon_start,
      ampliconEnd: target.amplicon_end,
      index,
    };
  });

  // Every primer in the panel, tagged with the target it belongs to.
  const primers = [];
  for (const target of targets) {
    if (target.forward === undefined) continue;
    for (const [role, sequence] of [['forward', target.forward], ['reverse', target.reverse]]) {
      primers.push({
        target: target.name,
        targetIndex: target.index,
        role,
        sequence,
        tm: round2(role === 'forward' ? target.forwardTm : target.reverseTm),
        gc_percent: round2(([...sequence].filter((base) => base === 'G' || base === 'C').length / sequence.length) * 100),
        hairpin_tm: round2(safeHairpinTm(sequence, ctMolar)),
        self_any: safeSelfAny(sequence),
        self_end: safeSelfEnd(sequence),
        runs: findRuns(sequence, 4).length,
      });
    }
  }

  // Annealing temperature: one tube, one temperature. The defensible starting
  // point is the LOWEST primer Tm minus a small offset, because a primer that
  // melts below the set temperature is the one that drops out first. This is a
  // rule of thumb, not a thermal-cycling optimisation — the note says so.
  const annealing = primers.length === 0 ? null : (() => {
    const tms = primers.map((primer) => primer.tm);
    const minTm = Math.min(...tms);
    const maxTm = Math.max(...tms);
    const spread = round2(maxTm - minTm);
    const limiting = primers.reduce((best, primer) => (primer.tm < best.tm ? primer : best));
    const recommended = round2(minTm - opts.annealingOffsetC);
    return {
      min_primer_tm: round2(minTm),
      max_primer_tm: round2(maxTm),
      spread_c: spread,
      recommended_c: recommended,
      range_c: [round2(recommended - opts.annealingWindowC), round2(recommended + opts.annealingWindowC)],
      limiting_primer: `${limiting.target}/${limiting.role}`,
      offset_c: opts.annealingOffsetC,
      window_c: opts.annealingWindowC,
      tm_spread_ok: spread <= opts.tmSpreadWarnC,
      note: 'Starting point: the lowest primer Tm minus the configured offset; optimise on the bench with a temperature gradient.',
    };
  })();

  // Cross interactions: every primer pair that is not the same primer. Within a
  // target, forward+reverse is the intended pair (its dimer was already checked
  // by the designer), so the conflicts are the CROSS-target ones plus each
  // primer against the other target's primers.
  const interactions = [];
  for (let i = 0; i < primers.length; i++) {
    for (let j = i + 1; j < primers.length; j++) {
      const a = primers[i];
      const b = primers[j];
      const intraTarget = a.targetIndex === b.targetIndex;
      const intendedPair = intraTarget && a.role !== b.role;
      const dimer = safeDimerThermo(a.sequence, b.sequence, ctMolar);
      const conflicting = dimer.any_tm > opts.dimerTmThreshold || dimer.end_tm > opts.dimerTmThreshold;
      if (!conflicting && intendedPair) continue; // a benign intended pair is noise
      interactions.push({
        a: `${a.target}/${a.role}`,
        b: `${b.target}/${b.role}`,
        cross_target: !intraTarget,
        any_tm: round2(dimer.any_tm),
        end_tm: round2(dimer.end_tm),
        conflict: conflicting,
      });
    }
  }
  interactions.sort((x, y) => y.end_tm - x.end_tm || y.any_tm - x.any_tm);

  // Unintended annealing, split by what it means:
  //   - own template: a site in the primer's own template that is not its
  //     intended binding site (it will amplify the wrong product there);
  //   - other templates: the same 3' tail present in ANOTHER target's template
  //     (the classic multiplex cross-reaction).
  // Targets that share a template sequence are one template — otherwise every
  // primer would "cross-react" with its own amplicon listed under another name.
  const ownIndexes = targets.map((target) => buildKmerIndex(target.template, opts.mispriming3PrimeBases));
  const distinctTemplates = [];
  const templateIndexBySequence = new Map();
  for (const target of targets) {
    if (!templateIndexBySequence.has(target.template)) {
      templateIndexBySequence.set(target.template, distinctTemplates.length);
      distinctTemplates.push({ sequence: target.template, index: buildKmerIndex(target.template, opts.mispriming3PrimeBases) });
    }
  }
  const ownTemplateId = (target) => templateIndexBySequence.get(target.template);
  const isOwnSite = (site, target, primer) => {
    const start = site.position - 1;
    const window = target.template.slice(start, start + primer.sequence.length);
    const onStrand = site.strand === 'top' ? window : reverseComplement(window);
    return onStrand === primer.sequence;
  };
  const mispriming = [];
  for (const primer of primers) {
    const tail = primer.sequence.slice(-opts.mispriming3PrimeBases);
    const own = targets[primer.targetIndex];
    const ownSites = annealSites(tail, own.template, ownIndexes[primer.targetIndex], opts).filter((site) => !isOwnSite(site, own, primer));
    if (ownSites.length > 0) {
      mispriming.push({
        primer: `${primer.target}/${primer.role}`,
        scope: 'own_template',
        target: own.name,
        count: ownSites.length,
        perfect_count: ownSites.filter((site) => site.matches === opts.mispriming3PrimeBases).length,
        sites: ownSites.slice(0, opts.maxSitesReported),
      });
    }
    // Cross-template: only a perfect 3'-tail match counts, which is what makes a
    // primer actually extend on the wrong template.
    const perTemplate = [];
    for (const [templateId, template] of distinctTemplates.entries()) {
      if (templateId === ownTemplateId(own)) continue;
      const sites = annealSites(tail, template.sequence, template.index, { ...opts, misprimingMaxMismatches: 0 });
      if (sites.length === 0) continue;
      perTemplate.push({ template: templateId + 1, positions: sites.slice(0, opts.maxSitesReported).map((site) => site.position), count: sites.length });
    }
    if (perTemplate.length > 0) {
      mispriming.push({
        primer: `${primer.target}/${primer.role}`,
        scope: 'other_templates',
        target: own.name,
        count: perTemplate.reduce((sum, entry) => sum + entry.count, 0),
        perfect_count: perTemplate.reduce((sum, entry) => sum + entry.count, 0),
        templates: perTemplate,
        sites: [],
      });
    }
  }
  mispriming.sort((x, y) => Number(y.scope === 'other_templates') - Number(x.scope === 'other_templates') || y.count - x.count);

  // Amplicon sizes: from explicit coordinates when given, otherwise the size is
  // simply absent (an unknown length must not travel as `undefined`, which is
  // not lossless JSON).
  const sizes = targets.map((target) => {
    const known = target.ampliconStart !== undefined && target.ampliconEnd !== undefined;
    return {
      name: target.name,
      ...known ? { start: target.ampliconStart, end: target.ampliconEnd, length: target.ampliconEnd - target.ampliconStart + 1 } : {},
    };
  });
  const sizeConflicts = [];
  for (let i = 0; i < sizes.length; i++) {
    for (let j = i + 1; j < sizes.length; j++) {
      const a = sizes[i];
      const b = sizes[j];
      if (a.length === undefined || b.length === undefined) continue;
      const difference = Math.abs(a.length - b.length);
      if (difference > opts.warnSizeSeparationBp) continue;
      sizeConflicts.push({
        a: a.name,
        b: b.name,
        a_length: a.length,
        b_length: b.length,
        difference_bp: difference,
        severity: difference < opts.minSizeSeparationBp ? 'indistinguishable' : 'close',
      });
    }
  }
  sizeConflicts.sort((x, y) => x.difference_bp - y.difference_bp);

  // Primer concentrations: a multiplex is a competition, and a much shorter
  // amplicon can out-compete a longer one. The plan is deliberately conservative
  // — it starts every pair at the same concentration and only shifts the
  // extremes when the size ratio is at least 2x. It is a starting point, not a
  // measured optimum; the rationale field says which case each target is in.
  const knownSizes = sizes.filter((entry) => entry.length !== undefined).map((entry) => entry.length);
  const minSize = knownSizes.length === 0 ? undefined : Math.min(...knownSizes);
  const maxSize = knownSizes.length === 0 ? undefined : Math.max(...knownSizes);
  const sizeRatio = minSize === undefined || minSize === 0 || maxSize === undefined ? 1 : maxSize / minSize;
  const primerConcentrations = targets.map((target) => {
    const size = sizes.find((entry) => entry.name === target.name)?.length;
    let recommended = opts.primerConcentrationNm;
    let rationale = 'panel default; no size-based adjustment applies';
    if (knownSizes.length >= 2 && sizeRatio >= 2 && size !== undefined) {
      if (size === minSize) {
        recommended = Math.round(opts.primerConcentrationNm * 0.75);
        rationale = 'shortest amplicon in the panel; a lower share limits its competitive advantage';
      } else if (size === maxSize) {
        recommended = Math.round(opts.primerConcentrationNm * 1.5);
        rationale = 'longest amplicon in the panel; a higher share compensates for lower amplification efficiency';
      } else {
        rationale = 'panel default; between the shortest and longest amplicon';
      }
    }
    return { target: target.name, recommended_nm: recommended, rationale };
  });
  const concentrationNote = knownSizes.length >= 2 && sizeRatio >= 2
    ? `amplicon sizes span ${minSize}-${maxSize} bp (${round2(sizeRatio)}x); the plan lowers the shortest and raises the longest pair — a starting point, not a measured optimum`
    : '';

  const blockingInteractions = interactions.filter((entry) => entry.conflict && entry.cross_target);
  const blockingMispriming = mispriming.filter((entry) => entry.scope === 'other_templates');
  const blockingSizes = sizeConflicts.filter((entry) => entry.severity === 'indistinguishable');

  const advice = [];
  for (const entry of blockingInteractions.slice(0, 5)) {
    advice.push(`redesign ${entry.a} or ${entry.b}: their 3'-anchored dimer Tm is ${entry.end_tm} °C (threshold ${opts.dimerTmThreshold})`);
  }
  for (const entry of blockingMispriming.slice(0, 5)) {
    const templates = entry.templates.map((template) => `template ${template.template} (${template.positions.join(', ')})`).join('; ');
    advice.push(`${entry.primer} also matches ${entry.count} site(s) in another panel template: ${templates} — that primer can amplify the wrong target`);
  }
  for (const entry of blockingSizes.slice(0, 5)) {
    advice.push(`${entry.a} (${entry.a_length} bp) and ${entry.b} (${entry.b_length} bp) differ by only ${entry.difference_bp} bp — not resolvable on a standard gel`);
  }
  if (annealing !== null) {
    advice.push(`set the annealing temperature around ${annealing.recommended_c} °C (range ${annealing.range_c[0]}-${annealing.range_c[1]} °C): the lowest-Tm primer is ${annealing.limiting_primer} at ${annealing.min_primer_tm} °C`);
    if (!annealing.tm_spread_ok) {
      advice.push(`primer Tm spread is ${annealing.spread_c} °C (${annealing.min_primer_tm}-${annealing.max_primer_tm} °C) — one annealing temperature cannot be optimal for all; redesign the outlier primer(s) or use a two-step protocol`);
    }
  }
  if (concentrationNote !== '') advice.push(concentrationNote);

  return {
    compatible: blockingInteractions.length === 0 && blockingMispriming.length === 0 && blockingSizes.length === 0,
    target_count: targets.length,
    template_count: distinctTemplates.length,
    primer_count: primers.length,
    // Drop the internal template index: it is an implementation detail of the
    // cross-template search, not part of the report.
    primers: primers.map(({ targetIndex, ...primer }) => primer),
    interactions,
    conflicting_interactions: interactions.filter((entry) => entry.conflict).length,
    cross_target_conflicts: blockingInteractions.length,
    mispriming,
    cross_template_mispriming: blockingMispriming.length,
    amplicons: sizes,
    size_conflicts: sizeConflicts,
    annealing,
    primer_concentrations: primerConcentrations,
    concentration_note: concentrationNote,
    advice,
    notes: [
      'Dimer/hairpin Tms are the same SantaLucia-1998 nearest-neighbour estimates the primer designer uses; they rank risk, they do not predict a multiplex outcome.',
      'Cross-template annealing is searched with a perfect 3\' tail only; own-template mispriming allows the configured mismatch tolerance.',
      'The annealing temperature is a rule of thumb (lowest primer Tm minus the configured offset), not a thermal-cycling optimisation; run a gradient.',
      'Primer concentrations are starting points chosen from amplicon-size balance, not measured optima; rebalance empirically.',
      'A panel that passes this check can still fail on the bench: template competition, unequal primer efficiencies and amplicon secondary structure are not modelled here.',
    ],
  };
}
