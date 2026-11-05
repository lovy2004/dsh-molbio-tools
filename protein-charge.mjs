/**
 * dsh-molbio-tools/protein-charge.mjs
 *
 * Net-charge-vs-pH titration for a protein, with the pI found on the same
 * curve. Pure calculation plus an SVG renderer: no external data, no services.
 *
 * The pK tables live in `protein.mjs` (PK_SETS) so `molbio_protein_props` and
 * this tool can never disagree about the default set. `emboss` is offered as an
 * explicitly named alternative; every result carries the set it used, because a
 * pI is only meaningful together with its pK values.
 */
import { MolbioInputError } from './lib.mjs';
import { PK_SETS, countAminoAcids, isoelectricPoint, netCharge, normalizeProtein } from './protein.mjs';
import { axis, linearScale, niceTicks, panel, rect, series, svgDocument, textRun } from './svgio.mjs';

/** Accepted ranges; the schema checks types and the module checks values. */
export const CHARGE_LIMITS = {
  maxLength: 20_000,
  minPh: 0,
  maxPh: 14,
  minSteps: 2,
  maxSteps: 141,
};

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Compute the titration curve and the pI for one protein.
 *
 * @param {string} raw protein sequence (one-letter codes).
 * @param {{pkaSet?: string, phMin?: number, phMax?: number, steps?: number}} [options]
 * @returns {{length: number, pka_set: string, pka_label: string, ph_min: number,
 *   ph_max: number, steps: number, pI: number, charge_at_7_4: number,
 *   charge_min: number, charge_max: number, points: Array<{ph: number, charge: number}>}}
 */
export function chargeCurve(raw, options = {}) {
  const seq = normalizeProtein(raw);
  if (seq.length > CHARGE_LIMITS.maxLength) {
    throw new MolbioInputError('the protein is ' + seq.length + ' aa; the titration limit is ' + CHARGE_LIMITS.maxLength);
  }
  const pkaSet = options.pkaSet ?? 'bjellqvist';
  const pk = PK_SETS[pkaSet];
  if (pk === undefined) {
    throw new MolbioInputError('unknown pka_set ' + JSON.stringify(pkaSet) + '; expected one of ' + Object.keys(PK_SETS).join(', '));
  }
  const phMin = options.phMin ?? 0;
  const phMax = options.phMax ?? 14;
  const steps = options.steps ?? 29;
  if (!(typeof phMin === 'number' && Number.isFinite(phMin) && phMin >= CHARGE_LIMITS.minPh && phMin <= CHARGE_LIMITS.maxPh)) {
    throw new MolbioInputError('ph_min must be a number between ' + CHARGE_LIMITS.minPh + ' and ' + CHARGE_LIMITS.maxPh);
  }
  if (!(typeof phMax === 'number' && Number.isFinite(phMax) && phMax >= CHARGE_LIMITS.minPh && phMax <= CHARGE_LIMITS.maxPh)) {
    throw new MolbioInputError('ph_max must be a number between ' + CHARGE_LIMITS.minPh + ' and ' + CHARGE_LIMITS.maxPh);
  }
  if (!(phMax > phMin)) throw new MolbioInputError('ph_max must be greater than ph_min');
  if (!Number.isInteger(steps) || steps < CHARGE_LIMITS.minSteps || steps > CHARGE_LIMITS.maxSteps) {
    throw new MolbioInputError('steps must be an integer between ' + CHARGE_LIMITS.minSteps + ' and ' + CHARGE_LIMITS.maxSteps);
  }
  const counts = countAminoAcids(seq);
  const points = [];
  for (let index = 0; index < steps; index++) {
    const ph = phMin + ((phMax - phMin) * index) / (steps - 1);
    points.push({ ph: round(ph, 3), charge: round(netCharge(seq, counts, ph, pkaSet), 4) });
  }
  const charges = points.map((point) => point.charge);
  return {
    length: seq.length,
    pka_set: pkaSet,
    pka_label: pk.label,
    ph_min: phMin,
    ph_max: phMax,
    steps,
    pI: isoelectricPoint(seq, counts, pkaSet),
    charge_at_7_4: round(netCharge(seq, counts, 7.4, pkaSet), 4),
    charge_min: Math.min(...charges),
    charge_max: Math.max(...charges),
    points,
  };
}

/**
 * Render the titration curve as an SVG document: net charge against pH, with
 * the zero line, the pI marker and the charged ends labelled.
 *
 * @param {ReturnType<typeof chargeCurve>} curve
 * @param {{title?: string}} [options]
 * @returns {string} SVG text.
 */
export function renderChargeCurve(curve, options = {}) {
  const width = 720;
  const height = 420;
  const frame = panel({
    x: 16,
    y: 16,
    width: width - 32,
    height: height - 32,
    title: options.title ?? 'Net charge vs pH',
    subtitle: curve.length + ' aa · ' + curve.pka_label + ' pK set · pI ' + curve.pI,
  });
  const plot = frame.plot;
  const yMin = Math.min(0, curve.charge_min);
  const yMax = Math.max(0, curve.charge_max);
  const pad = Math.max(0.5, (yMax - yMin) * 0.08);
  const domain = [yMin - pad, yMax + pad];
  const x = linearScale([curve.ph_min, curve.ph_max], [plot.x, plot.x + plot.width]);
  const y = linearScale(domain, [plot.y + plot.height, plot.y]);
  const parts = [frame.markup];
  // Zero-charge line: the sign of the charge is the point of the plot.
  if (domain[0] < 0 && domain[1] > 0) {
    const zero = y.of(0);
    parts.push('<line x1="' + plot.x + '" y1="' + zero + '" x2="' + (plot.x + plot.width) + '" y2="' + zero + '" stroke="#8c959f" stroke-width="1" stroke-dasharray="4 3"/>');
  }
  parts.push(axis({
    from: plot.x,
    to: plot.x + plot.width,
    at: plot.y + plot.height,
    ticks: niceTicks([curve.ph_min, curve.ph_max], 7).map((tick) => x.of(tick)),
    orientation: 'x',
    label: 'pH',
    tickLabel: (pixel) => String(Math.round(x.invert(pixel) * 10) / 10),
    title: 'pH',
  }));
  parts.push(axis({
    from: plot.y,
    to: plot.y + plot.height,
    at: plot.x,
    ticks: niceTicks(domain, 6).map((tick) => y.of(tick)),
    orientation: 'y',
    label: 'net charge',
    tickLabel: (pixel) => String(Math.round(y.invert(pixel) * 10) / 10),
    title: 'net charge (e)',
  }));
  parts.push(series({
    values: curve.points.map((point) => point.charge),
    xOf: (index) => x.of(curve.points[index].ph),
    yOf: (charge) => y.of(charge),
    stroke: '#0969da',
    width: 2,
  }));
  if (curve.pI >= curve.ph_min && curve.pI <= curve.ph_max) {
    const marker = x.of(curve.pI);
    parts.push('<line x1="' + marker + '" y1="' + plot.y + '" x2="' + marker + '" y2="' + (plot.y + plot.height) + '" stroke="#bf3989" stroke-width="1" stroke-dasharray="2 3"/>');
    parts.push(textRun({ x: marker + 4, y: plot.y + 12, text: 'pI ' + curve.pI, size: 9, fill: '#bf3989' }));
  }
  // Label the two ends of the curve with the charges they represent.
  const first = curve.points[0];
  const last = curve.points[curve.points.length - 1];
  parts.push(textRun({ x: x.of(first.ph) + 4, y: y.of(first.charge) - 6, text: 'pH ' + first.ph + ': ' + first.charge, size: 9, fill: '#57606a' }));
  parts.push(textRun({ x: x.of(last.ph) - 4, y: y.of(last.charge) + 14, text: 'pH ' + last.ph + ': ' + last.charge, size: 9, fill: '#57606a', anchor: 'end' }));
  parts.push(rect({ x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: 'none', stroke: '#d0d7de' }));
  return svgDocument({
    width,
    height,
    title: options.title ?? 'Net charge vs pH',
    description: 'Titration curve for a ' + curve.length + ' aa protein using the ' + curve.pka_label + ' pK set; pI ' + curve.pI + '.',
    body: parts.join('\n'),
  });
}
