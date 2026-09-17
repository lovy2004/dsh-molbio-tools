/**
 * dsh-molbio-tools/protein-structure.mjs
 *
 * Protein sequence features that are read as PICTURES in every cloning/expression
 * notebook, computed here so the model never has to draw them by hand:
 *
 *   - the helical wheel (Schiffer-Edmundson projection) with the Eisenberg
 *     hydrophobic-moment analysis that goes with it, and
 *   - the Kyte-Doolittle hydropathy plot, with the classic 1.6 window-average
 *     threshold used to flag candidate membrane-spanning stretches.
 *
 * All values are ESTIMATES from published scales (Kyte & Doolittle 1982,
 * Eisenberg et al. 1984). They describe sequence propensity, not structure.
 */

import { MolbioInputError } from './lib.mjs';
import { normalizeProtein } from './protein.mjs';

/** Kyte-Doolittle hydropathy scale (same numbers protein.mjs uses for GRAVY). */
export const KYTE_DOOLITTLE = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4,
  H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8,
  T: -0.7, W: -0.9, Y: -1.3, V: 4.2,
};

/** Eisenberg consensus hydrophobicity scale (used for the hydrophobic moment). */
export const EISENBERG = {
  A: 0.62, R: -2.53, N: -0.78, D: -0.90, C: 0.29, Q: -0.85, E: -0.74, G: 0.48,
  H: -0.40, I: 1.38, L: 1.06, K: -1.50, M: 0.64, F: 1.19, P: 0.12, S: -0.18,
  T: -0.05, W: 0.81, Y: 0.26, V: 1.08,
};

/** Residue classes used for the wheel's colouring and the legend. */
export const RESIDUE_CLASSES = {
  hydrophobic: { label: 'hydrophobic (A V I L M F W Y P G)', color: '#f2c14e' },
  polar: { label: 'polar (S T N Q C)', color: '#7fb3d5' },
  acidic: { label: 'acidic (D E)', color: '#e07a5f' },
  basic: { label: 'basic (K R H)', color: '#81b29a' },
};

const CLASS_OF = {
  A: 'hydrophobic', V: 'hydrophobic', I: 'hydrophobic', L: 'hydrophobic', M: 'hydrophobic',
  F: 'hydrophobic', W: 'hydrophobic', Y: 'hydrophobic', P: 'hydrophobic', G: 'hydrophobic',
  S: 'polar', T: 'polar', N: 'polar', Q: 'polar', C: 'polar',
  D: 'acidic', E: 'acidic',
  K: 'basic', R: 'basic', H: 'basic',
};

const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Residue class of one one-letter code, defaulting to polar for anything odd. */
export function residueClass(aminoAcid) {
  return CLASS_OF[aminoAcid] ?? 'polar';
}

// ── helical wheel ───────────────────────────────────────────────────────────

/**
 * Helical-wheel analysis of a peptide stretch.
 *
 * Residues are placed on a circle 100° apart (the 3.6-residues-per-turn
 * geometry of an ideal α-helix), which is the Schiffer-Edmundson projection:
 * an amphipathic helix shows one face hydrophobic and the opposite face polar.
 * The hydrophobic moment μH is computed from the Eisenberg consensus scale over
 * the whole peptide; its maximum over every window of `moment_window` residues
 * (Eisenberg's standard 11-residue window is the default) is reported too.
 *
 * @param {string} rawSequence peptide, one-letter codes.
 * @param {{start?: number, residuesPerTurn?: number, momentWindow?: number, rotations?: number}} [options]
 */
export function helicalWheel(rawSequence, options = {}) {
  const sequence = normalizeProtein(rawSequence);
  const start = options.start ?? 1;
  if (!Number.isInteger(start) || start < 1 || start > sequence.length) {
    throw new MolbioInputError(`start must be an integer between 1 and the sequence length (${sequence.length})`);
  }
  const residuesPerTurn = options.residuesPerTurn ?? 3.6;
  if (!(typeof residuesPerTurn === 'number') || residuesPerTurn < 2 || residuesPerTurn > 6) {
    throw new MolbioInputError('residues_per_turn must be a number between 2 and 6 (3.6 for an ideal alpha-helix)');
  }
  const momentWindow = options.momentWindow ?? 11;
  if (!Number.isInteger(momentWindow) || momentWindow < 2 || momentWindow > 40) {
    throw new MolbioInputError('moment_window must be an integer between 2 and 40');
  }
  const rotations = options.rotations ?? 4;
  if (!Number.isInteger(rotations) || rotations < 1 || rotations > 6) {
    throw new MolbioInputError('rotations must be an integer between 1 and 6 (how many turns to draw; 4 covers a 14-residue peptide at 3.6 residues/turn)');
  }
  const span = Math.min(sequence.length - start + 1, Math.round(residuesPerTurn * rotations));
  const window = sequence.slice(start - 1, start - 1 + span);
  const turn = 360 / residuesPerTurn;

  const residues = [...window].map((aminoAcid, index) => {
    // Standard wheel convention: residue 1 sits at the top and the helix is
    // drawn clockwise (the 100° step is subtracted).
    const angle = 90 - index * turn;
    const radians = (angle * Math.PI) / 180;
    return {
      position: start + index,
      amino_acid: aminoAcid,
      class: residueClass(aminoAcid),
      angle_degrees: round2(((angle % 360) + 360) % 360),
      x: round3(Math.cos(radians)),
      y: round3(-Math.sin(radians)),
      hydropathy: KYTE_DOOLITTLE[aminoAcid],
      hydrophobicity: EISENBERG[aminoAcid],
    };
  });

  // Hydrophobic moment of the whole stretch and of each sliding window.
  const momentOf = (slice) => {
    let sin = 0;
    let cos = 0;
    for (let i = 0; i < slice.length; i++) {
      const theta = (i * 100 * Math.PI) / 180;
      const h = EISENBERG[slice[i]];
      sin += h * Math.sin(theta);
      cos += h * Math.cos(theta);
    }
    return Math.sqrt(sin * sin + cos * cos) / slice.length;
  };
  const moment = momentOf(window);
  let bestMoment = moment;
  let bestWindowStart = start;
  if (window.length >= momentWindow) {
    for (let i = 0; i + momentWindow <= window.length; i++) {
      const candidate = momentOf(window.slice(i, i + momentWindow));
      if (candidate > bestMoment) {
        bestMoment = candidate;
        bestWindowStart = start + i;
      }
    }
  }

  const classCounts = {};
  for (const residue of residues) classCounts[residue.class] = (classCounts[residue.class] ?? 0) + 1;
  const hydrophobicFraction = round3((classCounts.hydrophobic ?? 0) / residues.length);
  const notes = [];
  if (residues.length < Math.round(residuesPerTurn)) {
    notes.push(`only ${residues.length} residue(s) shown (${rotations} turn(s) at ${residuesPerTurn}/turn) — a wheel needs at least one full turn to show a face`);
  }
  if (bestMoment >= 0.5) notes.push(`hydrophobic moment ${round3(bestMoment)} over ${momentWindow} residues is high — candidate amphipathic helix`);
  if (hydrophobicFraction >= 0.6 && bestMoment < 0.3) notes.push('one face is very hydrophobic without a strong moment — candidate transmembrane or signal segment');

  return {
    sequence,
    start,
    end: start + residues.length - 1,
    window,
    residues_shown: residues.length,
    residues_per_turn: residuesPerTurn,
    degrees_per_residue: round2(turn),
    moment_window: momentWindow,
    hydrophobic_moment: round3(moment),
    mean_hydrophobicity: round3(window.split('').reduce((sum, aa) => sum + EISENBERG[aa], 0) / window.length),
    maximum_window_moment: round3(bestMoment),
    maximum_window_start: bestWindowStart,
    hydrophobic_fraction: hydrophobicFraction,
    class_counts: classCounts,
    residues,
    notes,
  };
}

/** Vertical extent of the wheel drawing (unit circle -> pixels). */
const WHEEL_SIZE = 520;
const WHEEL_RADIUS = 190;
const RESIDUE_RADIUS = 17;

/**
 * Draw a {@link helicalWheel} result as a standalone SVG.
 *
 * The letters are placed with an absolute font size and a `textLength`, so a
 * glyph can never overflow its residue circle (the logo renderer learned this
 * the hard way — see CHANGELOG 0.6.0).
 */
export function renderHelicalWheel(wheel, { title = 'Helical wheel' } = {}) {
  const center = WHEEL_SIZE / 2;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}" font-family="system-ui, sans-serif" role="img">`);
  parts.push(`<title>${escapeXml(`${title}: residues ${wheel.start}-${wheel.end}, hydrophobic moment ${wheel.hydrophobic_moment}`)}</title>`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  parts.push(`<text x="${center}" y="26" font-size="16" font-weight="700" fill="#1f2328" text-anchor="middle">${escapeXml(title)}</text>`);
  parts.push(`<text x="${center}" y="46" font-size="11" fill="#57606a" text-anchor="middle">${escapeXml(`residues ${wheel.start}-${wheel.end} · ${wheel.degrees_per_residue}°/residue · μH ${wheel.hydrophobic_moment} (max ${wheel.maximum_window_moment} @ ${wheel.maximum_window_start})`)}</text>`);
  // back circle + the hydrophobic face wedge is implied by the residue colours
  parts.push(`<circle cx="${center}" cy="${center}" r="${WHEEL_RADIUS}" fill="none" stroke="#d0d7de" stroke-width="1.5"/>`);
  parts.push(`<line x1="${center - WHEEL_RADIUS}" y1="${center}" x2="${center + WHEEL_RADIUS}" y2="${center}" stroke="#eaeef2" stroke-width="1"/>`);
  parts.push(`<line x1="${center}" y1="${center - WHEEL_RADIUS}" x2="${center}" y2="${center + WHEEL_RADIUS}" stroke="#eaeef2" stroke-width="1"/>`);
  // sequence order is the 1..n spiral from the centre outward, as in a printed wheel
  for (let index = 0; index < wheel.residues.length; index++) {
    const residue = wheel.residues[index];
    const x = center + residue.x * WHEEL_RADIUS;
    const y = center - residue.y * WHEEL_RADIUS; // SVG y grows downward, the plot y grows upward
    const color = RESIDUE_CLASSES[residue.class].color;
    parts.push(`<line x1="${center}" y1="${center}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="#eaeef2" stroke-width="1"/>`);
    parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${RESIDUE_RADIUS}" fill="${color}" stroke="#1f2328" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(2)}" y="${(y + 4).toFixed(2)}" font-size="13" font-weight="600" fill="#1f2328" text-anchor="middle" textLength="14" lengthAdjust="spacingAndGlyphs">${escapeXml(residue.amino_acid)}</text>`);
    // position label further out along the same radius
    const labelX = center + residue.x * (WHEEL_RADIUS + 30);
    const labelY = center - residue.y * (WHEEL_RADIUS + 30);
    parts.push(`<text x="${labelX.toFixed(2)}" y="${(labelY + 3).toFixed(2)}" font-size="9" fill="#57606a" text-anchor="middle">${residue.position}</text>`);
  }
  // legend
  let legendY = WHEEL_SIZE - 74;
  parts.push(`<text x="18" y="${legendY}" font-size="11" font-weight="700" fill="#1f2328">Residue classes</text>`);
  legendY += 16;
  for (const [key, entry] of Object.entries(RESIDUE_CLASSES)) {
    const count = wheel.class_counts[key] ?? 0;
    parts.push(`<rect x="18" y="${legendY - 9}" width="11" height="11" rx="2" fill="${entry.color}" stroke="#1f2328" stroke-width="0.8"/>`);
    parts.push(`<text x="36" y="${legendY}" font-size="10" fill="#1f2328">${escapeXml(`${entry.label} — ${count} of ${wheel.residues_shown}`)}</text>`);
    legendY += 15;
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ── Kyte-Doolittle hydropathy plot ──────────────────────────────────────────

/** Classic window sizes: 7-9 for exposed loops, 19-21 for transmembrane spans. */
export const HYDROPATHY_DEFAULTS = {
  window: 9,
  threshold: 1.6,
  maxSequenceLength: 20000,
};

/** Sliding-window Kyte-Doolittle hydropathy profile (centred windows). */
export function hydropathyProfile(rawSequence, options = {}) {
  const sequence = normalizeProtein(rawSequence);
  const window = options.window ?? HYDROPATHY_DEFAULTS.window;
  const threshold = options.threshold ?? HYDROPATHY_DEFAULTS.threshold;
  if (!Number.isInteger(window) || window < 3 || window > 51) throw new MolbioInputError('window must be an integer between 3 and 51 (an odd number centres the window on a residue)');
  if (!(typeof threshold === 'number') || threshold < -4.5 || threshold > 4.5) throw new MolbioInputError('threshold must be a number between -4.5 and 4.5 (the Kyte-Doolittle range)');
  if (sequence.length > HYDROPATHY_DEFAULTS.maxSequenceLength) {
    throw new MolbioInputError(`the protein is ${sequence.length} residues; the limit is ${HYDROPATHY_DEFAULTS.maxSequenceLength} per plot`);
  }
  const half = Math.floor(window / 2);
  const points = [];
  for (let index = 0; index < sequence.length; index++) {
    const from = Math.max(0, index - half);
    const to = Math.min(sequence.length, index + half + 1);
    let sum = 0;
    for (let i = from; i < to; i++) sum += KYTE_DOOLITTLE[sequence[i]];
    points.push({
      position: index + 1,
      amino_acid: sequence[index],
      hydropathy: round3(sum / (to - from)),
      window: [from + 1, to],
    });
  }
  // Peaks: maximal runs whose centred value reaches the threshold.
  const peaks = [];
  let current = null;
  for (const point of points) {
    if (point.hydropathy >= threshold) {
      if (current === null) current = { start: point.position, end: point.position, maximum: point.hydropathy, maximum_position: point.position };
      else {
        current.end = point.position;
        if (point.hydropathy > current.maximum) {
          current.maximum = point.hydropathy;
          current.maximum_position = point.position;
        }
      }
    } else if (current !== null) {
      peaks.push(current);
      current = null;
    }
  }
  if (current !== null) peaks.push(current);
  const total = points.reduce((sum, point) => sum + point.hydropathy, 0);
  return {
    length: sequence.length,
    window,
    threshold,
    gravy: sequence.length === 0 ? 0 : round2([...sequence].reduce((sum, aa) => sum + KYTE_DOOLITTLE[aa], 0) / sequence.length),
    mean_profile: round3(total / points.length),
    minimum_hydropathy: round3(Math.min(...points.map((point) => point.hydropathy))),
    maximum_hydropathy: round3(Math.max(...points.map((point) => point.hydropathy))),
    peaks: peaks.map((peak) => ({ ...peak, maximum: round3(peak.maximum), length: peak.end - peak.start + 1 })),
    points,
  };
}

/** Width/height of the hydropathy chart (one x step per residue, bounded). */
const PLOT_WIDTH = 820;
const PLOT_HEIGHT = 300;
const PLOT_MARGIN = { top: 58, right: 24, bottom: 40, left: 56 };

/** Draw a {@link hydropathyProfile} result as a standalone SVG line plot. */
export function renderHydropathyPlot(profile, { title = 'Kyte-Doolittle hydropathy' } = {}) {
  const { points, window, threshold, length } = profile;
  const plotWidth = PLOT_WIDTH - PLOT_MARGIN.left - PLOT_MARGIN.right;
  const plotHeight = PLOT_HEIGHT - PLOT_MARGIN.top - PLOT_MARGIN.bottom;
  const min = -4.5;
  const max = 4.5;
  const xOf = (position) => PLOT_MARGIN.left + (length <= 1 ? plotWidth / 2 : ((position - 1) / (length - 1)) * plotWidth);
  const yOf = (value) => PLOT_MARGIN.top + ((max - value) / (max - min)) * plotHeight;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" font-family="system-ui, sans-serif" role="img">`);
  parts.push(`<title>${escapeXml(`${title}: ${length} residues, window ${window}, ${profile.peaks.length} peak(s) above ${threshold}`)}</title>`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  parts.push(`<text x="${PLOT_WIDTH / 2}" y="26" font-size="16" font-weight="700" fill="#1f2328" text-anchor="middle">${escapeXml(title)}</text>`);
  parts.push(`<text x="${PLOT_WIDTH / 2}" y="44" font-size="11" fill="#57606a" text-anchor="middle">${escapeXml(`${length} aa · window ${window} · threshold ${threshold} · GRAVY ${profile.gravy} · ${profile.peaks.length} peak(s)`)}</text>`);
  // horizontal grid + y ticks
  for (let value = min; value <= max + 1e-9; value += 1.5) {
    const y = yOf(value);
    parts.push(`<line x1="${PLOT_MARGIN.left}" y1="${y.toFixed(2)}" x2="${PLOT_WIDTH - PLOT_MARGIN.right}" y2="${y.toFixed(2)}" stroke="#eaeef2" stroke-width="1"/>`);
    parts.push(`<text x="${PLOT_MARGIN.left - 8}" y="${(y + 3).toFixed(2)}" font-size="10" fill="#57606a" text-anchor="end">${value.toFixed(1)}</text>`);
  }
  parts.push(`<line x1="${PLOT_MARGIN.left}" y1="${yOf(0).toFixed(2)}" x2="${PLOT_WIDTH - PLOT_MARGIN.right}" y2="${yOf(0).toFixed(2)}" stroke="#8c959f" stroke-width="1.2"/>`);
  if (threshold <= max) {
    parts.push(`<line x1="${PLOT_MARGIN.left}" y1="${yOf(threshold).toFixed(2)}" x2="${PLOT_WIDTH - PLOT_MARGIN.right}" y2="${yOf(threshold).toFixed(2)}" stroke="#e07a5f" stroke-width="1.2" stroke-dasharray="5 4"/>`);
    parts.push(`<text x="${PLOT_WIDTH - PLOT_MARGIN.right}" y="${(yOf(threshold) - 5).toFixed(2)}" font-size="10" fill="#e07a5f" text-anchor="end">threshold ${threshold}</text>`);
  }
  // the profile as a filled area around zero plus the line
  const line = points.map((point) => `${xOf(point.position).toFixed(2)},${yOf(point.hydropathy).toFixed(2)}`).join(' ');
  const area = `${xOf(1).toFixed(2)},${yOf(0).toFixed(2)} ${line} ${xOf(length).toFixed(2)},${yOf(0).toFixed(2)}`;
  parts.push(`<polygon points="${area}" fill="#7fb3d5" fill-opacity="0.35"/>`);
  parts.push(`<polyline points="${line}" fill="none" stroke="#2f6690" stroke-width="1.8"/>`);
  // peak markers + residue letters above the ticks
  for (const peak of profile.peaks) {
    const x = xOf(peak.maximum_position);
    parts.push(`<circle cx="${x.toFixed(2)}" cy="${yOf(peak.maximum).toFixed(2)}" r="3.2" fill="#e07a5f"/>`);
    parts.push(`<text x="${x.toFixed(2)}" y="${(yOf(peak.maximum) - 7).toFixed(2)}" font-size="10" fill="#a4240b" text-anchor="middle">${peak.start}-${peak.end}</text>`);
  }
  // x ticks every ~10% of the sequence
  const step = Math.max(1, Math.round(length / 10));
  for (let position = 1; position <= length; position += step) {
    const x = xOf(position);
    parts.push(`<line x1="${x.toFixed(2)}" y1="${PLOT_HEIGHT - PLOT_MARGIN.bottom}" x2="${x.toFixed(2)}" y2="${PLOT_HEIGHT - PLOT_MARGIN.bottom + 5}" stroke="#1f2328" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(2)}" y="${PLOT_HEIGHT - PLOT_MARGIN.bottom + 17}" font-size="10" fill="#57606a" text-anchor="middle">${position}</text>`);
  }
  parts.push(`<text x="${PLOT_WIDTH / 2}" y="${PLOT_HEIGHT - 6}" font-size="11" fill="#1f2328" text-anchor="middle">residue position</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}
