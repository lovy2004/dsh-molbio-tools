/**
 * dsh-molbio-tools/thermo.mjs
 *
 * Duplex thermodynamics beyond a single Tm: for one DNA oligo this module
 * reports the nearest-neighbour enthalpy, entropy (raw and salt-corrected),
 * ΔG at 37 °C and Tm, plus the two structure checks the primer tools already
 * score — hairpin stems and self/hetero dimers.
 *
 * ── What this module will NOT do ────────────────────────────────────────────
 * Mismatched duplexes have their own published parameter sets (Allawi &
 * SantaLucia 1997/1998) and this module does not carry them. Rather than
 * silently feeding a mismatch through Watson–Crick parameters — which yields a
 * plausible-looking number that is wrong by several kcal/mol — a supplied
 * `partner` that is not the exact reverse complement is REFUSED, with the
 * mismatching positions named. Same for ambiguity codes: IUPAC symbols have no
 * nearest-neighbour parameters, so they are refused rather than guessed.
 *
 * The salt/concentration model is deliberately the SAME one `lib.primerTm`
 * uses (von Ahsen 2001 magnesium equivalence, SantaLucia 1998 entropy
 * correction), so this tool can never disagree with the primer tools about a
 * sequence both of them see.
 */
import {
  DNA_BASES,
  MolbioInputError,
  dimerThermo,
  duplexThermodynamics,
  endStability5,
  hairpinThermo,
  normalizeSequence,
  reverseComplement,
} from './lib.mjs';

/** Defaults shared by the tool and its tests. */
export const DUPLEX_THERMO_DEFAULTS = Object.freeze({
  naMm: 50,
  mgMm: 1.5,
  dntpMm: 0.8,
  oligoNm: 250,
  hairpins: 3,
});

/** Longest oligo this model is offered for (structure enumeration is quadratic). */
const MAX_OLIGO_LENGTH = 200;

function round2(value) {
  return Math.round(value * 100) / 100;
}

function finiteOrUndefined(value, field) {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new MolbioInputError(`${field} must be a finite number`);
  return parsed;
}

/**
 * Validate and default the condition knobs. Every value is range-checked here
 * so a mistyped concentration fails loudly instead of producing a Tm that looks
 * plausible and is not.
 */
export function resolveThermoOptions(raw = {}) {
  const na_mm = finiteOrUndefined(raw.na_mm, 'na_mm') ?? DUPLEX_THERMO_DEFAULTS.naMm;
  const mg_mm = finiteOrUndefined(raw.mg_mm, 'mg_mm') ?? DUPLEX_THERMO_DEFAULTS.mgMm;
  const dntp_mm = finiteOrUndefined(raw.dntp_mm, 'dntp_mm') ?? DUPLEX_THERMO_DEFAULTS.dntpMm;
  const oligo_nm = finiteOrUndefined(raw.oligo_nm, 'oligo_nm') ?? DUPLEX_THERMO_DEFAULTS.oligoNm;
  const hairpins = raw.hairpins ?? DUPLEX_THERMO_DEFAULTS.hairpins;
  if (na_mm < 0 || na_mm > 1000) throw new MolbioInputError('na_mm must be between 0 and 1000 mM');
  if (mg_mm < 0 || mg_mm > 500) throw new MolbioInputError('mg_mm must be between 0 and 500 mM');
  if (dntp_mm < 0 || dntp_mm > 500) throw new MolbioInputError('dntp_mm must be between 0 and 500 mM');
  if (oligo_nm < 0.01 || oligo_nm > 1e6) throw new MolbioInputError('oligo_nm must be between 0.01 and 1,000,000 nM');
  if (!Number.isInteger(hairpins) || hairpins < 0 || hairpins > 10) {
    throw new MolbioInputError('hairpins must be an integer between 0 and 10 (0 disables the structure scan)');
  }
  return { naMm: na_mm, mgMm: mg_mm, dntpMm: dntp_mm, oligoNm: oligo_nm, hairpins };
}

/**
 * Normalize one oligo and refuse anything the nearest-neighbour model cannot
 * represent (ambiguity codes, too short, too long).
 */
export function canonicalOligo(raw, label = 'sequence') {
  const seq = normalizeSequence(raw, label);
  if (seq.length < 4) {
    throw new MolbioInputError(`${label} must be at least 4 bases for a nearest-neighbour estimate (got ${seq.length})`);
  }
  if (seq.length > MAX_OLIGO_LENGTH) {
    throw new MolbioInputError(`${label} must be at most ${MAX_OLIGO_LENGTH} bases (got ${seq.length}); this is a duplex/structure estimator, not a genome-scale model`);
  }
  for (let i = 0; i < seq.length; i++) {
    if (!DNA_BASES.has(seq[i])) {
      throw new MolbioInputError(`${label} contains ${seq[i]} at position ${i + 1}; the nearest-neighbour model covers A/C/G/T only — ambiguity codes have no thermodynamic parameters`);
    }
  }
  return seq;
}

/**
 * Thermodynamics and structure checks for one duplex.
 *
 * @param {string} rawSequence one strand, 5'→3'.
 * @param {object} [rawOptions] partner + condition knobs (see resolveThermoOptions).
 * @returns {object} the tool's structured value (schema in index.mjs).
 */
export function analyzeDuplex(rawSequence, rawOptions = {}) {
  const sequence = canonicalOligo(rawSequence);
  const opts = resolveThermoOptions(rawOptions);
  const partnerRaw = rawOptions.partner;
  let partner;
  if (partnerRaw !== undefined && partnerRaw !== null && String(partnerRaw).trim() !== '') {
    partner = canonicalOligo(partnerRaw, 'partner');
    if (partner.length !== sequence.length) {
      throw new MolbioInputError(`partner is ${partner.length} bases but sequence is ${sequence.length}; a duplex partner must be the reverse complement of the same length`);
    }
    const expected = reverseComplement(sequence);
    const mismatches = [];
    for (let i = 0; i < sequence.length; i++) {
      if (partner[i] !== expected[i]) mismatches.push(i + 1);
    }
    if (mismatches.length > 0) {
      const shown = mismatches.slice(0, 8).join(', ') + (mismatches.length > 8 ? ', …' : '');
      throw new MolbioInputError(`partner is not the reverse complement of sequence (${mismatches.length} mismatch(es) at position(s) ${shown}); this tool models Watson–Crick duplexes only, so no estimate is given for a mismatched duplex`);
    }
  }

  const ct = opts.oligoNm * 1e-9;
  const thermo = duplexThermodynamics(sequence, {
    naMm: opts.naMm,
    mgMm: opts.mgMm,
    dntpMm: opts.dntpMm,
    primerNm: opts.oligoNm,
  });
  let gc = 0;
  for (const base of sequence) if (base === 'G' || base === 'C') gc++;

  const hairpins = opts.hairpins === 0
    ? []
    : hairpinThermo(sequence, ct).slice(0, opts.hairpins).map((hit) => ({
      start: hit.start,
      stem: hit.stem,
      loop: hit.loop,
      tm_celsius: hit.tm,
      delta_g37_kcal: hit.dg37_kcal,
    }));

  const self = dimerThermo(sequence, sequence, ct);
  const dimers = {
    homodimer_any_tm: self.any_tm,
    homodimer_end_tm: self.end_tm,
    ...partner === undefined ? {} : (() => {
      const hetero = dimerThermo(sequence, partner, ct);
      return { heterodimer_any_tm: hetero.any_tm, heterodimer_end_tm: hetero.end_tm };
    })(),
  };

  return {
    sequence,
    ...partner === undefined ? {} : { partner },
    length: sequence.length,
    gc_percent: round2((gc / sequence.length) * 100),
    conditions: {
      na_mm: opts.naMm,
      mg_mm: opts.mgMm,
      dntp_mm: opts.dntpMm,
      oligo_nm: opts.oligoNm,
      na_equivalent_mm: round2(thermo.na_equivalent_mm),
    },
    duplex: {
      delta_h_kcal: round2(thermo.dh_kcal),
      delta_s_cal: round2(thermo.ds_cal),
      delta_s_salt_cal: round2(thermo.ds_salt_cal),
      delta_g37_kcal: round2(thermo.delta_g37_kcal),
      tm_celsius: round2(thermo.tm_celsius),
    },
    end_stability_3p_kcal: endStability5(sequence),
    hairpins,
    dimers,
    model: 'santalucia-1998-nn',
  };
}
