/**
 * dsh-molbio-tools/plasmid.mjs
 *
 * Deterministic SVG plasmid-map renderer (circular and linear). Pure string
 * generation: features as lane-assigned arcs/bars, enzyme cut ticks, bp ruler.
 * No browser dependencies — the tool returns the SVG text and the agent saves
 * it with the ordinary write tool.
 */

import { MolbioInputError } from './lib.mjs';

const DEG = Math.PI / 180;

const TYPE_COLORS = {
  CDS: '#4a7dd8',
  gene: '#7c5cd6',
  rep_origin: '#e07826',
  promoter: '#2f9e4f',
  terminator: '#c73a3a',
  regulatory: '#2f9e4f',
  misc_feature: '#a86b00',
  source: '#7a828e',
  primer_bind: '#1f883d',
  protein_bind: '#1f883d',
  enhancer: '#2f9e4f',
  polyA_signal: '#c73a3a',
  sig_peptide: '#bf8700',
  mat_peptide: '#4a7dd8',
};

function colorFor(type) {
  return TYPE_COLORS[type] ?? '#57606a';
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function point(cx, cy, r, thetaDeg) {
  const rad = thetaDeg * DEG;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

/** SVG arc path from angle a1 to a2 (degrees, clockwise on screen). */
function arcPath(cx, cy, r, a1, a2) {
  const p1 = point(cx, cy, r, a1);
  const p2 = point(cx, cy, r, a2);
  const span = a2 - a1;
  const largeArc = span > 180 ? 1 : 0;
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

/** Nice ruler step so the map carries roughly 12–24 labeled ticks. */
function rulerStep(length) {
  for (const step of [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000, 100000]) {
    if (length / step <= 24) return step;
  }
  return Math.ceil(length / 24 / 1000) * 1000;
}

/** theta in degrees for a 0-based bp offset (0 at top, clockwise). */
function thetaOf(offset, length) {
  return (offset / length) * 360 - 90;
}

/** Assign non-overlapping lanes greedily. Copies the features so lane
 *  bookkeeping never mutates caller data. */
function assignLanes(features, length) {
  const sorted = features.map((feature) => ({ ...feature })).sort((a, b) => a.start - b.start || b.end - a.end);
  const laneEnds = [];
  for (const feature of sorted) {
    let lane = laneEnds.findIndex((end) => end < feature.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = feature.end;
    feature.lane = lane;
  }
  return sorted;
}

/** Dedupe labels so no two kept labels sit closer than minGap degrees. */
function dedupeLabels(labels, minGap = 6) {
  const kept = [];
  for (const label of labels) {
    if (kept.every((k) => Math.abs(k.angle - label.angle) > minGap)) kept.push(label);
  }
  return kept;
}

/**
 * Render a plasmid map.
 * @param {object} input - { name, length, circular, features, enzymes, sequence?, gc_skew?, marks? }
 *   features: [{label, type?, start, end, strand?}] 1-based inclusive
 *   enzymes:  [{name, cut_offsets: number[]}] 0-based cut offsets
 *   marks:    [{label, positions: number[], color?}] generic labeled ticks
 * @returns {string} the SVG document text.
 */
export function renderPlasmidMap(input) {
  const length = input.length;
  if (!Number.isInteger(length) || length <= 0 || length > 10_000_000) {
    throw new MolbioInputError(`invalid map length ${length}`);
  }
  const features = input.features ?? [];
  const enzymes = input.enzymes ?? [];
  const marks = input.marks ?? [];
  if (features.length > 200) throw new MolbioInputError('too many features (limit 200)');
  if (enzymes.length > 50) throw new MolbioInputError('too many enzymes (limit 50)');
  if (marks.length > 100) throw new MolbioInputError('too many marks (limit 100)');
  const name = input.name ?? 'plasmid';
  const title = input.title ?? `${name} · ${length} bp`;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 840" font-family="system-ui, sans-serif" role="img" aria-label="${escapeXml(title)}">`);
  parts.push(`<title>${escapeXml(title)}</title>`);
  parts.push('<rect width="840" height="840" fill="#ffffff"/>');

  if (input.circular === false) {
    renderLinear(parts, { name, length, features, enzymes, marks, title });
  } else {
    renderCircular(parts, { name, length, features, enzymes, marks, sequence: input.sequence, gcSkew: input.gc_skew === true, title });
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function renderCircular(parts, { name, length, features, enzymes, marks, sequence, gcSkew, title }) {
  const cx = 420;
  const cy = 420;
  const radius = 300;
  const step = rulerStep(length);
  const assigned = assignLanes(features, length);
  const laneRadius = (lane) => 275 - lane * 24;

  // ── GC skew ring (optional) ───────────────────────────────────────────────
  if (gcSkew && sequence !== undefined && sequence !== '') {
    const skewRadius = 128;
    const windows = 72;
    const points = [];
    for (let w = 0; w < windows; w++) {
      const start = Math.floor((w / windows) * sequence.length);
      const slice = sequence.slice(start, Math.min(sequence.length, start + Math.max(10, Math.floor(sequence.length / windows))));
      let g = 0;
      let c = 0;
      for (const base of slice) {
        if (base === 'G') g++;
        else if (base === 'C') c++;
      }
      const skew = g + c === 0 ? 0 : (g - c) / (g + c);
      const theta = thetaOf(start + slice.length / 2, sequence.length);
      points.push(point(cx, cy, skewRadius + skew * 34, theta));
    }
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z';
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${skewRadius}" fill="none" stroke="#d0d7de" stroke-width="1"/>`);
    parts.push(`<path d="${path}" fill="none" stroke="#57606a" stroke-width="1.5" stroke-linejoin="round"/>`);
    parts.push(`<text x="${cx}" y="${cy + 74}" font-size="9" fill="#57606a" text-anchor="middle">GC skew (outward: G-rich · inward: C-rich)</text>`);
  }

  // ── bp ruler ──────────────────────────────────────────────────────────────
  for (let bp = 0; bp < length; bp += step) {
    const theta = thetaOf(bp, length);
    const inner = point(cx, cy, radius + 4, theta);
    const outer = point(cx, cy, radius + 9, theta);
    parts.push(`<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}" stroke="#57606a" stroke-width="1.5"/>`);
    const labelPos = point(cx, cy, radius + 22, theta);
    parts.push(`<text x="${labelPos.x.toFixed(2)}" y="${labelPos.y.toFixed(2)}" font-size="9" fill="#57606a" text-anchor="middle" dominant-baseline="middle">${bp}</text>`);
  }

  // ── backbone ──────────────────────────────────────────────────────────────
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#1f2328" stroke-width="3"/>`);

  // ── features ──────────────────────────────────────────────────────────────
  const labelCandidates = [];
  for (const feature of assigned) {
    if (feature.start < 1 || feature.end > length || feature.start > feature.end) continue;
    const span = feature.end - feature.start + 1;
    const full = span >= length * 0.995;
    const a1 = thetaOf(feature.start - 1, length);
    const a2 = full ? a1 + 359.9 : thetaOf(feature.end, length);
    const lane = Math.min(feature.lane, 5);
    const r = laneRadius(lane);
    const color = colorFor(feature.type);
    parts.push(`<path d="${arcPath(cx, cy, r, a1, a2)}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round"/>`);
    if (!full && span / length * 360 > 18) {
      const strand = feature.strand ?? 1;
      if (strand >= 0) {
        const tip = point(cx, cy, r, a2);
        const b1 = point(cx, cy, r - 8, a2 - 8);
        const b2 = point(cx, cy, r + 8, a2 - 8);
        parts.push(`<polygon points="${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${b1.x.toFixed(2)},${b1.y.toFixed(2)} ${b2.x.toFixed(2)},${b2.y.toFixed(2)}" fill="${color}"/>`);
      } else {
        const tip = point(cx, cy, r, a1);
        const b1 = point(cx, cy, r - 8, a1 + 8);
        const b2 = point(cx, cy, r + 8, a1 + 8);
        parts.push(`<polygon points="${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${b1.x.toFixed(2)},${b1.y.toFixed(2)} ${b2.x.toFixed(2)},${b2.y.toFixed(2)}" fill="${color}"/>`);
      }
    }
    if (span / length * 360 >= 14) {
      const mid = (a1 + a2) / 2;
      labelCandidates.push({ angle: mid, span, label: feature.label ?? feature.type, radius: r - 19 });
    }
  }
  for (const label of dedupeLabels(labelCandidates.sort((a, b) => b.span - a.span))) {
    const pos = point(cx, cy, label.radius, label.angle);
    parts.push(`<text x="${pos.x.toFixed(2)}" y="${pos.y.toFixed(2)}" font-size="11" fill="#1f2328" text-anchor="middle" dominant-baseline="middle">${escapeXml(label.label)}</text>`);
  }

  // ── enzyme cuts and generic marks ─────────────────────────────────────────
  const allMarks = [
    ...enzymes.map((enzyme) => ({ label: enzyme.name, positions: enzyme.cut_offsets, color: '#c73a3a' })),
    ...marks,
  ];
  let markRadius = 352;
  for (const mark of allMarks) {
    const color = mark.color ?? '#c73a3a';
    const offsets = [...new Set(mark.positions)].sort((a, b) => a - b);
    let previous = -Infinity;
    for (const offset of offsets) {
      if (offset < 0 || offset > length) continue;
      const theta = thetaOf(offset, length);
      const base = point(cx, cy, radius + 4, theta);
      const tip = point(cx, cy, radius + 15, theta);
      parts.push(`<line x1="${base.x.toFixed(2)}" y1="${base.y.toFixed(2)}" x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}" stroke="${color}" stroke-width="2"/>`);
      if (Math.abs(theta - previous) > 6) {
        const labelPos = point(cx, cy, markRadius, theta);
        parts.push(`<text x="${labelPos.x.toFixed(2)}" y="${labelPos.y.toFixed(2)}" font-size="10" fill="${color}" text-anchor="middle" dominant-baseline="middle">${escapeXml(mark.label)}</text>`);
        previous = theta;
        markRadius = markRadius === 352 ? 374 : 352;
      }
    }
  }

  // ── title ─────────────────────────────────────────────────────────────────
  parts.push(`<text x="${cx}" y="${cy - 8}" font-size="20" font-weight="700" fill="#1f2328" text-anchor="middle">${escapeXml(name)}</text>`);
  parts.push(`<text x="${cx}" y="${cy + 14}" font-size="14" fill="#57606a" text-anchor="middle">${length} bp</text>`);
}

function renderLinear(parts, { name, length, features, enzymes, marks, title }) {
  const W = 960;
  const H = 260;
  const xOf = (bp) => 60 + (bp / length) * (W - 120);
  const yBackbone = 120;
  const step = rulerStep(length);
  const assigned = assignLanes(features, length);

  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<line x1="${xOf(0)}" y1="${yBackbone}" x2="${xOf(length)}" y2="${yBackbone}" stroke="#1f2328" stroke-width="3"/>`);

  // ruler
  for (let bp = 0; bp <= length; bp += step) {
    const x = xOf(Math.min(bp, length));
    parts.push(`<line x1="${x.toFixed(2)}" y1="${yBackbone + 6}" x2="${x.toFixed(2)}" y2="${yBackbone + 14}" stroke="#57606a" stroke-width="1.5"/>`);
    parts.push(`<text x="${x.toFixed(2)}" y="${yBackbone + 28}" font-size="9" fill="#57606a" text-anchor="middle">${bp}</text>`);
  }

  // features alternate above/below the backbone
  const labelCandidates = [];
  for (const feature of assigned) {
    if (feature.start < 1 || feature.end > length || feature.start > feature.end) continue;
    const lane = Math.min(feature.lane, 8);
    const x1 = xOf(feature.start - 1);
    const x2 = xOf(feature.end);
    const above = lane % 2 === 0;
    const row = Math.floor(lane / 2);
    const y = above ? yBackbone - 14 - row * 20 : yBackbone + 16 + row * 20;
    const color = colorFor(feature.type);
    const width = Math.max(x2 - x1, 4);
    parts.push(`<rect x="${x1.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="12" rx="3" fill="${color}"/>`);
    if (width > 26) {
      const strand = feature.strand ?? 1;
      if (strand >= 0) {
        parts.push(`<polygon points="${x2.toFixed(2)},${y.toFixed(2)} ${(x2 + 8).toFixed(2)},${(y + 6).toFixed(2)} ${x2.toFixed(2)},${(y + 12).toFixed(2)}" fill="${color}"/>`);
      } else {
        parts.push(`<polygon points="${x1.toFixed(2)},${y.toFixed(2)} ${(x1 - 8).toFixed(2)},${(y + 6).toFixed(2)} ${x1.toFixed(2)},${(y + 12).toFixed(2)}" fill="${color}"/>`);
      }
    }
    if (width > 46) {
      const mid = (x1 + x2) / 2;
      labelCandidates.push({ angle: mid, span: width, label: feature.label ?? feature.type, y: above ? y - 5 : y + 22 });
    }
  }
  for (const label of dedupeLabels(labelCandidates.sort((a, b) => b.span - a.span), 40)) {
    parts.push(`<text x="${label.angle.toFixed(2)}" y="${label.y}" font-size="11" fill="#1f2328" text-anchor="middle">${escapeXml(label.label)}</text>`);
  }

  // enzymes
  for (const enzyme of enzymes) {
    for (const offset of new Set(enzyme.cut_offsets)) {
      if (offset < 0 || offset > length) continue;
      const x = xOf(offset);
      parts.push(`<line x1="${x.toFixed(2)}" y1="${yBackbone - 8}" x2="${x.toFixed(2)}" y2="${yBackbone + 8}" stroke="#c73a3a" stroke-width="2"/>`);
    }
  }
  const enzymeNames = enzymes.map((enzyme) => enzyme.name).join(', ');
  parts.push(`<text x="${xOf(0)}" y="${yBackbone - 34}" font-size="11" fill="#c73a3a">enzymes: ${escapeXml(enzymeNames)}</text>`);

  // generic marks
  for (const mark of marks) {
    const color = mark.color ?? '#c73a3a';
    for (const offset of new Set(mark.positions)) {
      if (offset < 0 || offset > length) continue;
      const x = xOf(offset);
      parts.push(`<line x1="${x.toFixed(2)}" y1="${yBackbone - 10}" x2="${x.toFixed(2)}" y2="${yBackbone + 10}" stroke="${color}" stroke-width="2"/>`);
    }
  }
  const markNames = marks.map((mark) => mark.label).join(', ');
  if (markNames !== '') parts.push(`<text x="${xOf(0)}" y="${yBackbone - 52}" font-size="11" fill="#57606a">marks: ${escapeXml(markNames)}</text>`);

  parts.push(`<text x="${xOf(0)}" y="26" font-size="18" font-weight="700" fill="#1f2328">${escapeXml(name)}</text>`);
  parts.push(`<text x="${xOf(0)}" y="46" font-size="12" fill="#57606a">${length} bp</text>`);
}
