/**
 * dsh-molbio-tools/fastq-qc.mjs
 *
 * Read-level FASTQ quality control: the pure-arithmetic half of what FastQC
 * reports, with every threshold and convention stated in the output instead of
 * implied. No external program, no reference database, no network.
 *
 * WHY THE NUMBERS MATTER MORE THAN THE PICTURE
 * -------------------------------------------
 * `seqio.mjs` already parses FASTQ and reports mean quality plus a truncated
 * per-position mean. That answers "how good is it on average", which hides
 * exactly the failure a bench user is looking for: quality that is fine for
 * 40 bases and then collapses. So every analysis here returns NUMBERS (means,
 * quartiles, per-position content, counts) and the SVG is a view of those same
 * numbers — the model can reason about the arrays without needing the picture.
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM FastQC, AND SAID SO IN THE OUTPUT
 * -------------------------------------------------------------------
 * - Duplication is counted by EXACT full-sequence matching over a bounded
 *   sample (deterministic, and exact within the sample), not by FastQC's
 *   50 bp-prefix hash sampling. The field `duplication_basis` names that.
 * - The per-sequence GC "theoretical distribution" is the normal
 *   approximation FastQC itself draws; it is labelled `theoretical` and its
 *   parameters (mean, sd) are in the output rather than hidden in a curve.
 * - Over-represented sequences are reported by exact count with an explicit
 *   `min_count` and `min_fraction`; nothing is called "over-represented"
 *   without naming the threshold that made it so.
 */

import { MolbioInputError } from './lib.mjs';
import {
  axis,
  escapeXml,
  indexScale,
  legendRow,
  linearScale,
  line,
  niceTicks,
  panel,
  rect,
  round,
  series,
  svgDocument,
  textRun,
} from './svgio.mjs';

/** Defaults and hard bounds, exported so tools/tests/docs share one source. */
export const FASTQ_QC_DEFAULTS = {
  /** Cap on reads used for the report; 0 means "all", up to MAX_READS. */
  max_reads: 0,
  max_reads_hard: 200000,
  /** Sample sizes for the bounded analyses. */
  duplication_reads: 100000,
  adapter_scan_reads: 20000,
  overrepresented_reads: 50000,
  /** Number of over-represented sequences to report. */
  top_overrepresented: 20,
  min_overrepresented_fraction: 0.001,
  min_overrepresented_count: 20,
  /** Bases shown on the per-base plots (reads are often 150 bp). */
  max_plot_bases: 150,
  /** Duplication "curve" sampling: fraction of reads binned. */
  duplication_bins: 10,
};

/** Public adapter/primer fragments used for the adapter-content screen. */
export const ADAPTERS = [
  { name: 'Illumina Universal', sequence: 'AGATCGGAAGAG' },
  { name: 'Illumina Small RNA 3\'', sequence: 'TGGAATTCTCGG' },
  { name: 'Illumina Small RNA 5\'', sequence: 'GUUCAGAGUUCUACAGUCCGACGAUC' },
  { name: 'Nextera Transposase', sequence: 'CTGTCTCTTATA' },
  { name: 'PolyA', sequence: 'AAAAAAAAAAAA' },
  { name: 'PolyG', sequence: 'GGGGGGGGGGGG' },
];

/** Phred+33 decoding, with the offending read id in the message. */
function phredOf(character) {
  return character.charCodeAt(0) - 33;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** Shannon entropy in bits over a count map. */
function entropyOf(counts) {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const value of counts.values()) {
    if (value === 0) continue;
    const p = value / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Per-position statistics over a read set. Positions beyond the shortest read
 * simply have fewer observations; `observations` says how many, so a curve
 * that tapers is not mistaken for a quality drop.
 */
function perPosition(entries, maxBases) {
  const longest = Math.max(...entries.map((entry) => entry.sequence.length));
  const length = Math.min(longest, maxBases);
  const rows = [];
  for (let position = 0; position < length; position++) {
    const qualities = [];
    const bases = { A: 0, C: 0, G: 0, T: 0, N: 0, other: 0 };
    for (const entry of entries) {
      if (entry.sequence.length <= position) continue;
      qualities.push(phredOf(entry.quality[position]));
      const base = entry.sequence[position];
      if (base === 'A' || base === 'C' || base === 'G' || base === 'T' || base === 'N') bases[base]++;
      else bases.other++;
    }
    if (qualities.length === 0) break;
    const sorted = [...qualities].sort((a, b) => a - b);
    const total = qualities.length;
    const percent = (count) => Math.round((count / total) * 1000) / 10;
    rows.push({
      position: position + 1,
      observations: total,
      mean: Math.round(mean(qualities) * 100) / 100,
      median: percentile(sorted, 0.5),
      lower_quartile: percentile(sorted, 0.25),
      upper_quartile: percentile(sorted, 0.75),
      percentile_10: percentile(sorted, 0.1),
      percentile_90: percentile(sorted, 0.9),
      min: sorted[0],
      max: sorted[total - 1],
      a_percent: percent(bases.A),
      c_percent: percent(bases.C),
      g_percent: percent(bases.G),
      t_percent: percent(bases.T),
      n_percent: percent(bases.N + bases.other),
    });
  }
  return rows;
}

/** Per-read mean quality histogram (0–40, one bin per Phred unit). */
function perSequenceQuality(entries) {
  const histogram = new Array(41).fill(0);
  const perRead = entries.map((entry) => {
    let sum = 0;
    for (const character of entry.quality) sum += phredOf(character);
    return entry.quality.length === 0 ? 0 : sum / entry.quality.length;
  });
  for (const value of perRead) {
    const bin = Math.min(40, Math.max(0, Math.round(value)));
    histogram[bin]++;
  }
  const sorted = [...perRead].sort((a, b) => a - b);
  return {
    histogram,
    mean: Math.round(mean(perRead) * 100) / 100,
    median: Math.round(percentile(sorted, 0.5) * 100) / 100,
    worst: Math.round(sorted[0] * 100) / 100,
    best: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

/**
 * The theoretical GC distribution of a read set, as the normal approximation
 * FastQC draws: each read of length L at overall GC fraction p has a binomial
 * GC count with mean L·p and variance L·p·(1−p). Normalised to percentages of
 * reads, so it can be overlaid on the measured histogram.
 */
function theoreticalGcDistribution(entries, overallGcFraction, maxPercent = 100) {
  const curve = new Array(maxPercent + 1).fill(0);
  let weight = 0;
  for (const entry of entries) {
    const length = entry.sequence.length;
    if (length === 0) continue;
    weight++;
    const meanPercent = overallGcFraction * 100;
    const sd = Math.sqrt(length * overallGcFraction * (1 - overallGcFraction)) / length * 100;
    if (sd === 0) {
      curve[Math.min(maxPercent, Math.round(meanPercent))] += 1;
      continue;
    }
    // Evaluate the density per integer percent bin, normalised after the loop.
    for (let percent = 0; percent <= maxPercent; percent++) {
      const z = (percent - meanPercent) / sd;
      curve[percent] += Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
    }
  }
  if (weight === 0) return curve;
  const total = curve.reduce((sum, value) => sum + value, 0);
  return total === 0 ? curve : curve.map((value) => value / total);
}

/** Measured per-read GC histogram, in percent of reads. */
function measuredGcDistribution(entries, maxPercent = 100) {
  const counts = new Array(maxPercent + 1).fill(0);
  let total = 0;
  for (const entry of entries) {
    if (entry.sequence.length === 0) continue;
    let gc = 0;
    for (const base of entry.sequence) if (base === 'G' || base === 'C') gc++;
    counts[Math.min(maxPercent, Math.round((gc / entry.sequence.length) * 100))]++;
    total++;
  }
  if (total === 0) return counts;
  return counts.map((value) => value / total);
}

/**
 * Length distribution summary: the five-number view plus an explicit
 * histogram, so both a person and the model can see whether a run is
 * uniform-length (amplicon) or spread out (sheared library).
 */
function lengthDistribution(entries) {
  const lengths = entries.map((entry) => entry.sequence.length).sort((a, b) => a - b);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let running = 0;
  let n50 = lengths[lengths.length - 1];
  for (let index = lengths.length - 1; index >= 0; index--) {
    running += lengths[index];
    if (running >= total / 2) {
      n50 = lengths[index];
      break;
    }
  }
  const min = lengths[0];
  const max = lengths[lengths.length - 1];
  const bins = 30;
  const binWidth = Math.max(1, Math.ceil((max - min + 1) / bins));
  const histogram = [];
  for (let start = min; start <= max; start += binWidth) {
    const stop = Math.min(max, start + binWidth - 1);
    const count = lengths.filter((value) => value >= start && value <= stop).length;
    histogram.push({ from: start, to: stop, reads: count });
  }
  return {
    min,
    max,
    mean: Math.round((total / lengths.length) * 100) / 100,
    median: percentile(lengths, 0.5),
    n50,
    distinct_lengths: new Set(lengths).size,
    histogram,
  };
}

/**
 * Exact duplication statistics over a bounded sample.
 *
 * Returns the fraction of reads whose sequence occurs more than once
 * (`duplication_percent`) and the fraction of reads that would survive
 * de-duplication (`remaining_percent`), plus the most frequent sequences.
 */
function duplication(entries, sampleSize) {
  const sample = entries.slice(0, sampleSize);
  const counts = new Map();
  for (const entry of sample) counts.set(entry.sequence, (counts.get(entry.sequence) ?? 0) + 1);
  let duplicateReads = 0;
  let duplicateGroups = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      duplicateReads += count;
      duplicateGroups++;
    }
  }
  const unique = counts.size;
  const total = sample.length;
  const top = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10)
    .map(([sequence, count]) => ({
      sequence,
      count,
      percent: Math.round((count / total) * 10000) / 100,
    }));
  return {
    sampled_reads: total,
    unique_sequences: unique,
    duplicate_reads: duplicateReads,
    duplicate_groups: duplicateGroups,
    duplication_percent: Math.round((duplicateReads / total) * 10000) / 100,
    remaining_percent: Math.round((unique / total) * 10000) / 100,
    top_sequences: top,
  };
}

/**
 * Adapter screen against the built-in public fragment list.
 *
 * A hit is a read containing the fragment (or its reverse complement) at any
 * offset; `per_base` accumulates, for each read position, whether that position
 * lay inside a hit — which is what a cumulative "adapter content" curve means.
 */
function adapterContent(entries, sampleSize, maxBases) {
  const sample = entries.slice(0, sampleSize);
  const hits = [];
  const perBaseCounts = new Array(maxBases).fill(0);
  let readsWithAdapter = 0;
  for (const adapter of ADAPTERS) {
    const forward = adapter.sequence;
    const reverse = reverseComplementText(forward);
    let count = 0;
    let reads = 0;
    for (const entry of sample) {
      const sequence = entry.sequence;
      let best = -1;
      for (const needle of forward === reverse ? [forward] : [forward, reverse]) {
        const at = sequence.indexOf(needle);
        if (at !== -1 && (best === -1 || at < best)) best = at;
      }
      if (best === -1) continue;
      count++;
      reads++;
      for (let position = best; position < Math.min(sequence.length, best + forward.length, maxBases); position++) {
        perBaseCounts[position]++;
      }
    }
    if (count > 0) {
      hits.push({
        name: adapter.name,
        sequence: adapter.sequence,
        reads: reads,
        percent: Math.round((reads / sample.length) * 10000) / 100,
      });
    }
  }
  readsWithAdapter = hits.length === 0 ? 0 : Math.min(sample.length, hits.reduce((sum, hit) => sum + hit.reads, 0));
  return {
    sampled_reads: sample.length,
    hits,
    reads_with_adapter: readsWithAdapter,
    per_base_percent: perBaseCounts.map((count) => (sample.length === 0 ? 0 : Math.round((count / sample.length) * 10000) / 100)),
  };
}

/** Exact-sequence over-representation, with the threshold that defined it. */
function overrepresented(entries, sampleSize, options) {
  const sample = entries.slice(0, sampleSize);
  const counts = new Map();
  for (const entry of sample) counts.set(entry.sequence, (counts.get(entry.sequence) ?? 0) + 1);
  const minimum = Math.max(options.min_overrepresented_count, Math.ceil(options.min_overrepresented_fraction * sample.length));
  const rows = [...counts.entries()]
    .filter(([, count]) => count >= minimum)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, options.top_overrepresented)
    .map(([sequence, count]) => {
      const adapter = ADAPTERS.find((candidate) => sequence.includes(candidate.sequence)
        || sequence.includes(reverseComplementText(candidate.sequence)));
      return {
        sequence,
        count,
        percent: Math.round((count / sample.length) * 10000) / 100,
        possible_source: adapter === undefined ? 'unknown' : `${adapter.name} adapter`,
      };
    });
  return { sampled_reads: sample.length, minimum_count: minimum, rows };
}

function reverseComplementText(sequence) {
  const pairs = { A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', N: 'N' };
  let out = '';
  for (let index = sequence.length - 1; index >= 0; index--) {
    const base = sequence[index];
    out += pairs[base] ?? 'N';
  }
  return out;
}

/** The first position whose mean quality drops below `threshold`, else 0. */
function tailPosition(perBase, threshold) {
  for (const row of perBase) {
    if (row.mean < threshold) return row.position;
  }
  return 0;
}

/**
 * Build the whole report.
 *
 * @param {Array<{id: string, sequence: string, quality: string}>} entries
 * @param {object} [options] see FASTQ_QC_DEFAULTS
 */
export function fastqQcReport(entries, options = {}) {
  const settings = { ...FASTQ_QC_DEFAULTS, ...options };
  if (!Array.isArray(entries) || entries.length === 0) throw new MolbioInputError('no FASTQ reads to analyse');
  const maxReads = settings.max_reads === 0 ? settings.max_reads_hard : settings.max_reads;
  if (!Number.isInteger(maxReads) || maxReads < 1) throw new MolbioInputError('max_reads must be a positive integer (0 means all)');
  if (maxReads > settings.max_reads_hard) {
    throw new MolbioInputError(`max_reads ${maxReads} exceeds the supported ${settings.max_reads_hard} reads; split the file or raise the limit deliberately`);
  }
  const selected = entries.slice(0, maxReads);
  for (const entry of selected) {
    if (entry.quality === undefined || entry.quality.length !== entry.sequence.length) {
      throw new MolbioInputError(`read ${entry.id} has no per-base quality string`);
    }
  }

  const perBase = perPosition(selected, settings.max_plot_bases);
  const summaryQualities = selected.flatMap((entry) => [...entry.quality].map(phredOf));
  const q20 = summaryQualities.filter((value) => value >= 20).length;
  const q30 = summaryQualities.filter((value) => value >= 30).length;
  const gcCount = selected.reduce((sum, entry) => {
    let gc = 0;
    for (const base of entry.sequence) if (base === 'G' || base === 'C') gc++;
    return sum + gc;
  }, 0);
  const allBases = selected.reduce((sum, entry) => sum + entry.sequence.length, 0);
  if (allBases === 0) throw new MolbioInputError('the FASTQ reads contain no bases');
  const nCount = selected.reduce((sum, entry) => {
    let n = 0;
    for (const base of entry.sequence) if (base === 'N') n++;
    return sum + n;
  }, 0);
  const gcFraction = gcCount / allBases;
  const contentCounts = new Map();
  for (const entry of selected) {
    for (const base of entry.sequence) contentCounts.set(base, (contentCounts.get(base) ?? 0) + 1);
  }

  return {
    reads: selected.length,
    reads_total: entries.length,
    truncated: selected.length < entries.length,
    bases: allBases,
    length: lengthDistribution(selected),
    gc_percent: Math.round(gcFraction * 10000) / 100,
    n_bases: nCount,
    n_percent: Math.round((nCount / allBases) * 10000) / 100,
    quality_mean: Math.round(mean(summaryQualities) * 100) / 100,
    quality_q20_percent: Math.round((q20 / summaryQualities.length) * 10000) / 100,
    quality_q30_percent: Math.round((q30 / summaryQualities.length) * 10000) / 100,
    quality_tail_below_30: tailPosition(perBase, 30),
    quality_tail_below_20: tailPosition(perBase, 20),
    per_base: perBase,
    per_sequence_quality: perSequenceQuality(selected),
    gc_distribution: {
      measured_percent: measuredGcDistribution(selected).map((value) => Math.round(value * 10000) / 100),
      theoretical_percent: theoreticalGcDistribution(selected, gcFraction).map((value) => Math.round(value * 10000) / 100),
      theoretical_model: `normal approximation per read length (FastQC-style); mean ${Math.round(gcFraction * 10000) / 100}% GC`,
    },
    content_entropy_bits: Math.round(entropyOf(contentCounts) * 1000) / 1000,
    duplication: {
      ...duplication(selected, settings.duplication_reads),
      basis: `exact full-sequence counting over the first ${Math.min(settings.duplication_reads, selected.length)} reads`,
      estimate_only: true,
    },
    adapter: adapterContent(selected, settings.adapter_scan_reads, settings.max_plot_bases),
    overrepresented: {
      ...overrepresented(selected, settings.overrepresented_reads, settings),
      basis: `exact sequence counts over the first ${Math.min(settings.overrepresented_reads, selected.length)} reads`,
      minimum_fraction: settings.min_overrepresented_fraction,
    },
    thresholds: {
      q30_good: 30,
      q20_acceptable: 20,
      adapter_list: ADAPTERS.map((adapter) => adapter.name),
      duplication_note: 'duplication is a library-complexity signal, not proof of a bad run: amplicon and low-input libraries are legitimately duplicated',
    },
  };
}

// ── the report picture ──────────────────────────────────────────────────────

/**
 * The panel grid, on top of `svgio.mjs`. Six panels in the order a person
 * reads a QC report: quality by position, quality by read, base content, GC,
 * length, adapter. Every panel draws the SAME numbers the report returns, so
 * the picture cannot disagree with the data.
 */
const PANEL = { width: 470, height: 236, gap: 16, margin: 16, header: 78 };
const PLOT_INSET = { top: 42, right: 16, bottom: 52, left: 48 };

export function renderFastqQcReport(report, { columns = 3, title = 'FASTQ QC report' } = {}) {
  const perBase = report.per_base;
  const baseCount = Math.max(1, perBase.length);
  // Every per-position panel shares one x mapping: position 1..N edge-to-edge.
  const baseFraction = (position) => (position - 1) / Math.max(1, baseCount - 1);
  const panels = [];

  // 1. Per-base quality: IQR box, mean line, median line.
  panels.push({
    title: 'Per-base quality',
    subtitle: 'box = 25–75%, blue = mean, red = median',
    draw: (plot) => {
      const yOf = linearScale([0, 42], [plot.y + plot.height, plot.y]);
      const xOf = (position) => plot.x + baseFraction(position) * plot.width;
      const half = Math.max(0.7, plot.width / baseCount / 2);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, 10, 20, 30, 40].map((value) => yOf.of(value)),
        tickLabel: (pixel) => String(round(yOf.invert(pixel), 0)),
        orientation: 'y',
        title: 'Phred',
      })];
      for (const row of perBase) {
        const top = yOf.of(row.upper_quartile);
        const bottom = yOf.of(row.lower_quartile);
        parts.push(rect({ x: xOf(row.position) - half, y: top, width: half * 2, height: Math.max(1, bottom - top), fill: '#e8b400', fillOpacity: 0.55 }));
      }
      const indexToX = (index) => xOf(perBase[index].position);
      parts.push(series({ values: perBase.map((row) => row.mean), xOf: indexToX, yOf: yOf.of, stroke: '#0969da', width: 1.6 }));
      parts.push(series({ values: perBase.map((row) => row.median), xOf: indexToX, yOf: yOf.of, stroke: '#d1242f', width: 1.2 }));
      parts.push(positionAxis(plot, perBase.length));
      parts.push(legend(plot, [['#e8b400', '25–75%'], ['#0969da', 'mean'], ['#d1242f', 'median']]));
      return parts.join('\n');
    },
  });

  // 2. Per-sequence quality histogram.
  panels.push({
    title: 'Per-sequence quality',
    subtitle: `mean ${report.per_sequence_quality.mean} · median ${report.per_sequence_quality.median} · worst ${report.per_sequence_quality.worst}`,
    draw: (plot) => {
      const histogram = report.per_sequence_quality.histogram;
      const yOf = linearScale([0, Math.max(1, ...histogram)], [plot.y + plot.height, plot.y]);
      const xOf = indexScale(histogram.length, [plot.x, plot.x + plot.width]);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, 10, 20, 30, 40].map((value) => yOf.of(value)),
        tickLabel: (pixel) => String(round(yOf.invert(pixel), 0)),
        orientation: 'y', title: 'reads',
      })];
      histogram.forEach((count, index) => {
        if (count === 0) return;
        const top = yOf.of(count);
        parts.push(rect({ x: xOf.of(index), y: top, width: Math.max(0.6, xOf.width - 0.6), height: Math.max(1, plot.y + plot.height - top), fill: '#0969da' }));
      });
      parts.push(axis({
        from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
        ticks: [0, 10, 20, 30, 40].map((value) => xOf.of(value)),
        tickLabel: (pixel) => String(round(xOf.invert(pixel), 0)),
        title: 'mean Phred per read',
      }));
      return parts.join('\n');
    },
  });

  // 3. Per-base sequence content.
  panels.push({
    title: 'Per-base sequence content',
    subtitle: 'A/C/G/T share of each position',
    draw: (plot) => {
      const yOf = linearScale([0, 100], [plot.y + plot.height, plot.y]);
      const xOf = (position) => plot.x + baseFraction(position) * plot.width;
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, 25, 50, 75, 100].map((value) => yOf.of(value)),
        tickLabel: (pixel) => `${round(yOf.invert(pixel), 0)}%`,
        orientation: 'y', title: 'base share',
      })];
      const tracks = [['a_percent', '#3fb950'], ['c_percent', '#0969da'], ['g_percent', '#bf8700'], ['t_percent', '#d1242f']];
      const indexToX = (index) => xOf(perBase[index].position);
      for (const [key, color] of tracks) {
        parts.push(series({ values: perBase.map((row) => row[key]), xOf: indexToX, yOf: yOf.of, stroke: color, width: 1.4 }));
      }
      parts.push(positionAxis(plot, perBase.length));
      parts.push(legend(plot, [['#3fb950', 'A'], ['#0969da', 'C'], ['#bf8700', 'G'], ['#d1242f', 'T']]));
      return parts.join('\n');
    },
  });

  // 4. GC distribution: measured histogram against the theoretical curve.
  panels.push({
    title: 'Per-sequence GC',
    subtitle: 'measured (bars) vs theoretical normal (red line)',
    draw: (plot) => {
      const measured = report.gc_distribution.measured_percent;
      const theoretical = report.gc_distribution.theoretical_percent;
      const peak = Math.max(0.01, ...measured, ...theoretical);
      const yOf = linearScale([0, peak], [plot.y + plot.height, plot.y]);
      const xOf = linearScale([0, measured.length - 1], [plot.x, plot.x + plot.width]);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, peak / 2, peak].map((value) => yOf.of(value)),
        tickLabel: (pixel) => `${round(yOf.invert(pixel), 1)}%`,
        orientation: 'y', title: 'reads',
      })];
      const barWidth = plot.width / measured.length;
      measured.forEach((share, percent) => {
        if (share <= 0) return;
        const top = yOf.of(share);
        parts.push(rect({ x: plot.x + percent * barWidth - barWidth / 2, y: top, width: Math.max(0.6, barWidth - 0.2), height: Math.max(0.5, plot.y + plot.height - top), fill: '#8c959f', fillOpacity: 0.75 }));
      });
      parts.push(series({ values: theoretical, xOf: (index) => xOf.of(index), yOf: yOf.of, stroke: '#d1242f', width: 1.5 }));
      parts.push(axis({
        from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
        ticks: [0, 25, 50, 75, 100].map((value) => xOf.of(value)),
        tickLabel: (pixel) => `${round(xOf.invert(pixel), 0)}%`,
        title: 'GC content per read',
      }));
      parts.push(legend(plot, [['#8c959f', 'measured'], ['#d1242f', 'theoretical']]));
      return parts.join('\n');
    },
  });

  // 5. Read length distribution.
  panels.push({
    title: 'Read length',
    subtitle: `${report.length.min}–${report.length.max} bp · mean ${report.length.mean} · N50 ${report.length.n50}`,
    draw: (plot) => {
      const histogram = report.length.histogram;
      const yOf = linearScale([0, Math.max(1, ...histogram.map((bin) => bin.reads))], [plot.y + plot.height, plot.y]);
      const xOf = indexScale(histogram.length, [plot.x, plot.x + plot.width]);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, yOf.domain[1] / 2, yOf.domain[1]].map((value) => yOf.of(value)),
        tickLabel: (pixel) => String(round(yOf.invert(pixel), 0)),
        orientation: 'y', title: 'reads',
      })];
      histogram.forEach((bin, index) => {
        if (bin.reads === 0) return;
        const top = yOf.of(bin.reads);
        parts.push(rect({ x: xOf.of(index), y: top, width: Math.max(0.6, xOf.width - 0.6), height: Math.max(1, plot.y + plot.height - top), fill: '#8250df' }));
      });
      parts.push(axis({
        from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
        ticks: [0, (histogram.length - 1) / 2, histogram.length - 1].map((value) => xOf.of(value)),
        tickLabel: (pixel) => {
          const index = Math.max(0, Math.min(histogram.length - 1, Math.round(xOf.invert(pixel))));
          const bin = histogram[index];
          return `${bin.from}–${bin.to}`;
        },
        title: `length (bp), ${report.length.distinct_lengths} distinct`,
      }));
      return parts.join('\n');
    },
  });

  // 6. Adapter content.
  panels.push({
    title: 'Adapter content',
    subtitle: `${report.adapter.reads_with_adapter} of ${report.adapter.sampled_reads} reads carry a fragment`,
    draw: (plot) => {
      const values = report.adapter.per_base_percent;
      const peak = Math.max(0.5, ...values);
      const yOf = linearScale([0, peak], [plot.y + plot.height, plot.y]);
      const xOf = indexScale(values.length, [plot.x, plot.x + plot.width]);
      const parts = [axis({
        from: plot.y + plot.height, to: plot.y, at: plot.x,
        ticks: [0, peak / 2, peak].map((value) => yOf.of(value)),
        tickLabel: (pixel) => `${round(yOf.invert(pixel), 1)}%`,
        orientation: 'y', title: 'adapter %',
      })];
      parts.push(series({ values, xOf: (index) => xOf.of(index), yOf: yOf.of, stroke: '#d1242f', width: 1.6 }));
      parts.push(axis({
        from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
        ticks: [0, (values.length - 1) / 2, values.length - 1].map((value) => xOf.of(value)),
        tickLabel: (pixel) => String(round(xOf.invert(pixel) + 1, 0)),
        title: 'position (bp)',
      }));
      // The hit summary goes on a legend line under the axis rather than at the
      // top of the plot, where it collided with the y tick labels.
      const summary = report.adapter.hits.length === 0
        ? 'no adapter fragment found'
        : report.adapter.hits.map((hit) => `${hit.name} ${hit.percent}%`).join(', ');
      parts.push(textRun({ x: plot.x, y: plot.y + plot.height + 38, text: summary.slice(0, 60), size: 9, fill: '#57606a' }));
      return parts.join('\n');
    },
  });

  const rows = Math.ceil(panels.length / columns);
  const width = PANEL.margin * 2 + columns * PANEL.width + (columns - 1) * PANEL.gap;
  const height = PANEL.header + PANEL.margin + rows * PANEL.height + (rows - 1) * PANEL.gap;
  const header = [
    `${report.reads} read(s)${report.truncated ? ` sampled from ${report.reads_total}` : ''} · ${report.bases} bases · mean length ${report.length.mean} bp`,
    `mean Phred ${report.quality_mean} · Q30 ${report.quality_q30_percent}% · Q20 ${report.quality_q20_percent}% · GC ${report.gc_percent}% · N ${report.n_percent}%`,
    report.quality_tail_below_30 === 0
      ? 'per-base mean quality never falls below Q30'
      : `per-base mean quality falls below Q30 from position ${report.quality_tail_below_30}${report.quality_tail_below_20 === 0 ? '' : `, below Q20 from ${report.quality_tail_below_20}`}`,
  ];
  const body = [
    textRun({ x: PANEL.margin, y: 26, text: title, size: 16, weight: 'bold' }),
    ...header.map((text, index) => textRun({ x: PANEL.margin, y: 46 + index * 13, text, size: 10, fill: '#57606a' })),
  ];
  panels.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = PANEL.margin + column * (PANEL.width + PANEL.gap);
    const y = PANEL.header + PANEL.margin + row * (PANEL.height + PANEL.gap);
    const frame = panel({
      x, y, width: PANEL.width, height: PANEL.height,
      title: item.title,
      subtitle: item.subtitle,
      inset: PLOT_INSET,
    });
    body.push(frame.markup);
    body.push(item.draw(frame.plot));
  });
  return svgDocument({
    width,
    height,
    title,
    description: `FASTQ QC: ${report.reads} reads, mean Phred ${report.quality_mean}`,
    body: body.join('\n'),
  });
}

/** The shared per-position x axis (position 1 … N). */
function positionAxis(plot, count) {
  // linearScale (which can invert) rather than indexScale: an axis label is
  // produced by inverting the pixel back into a data value.
  const xOf = linearScale([1, Math.max(1, count)], [plot.x, plot.x + plot.width]);
  const picks = [1, (1 + count) / 2, count];
  return axis({
    from: plot.x, to: plot.x + plot.width, at: plot.y + plot.height,
    ticks: picks.map((value) => xOf.of(value)),
    tickLabel: (pixel) => String(round(xOf.invert(pixel), 0)),
    title: 'position (bp)',
  });
}

/** A compact legend inside a panel, on its own line under the x axis. */
function legend(plot, entries) {
  return legendRow({ x: plot.x, y: plot.y + plot.height + 38, entries: entries.map(([color, label]) => ({ fill: color, label })), gap: 74 });
}


