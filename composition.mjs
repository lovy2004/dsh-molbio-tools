/**
 * dsh-molbio-tools/composition.mjs
 *
 * Sequence composition: CpG islands, GC/AT skew with cumulative skew, word
 * frequencies, entropy, linguistic complexity and length statistics.
 *
 * WHAT THE NUMBERS MEAN, AND WHAT THEY DO NOT
 * ------------------------------------------
 * - The CpG island rules are published thresholds (Gardiner-Garden & Frommer
 *   1987; Takai & Jones 2002) and BOTH are shipped, because they disagree on
 *   purpose: the 1987 rule finds many short islands, the 2002 rule finds fewer,
 *   longer ones. The chosen rule is printed with the result.
 * - Cumulative GC skew is an INDICATOR of the replication origin and terminus
 *   (the classic minimum/maximum convention), not a determination. It is only
 *   meaningful for a closed replicon, so the output says so and refuses to
 *   interpret very short sequences.
 * - Nucleotide skew is computed on unambiguous bases only; N and other IUPAC
 *   codes are counted and reported separately rather than silently treated as
 *   a base.
 */

import { MolbioInputError, normalizeSequence } from './lib.mjs';
import {
  axis,
  indexScale,
  legendRow,
  linearScale,
  niceTicks,
  panel,
  rect,
  round,
  series,
  svgDocument,
  textRun,
} from './svgio.mjs';

/** Published CpG island criteria, with their source named. */
export const CPG_CRITERIA = {
  gardiner: {
    name: 'gardiner',
    window: 100,
    min_length: 200,
    gc_threshold: 50,
    cpg_oe_threshold: 0.6,
    reference: 'Gardiner-Garden & Frommer 1987 (J Mol Biol 196:261)',
  },
  takai: {
    name: 'takai',
    window: 500,
    min_length: 500,
    gc_threshold: 55,
    cpg_oe_threshold: 0.65,
    reference: 'Takai & Jones 2002 (PNAS 99:3740)',
  },
};

export const COMPOSITION_DEFAULTS = {
  window: 100,
  min_windows: 3,
  top_words: 20,
  max_word_length: 3,
};

/** GC percent of a stretch, ignoring anything that is not A/C/G/T. */
function gcPercentOf(sequence) {
  let gc = 0;
  let at = 0;
  for (const base of sequence) {
    if (base === 'G' || base === 'C') gc++;
    else if (base === 'A' || base === 'T') at++;
  }
  return gc + at === 0 ? 0 : (gc / (gc + at)) * 100;
}

/** Observed/expected CpG for a stretch (Gardiner-Garden's ratio). */
function cpgObservedExpected(sequence) {
  let c = 0;
  let g = 0;
  let cpg = 0;
  let length = 0;
  for (let index = 0; index < sequence.length; index++) {
    const base = sequence[index];
    if (base === 'C') c++;
    else if (base === 'G') g++;
    else if (base !== 'A' && base !== 'T') continue;
    length++;
    if (base === 'G' && sequence[index - 1] === 'C') cpg++;
  }
  const expected = length === 0 ? 0 : (c * g) / length;
  return { observed: cpg, expected, ratio: expected === 0 ? 0 : cpg / expected };
}

/** Shannon entropy in bits per base over A/C/G/T. */
function entropyOf(sequence) {
  const counts = new Map();
  let total = 0;
  for (const base of sequence) {
    if (base !== 'A' && base !== 'C' && base !== 'G' && base !== 'T') continue;
    counts.set(base, (counts.get(base) ?? 0) + 1);
    total++;
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Linguistic complexity (Trifonov): the number of DISTINCT substrings of every
 * length, divided by the number that a sequence of this length could have. A
 * value near 1 means every possible word appears; low values mean repeats.
 */
function linguisticComplexity(sequence) {
  const n = sequence.length;
  if (n < 2) return 0;
  let observed = 0;
  let possible = 0;
  const maxK = Math.min(n, 12);
  for (let k = 1; k <= maxK; k++) {
    const seen = new Set();
    for (let index = 0; index + k <= n; index++) seen.add(sequence.slice(index, index + k));
    observed += seen.size;
    possible += n - k + 1;
  }
  return possible === 0 ? 0 : round(observed / possible, 4);
}

/** N50/L50 over the lengths of maximal non-N blocks. */
function contigStats(sequence) {
  const blocks = sequence.split(/[^ACGT]+/).filter((block) => block !== '');
  if (blocks.length === 0) return { n50: 0, l50: 0 };
  const lengths = blocks.map((block) => block.length).sort((a, b) => b - a);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let running = 0;
  for (let index = 0; index < lengths.length; index++) {
    running += lengths[index];
    if (running >= total / 2) return { n50: lengths[index], l50: index + 1 };
  }
  return { n50: lengths[lengths.length - 1], l50: lengths.length };
}

/** Dinucleotide observed/expected over all 16 pairs. */
function dinucleotideReport(sequence) {
  const counts = new Map();
  let total = 0;
  for (let index = 0; index + 1 < sequence.length; index++) {
    const pair = sequence.slice(index, index + 2);
    if (!/^[ACGT]{2}$/.test(pair)) continue;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
    total++;
  }
  const baseCount = { A: 0, C: 0, G: 0, T: 0 };
  for (const base of sequence) if (baseCount[base] !== undefined) baseCount[base]++;
  const bases = total === 0 ? 0 : Object.values(baseCount).reduce((sum, value) => sum + value, 0);
  const rows = [];
  for (const first of ['A', 'C', 'G', 'T']) {
    for (const second of ['A', 'C', 'G', 'T']) {
      const pair = first + second;
      const observed = counts.get(pair) ?? 0;
      const expected = bases === 0 ? 0 : (baseCount[first] * baseCount[second]) / bases;
      rows.push({
        pair,
        observed,
        expected: round(expected, 2),
        observed_expected: expected === 0 ? 0 : round(observed / expected, 3),
        frequency_per_kb: total === 0 ? 0 : round((observed / total) * 1000, 2),
      });
    }
  }
  return rows;
}

/** The most frequent words of each length up to `maxLength`. */
function topWords(sequence, maxLength, count) {
  const rows = [];
  for (let k = 1; k <= maxLength; k++) {
    const counts = new Map();
    let total = 0;
    for (let index = 0; index + k <= sequence.length; index++) {
      const word = sequence.slice(index, index + k);
      if (!/^[ACGT]+$/.test(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
      total++;
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, count);
    for (const [word, occurrences] of top) {
      rows.push({
        word,
        length: k,
        count: occurrences,
        frequency_per_kb: total === 0 ? 0 : round((occurrences / total) * 1000, 2),
      });
    }
  }
  return rows;
}

/**
 * The whole composition report.
 *
 * @param {string} raw sequence (IUPAC tolerated)
 * @param {object} [options]
 */
export function gcComposition(raw, options = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new MolbioInputError('the sequence is empty');
  const sequence = normalizeSequence(raw);
  if (sequence === '') throw new MolbioInputError('the sequence is empty');
  const criteriaName = options.criteria ?? 'gardiner';
  const base = CPG_CRITERIA[criteriaName];
  if (base === undefined) {
    throw new MolbioInputError(`unknown CpG criteria ${JSON.stringify(criteriaName)}; available: ${Object.keys(CPG_CRITERIA).join(', ')}`);
  }
  const criteria = {
    ...base,
    window: options.window ?? base.window,
    min_length: options.min_length ?? base.min_length,
    gc_threshold: options.gc_threshold ?? base.gc_threshold,
    cpg_oe_threshold: options.cpg_oe_threshold ?? base.cpg_oe_threshold,
  };
  if (!Number.isInteger(criteria.window) || criteria.window < 10) throw new MolbioInputError('window must be an integer of at least 10 bp');
  if (!Number.isInteger(criteria.min_length) || criteria.min_length < 1) throw new MolbioInputError('min_length must be a positive integer');
  const step = options.step ?? criteria.window;
  if (!Number.isInteger(step) || step < 1) throw new MolbioInputError('step must be a positive integer');

  const notes = [];
  if (sequence.length < criteria.min_length * 2) {
    notes.push(`the sequence (${sequence.length} bp) is short relative to the island criteria (min length ${criteria.min_length} bp), so island calls are weak evidence`);
  }
  const ambiguous = [...sequence].filter((letter) => letter !== 'A' && letter !== 'C' && letter !== 'G' && letter !== 'T').length;
  if (ambiguous > 0) notes.push(`${ambiguous} base(s) are ambiguous (N or another IUPAC code) and are excluded from the skew, CpG and word statistics`);

  // ── sliding windows ───────────────────────────────────────────────────────
  const gcWindows = [];
  const gcSkewWindows = [];
  const atSkewWindows = [];
  let cumulativeGc = 0;
  let cumulativeAt = 0;
  const cumulativeGcSeries = [];
  const cumulativeAtSeries = [];
  for (let start = 0; start + criteria.window <= sequence.length; start += step) {
    const slice = sequence.slice(start, start + criteria.window);
    let g = 0;
    let c = 0;
    let a = 0;
    let t = 0;
    for (const letter of slice) {
      if (letter === 'G') g++;
      else if (letter === 'C') c++;
      else if (letter === 'A') a++;
      else if (letter === 'T') t++;
    }
    const gc = g + c === 0 ? 0 : (g - c) / (g + c);
    const at = a + t === 0 ? 0 : (a - t) / (a + t);
    cumulativeGc += gc;
    cumulativeAt += at;
    gcWindows.push({ start: start + 1, end: start + criteria.window, gc_percent: round(gcPercentOf(slice), 2) });
    gcSkewWindows.push({ start: start + 1, end: start + criteria.window, gc_skew: round(gc, 4) });
    atSkewWindows.push({ start: start + 1, end: start + criteria.window, at_skew: round(at, 4) });
    cumulativeGcSeries.push(round(cumulativeGc, 4));
    cumulativeAtSeries.push(round(cumulativeAt, 4));
  }
  const windowCount = gcWindows.length;

  // ── CpG islands: qualifying windows merged when they overlap or abut ──────
  const islands = [];
  let current = undefined;
  for (const window of gcWindows) {
    const slice = sequence.slice(window.start - 1, window.end);
    const cpg = cpgObservedExpected(slice);
    const qualifies = window.gc_percent > criteria.gc_threshold && cpg.ratio > criteria.cpg_oe_threshold;
    if (!qualifies) {
      if (current !== undefined) {
        islands.push(current);
        current = undefined;
      }
      continue;
    }
    if (current === undefined) {
      current = { start: window.start, end: window.end };
      continue;
    }
    if (window.start <= current.end + step) {
      current.end = Math.max(current.end, window.end);
      continue;
    }
    islands.push(current);
    current = { start: window.start, end: window.end };
  }
  if (current !== undefined) islands.push(current);
  const cpgIslands = islands
    .map((island) => {
      const slice = sequence.slice(island.start - 1, island.end);
      const cpg = cpgObservedExpected(slice);
      return {
        start: island.start,
        end: island.end,
        length: island.end - island.start + 1,
        gc_percent: round(gcPercentOf(slice), 2),
        cpg_observed: cpg.observed,
        cpg_expected: round(cpg.expected, 2),
        cpg_oe: round(cpg.ratio, 3),
      };
    })
    .filter((island) => island.length >= criteria.min_length);

  // ── origin/terminus hints from cumulative GC skew ─────────────────────────
  let oriHint = {};
  let terHint = {};
  if (windowCount >= COMPOSITION_DEFAULTS.min_windows) {
    let minIndex = 0;
    let maxIndex = 0;
    cumulativeGcSeries.forEach((value, index) => {
      if (value < cumulativeGcSeries[minIndex]) minIndex = index;
      if (value > cumulativeGcSeries[maxIndex]) maxIndex = index;
    });
    oriHint = { window: minIndex + 1, position: gcWindows[minIndex].start, value: cumulativeGcSeries[minIndex] };
    terHint = { window: maxIndex + 1, position: gcWindows[maxIndex].start, value: cumulativeGcSeries[maxIndex] };
    notes.push('cumulative GC skew is an INDICATOR of the replication origin (minimum) and terminus (maximum); it is meaningful for a closed replicon, and it is not a determination');
  } else {
    notes.push(`only ${windowCount} window(s) fit, so no cumulative-skew origin/terminus hint is offered`);
  }

  const wholeSequenceCpg = cpgObservedExpected(sequence);
  const contigs = contigStats(sequence);
  const totals = { A: 0, C: 0, G: 0, T: 0 };
  for (const letter of sequence) if (totals[letter] !== undefined) totals[letter]++;
  const acgt = totals.A + totals.C + totals.G + totals.T;

  return {
    length: sequence.length,
    gc_percent: round(gcPercentOf(sequence), 2),
    at_percent: acgt === 0 ? 0 : round(((totals.A + totals.T) / acgt) * 100, 2),
    n_percent: sequence.length === 0 ? 0 : round((ambiguous / sequence.length) * 100, 2),
    gc_windows: gcWindows,
    gc_skew_windows: gcSkewWindows,
    at_skew_windows: atSkewWindows,
    cumulative_gc_skew: cumulativeGcSeries,
    cumulative_at_skew: cumulativeAtSeries,
    ori_hint: oriHint,
    ter_hint: terHint,
    cpg_islands: cpgIslands,
    criteria: {
      name: criteria.name,
      window: criteria.window,
      min_length: criteria.min_length,
      gc_threshold: criteria.gc_threshold,
      cpg_oe_threshold: criteria.cpg_oe_threshold,
      reference: criteria.reference,
    },
    observed_expected_cpg: round(wholeSequenceCpg.ratio, 3),
    dinucleotides: dinucleotideReport(sequence),
    top_words: topWords(sequence, COMPOSITION_DEFAULTS.max_word_length, options.top_words ?? COMPOSITION_DEFAULTS.top_words),
    entropy_bits: round(entropyOf(sequence), 4),
    linguistic_complexity: linguisticComplexity(sequence),
    n50: contigs.n50,
    l50: contigs.l50,
    notes,
  };
}

// ── the figure ──────────────────────────────────────────────────────────────

const PANEL = { width: 660, height: 240, gap: 14, margin: 16, header: 66 };
const INSET = { top: 40, right: 16, bottom: 50, left: 52 };

/** Three panels: GC with island shading, cumulative skew, dinucleotide O/E. */
export function renderCompositionSvg(report, { title = 'GC composition' } = {}) {
  const panels = [];
  const positionScale = linearScale([1, Math.max(2, report.length)], [0, 1]);

  // 1. GC content per window with the island spans shaded underneath.
  panels.push({
    title: 'GC content',
    subtitle: `${report.gc_percent}% overall · window ${report.criteria.window} bp · ${report.cpg_islands.length} CpG island(s) shaded`,
    draw: (plot) => {
      const yOf = linearScale([0, 100], [plot.y + plot.height, plot.y]);
      const xOf = (position) => plot.x + positionScale.of(position) * plot.width;
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, 25, 50, 75, 100].map((value) => yOf.of(value)),
        tickLabel: (pixel) => `${round(yOf.invert(pixel), 0)}%`,
        orientation: 'y', title: 'GC%',
      })];
      for (const island of report.cpg_islands) {
        parts.push(rect({ x: xOf(island.start), y: plot.y, width: Math.max(1, xOf(island.end) - xOf(island.start)), height: plot.height, fill: '#0969da', fillOpacity: 0.12 }));
      }
      parts.push(series({ values: report.gc_windows.map((window) => window.gc_percent), xOf: (index) => xOf((report.gc_windows[index].start + report.gc_windows[index].end) / 2), yOf: yOf.of, stroke: '#0969da', width: 1.6 }));
      parts.push(axis({
        from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
        ticks: niceTicks([1, report.length], 4).map((value) => xOf(value)),
        tickLabel: (pixel) => String(round(positionScale.invert((pixel - plot.x) / plot.width), 0)),
        title: 'position (bp)',
      }));
      parts.push(legendRow({ x: plot.x, y: plot.y + plot.height + 36, entries: [{ fill: '#0969da', label: 'GC% / window' }, { fill: '#0969da', label: 'CpG island' }], gap: 110 }));
      return parts.join('\n');
    },
  });

  // 2. Cumulative GC skew, with the ori/ter hints marked.
  panels.push({
    title: 'Cumulative GC skew',
    subtitle: 'minimum ≈ origin, maximum ≈ terminus (an indicator, not a call)',
    draw: (plot) => {
      const values = report.cumulative_gc_skew;
      if (values.length === 0) {
        return textRun({ x: plot.x, y: plot.y + 20, text: 'not enough windows for a skew profile', size: 11, fill: '#57606a' });
      }
      const low = Math.min(0, ...values);
      const high = Math.max(0, ...values);
      // A sequence with no G/C asymmetry has an all-zero profile; without a
      // floor the whole curve and both markers would collapse onto the axis.
      const span = high - low === 0 ? 1 : high - low;
      const yOf = linearScale([low - span * 0.1, high + span * 0.1], [plot.y + plot.height, plot.y]);
      const xOf = indexScale(values.length, [plot.x, plot.x + plot.width]);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [low, 0, high].filter((value, index, all) => all.indexOf(value) === index).map((value) => yOf.of(value)),
        tickLabel: (pixel) => String(round(yOf.invert(pixel), 2)),
        orientation: 'y', title: 'cumulative skew',
      })];
      parts.push(series({ values, xOf: xOf.of, yOf: yOf.of, stroke: '#8250df', width: 1.8 }));
      const marker = (hint, color, label, above) => {
        if (hint.window === undefined) return '';
        const x = xOf.of(hint.window - 1);
        const y = yOf.of(hint.value);
        return [
          rect({ x: x - 3, y: y - 3, width: 6, height: 6, fill: color }),
          // One label above and one below the line: when ori and ter coincide
          // (an all-zero profile) they would otherwise print on top of each other.
          textRun({ x: x + 7, y: y + (above ? -6 : 12), text: label, size: 9, fill: color }),
        ].join('\n');
      };
      parts.push(marker(report.ori_hint ?? {}, '#d1242f', 'ori', true));
      parts.push(marker(report.ter_hint ?? {}, '#1a7f37', 'ter', false));
      parts.push(axis({
        from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
        ticks: [0, (values.length - 1) / 2, values.length - 1].map((value) => xOf.of(value)),
        tickLabel: (pixel) => `w${round(xOf.invert(pixel) + 1, 0)}`,
        title: 'window index',
      }));
      return parts.join('\n');
    },
  });

  // 3. Dinucleotide observed/expected, with CpG called out.
  panels.push({
    title: 'Dinucleotide observed/expected',
    subtitle: '1.0 = as expected from base composition',
    draw: (plot) => {
      const rows = report.dinucleotides;
      const peak = Math.max(1.2, ...rows.map((row) => row.observed_expected));
      const yOf = linearScale([0, peak], [plot.y + plot.height, plot.y]);
      const xOf = indexScale(rows.length, [plot.x, plot.x + plot.width]);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: niceTicks([0, peak], 4).map((value) => yOf.of(value)),
        tickLabel: (pixel) => String(round(yOf.invert(pixel), 2)),
        orientation: 'y', title: 'obs/exp',
      })];
      parts.push(series({ values: rows.map(() => 1), xOf: xOf.of, yOf: yOf.of, stroke: '#8c959f', width: 1, dash: [4, 3] }));
      rows.forEach((row, index) => {
        const top = yOf.of(row.observed_expected);
        parts.push(rect({ x: xOf.of(index) - xOf.width * 0.35, y: Math.min(top, yOf.of(1)), width: Math.max(1, xOf.width * 0.7), height: Math.abs(top - yOf.of(1)), fill: row.pair === 'CG' ? '#d1242f' : '#0969da', fillOpacity: row.pair === 'CG' ? 0.85 : 0.55 }));
        // Every bar is labelled with its own dinucleotide: a tick per bar with
        // a "first base" legend was ambiguous about which bar was which.
        if (index % 2 === 0) {
          parts.push(textRun({ x: xOf.of(index), y: plot.y + plot.height + 12, text: row.pair, size: 9, fill: row.pair === 'CG' ? '#d1242f' : '#57606a', anchor: 'middle', rotate: -60 }));
        }
      });
      parts.push(textRun({ x: plot.x, y: plot.y + plot.height + 34, text: 'every other dinucleotide is labelled (AA AC AG AT CA …); CpG is the red bar', size: 9, fill: '#57606a' }));
      return parts.join('\n');
    },
  });

  const rows = Math.ceil(panels.length);
  const width = PANEL.margin * 2 + PANEL.width;
  const height = PANEL.header + PANEL.margin + rows * PANEL.height + (rows - 1) * PANEL.gap;
  const body = [
    textRun({ x: PANEL.margin, y: 26, text: title, size: 16, weight: 'bold' }),
    textRun({ x: PANEL.margin, y: 44, text: `${report.length} bp · GC ${report.gc_percent}% · CpG obs/exp ${report.observed_expected_cpg} · entropy ${report.entropy_bits} bits · complexity ${report.linguistic_complexity}`, size: 10, fill: '#57606a' }),
    textRun({ x: PANEL.margin, y: 57, text: `CpG islands: ${report.criteria.name} criteria (${report.criteria.reference})`, size: 10, fill: '#57606a' }),
  ];
  panels.forEach((item, index) => {
    const y = PANEL.header + PANEL.margin + index * (PANEL.height + PANEL.gap);
    const frame = panel({ x: PANEL.margin, y, width: PANEL.width, height: PANEL.height, title: item.title, subtitle: item.subtitle, inset: INSET });
    body.push(frame.markup);
    body.push(item.draw(frame.plot));
  });
  return svgDocument({ width, height, title, description: `GC composition: ${report.length} bp, GC ${report.gc_percent}%`, body: body.join('\n') });
}
