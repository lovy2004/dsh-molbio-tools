/**
 * dsh-molbio-tools/design.mjs
 *
 * Automatic PCR primer pair design. Pure computation: scans the template for
 * forward primers, scans the reverse complement for reverse primers, then
 * pairs them within the amplicon window and ranks by Tm balance.
 */

import {
  DNA_BASES,
  MolbioInputError,
  baseCounts,
  dimerPotential,
  findHairpins,
  findRuns,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfComplementarity,
} from './lib.mjs';

// Design-time PCR conditions for the NN Tm model.
const DESIGN_TM_OPTS = { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: 200 };

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** One passing primer candidate on the scanned strand (forward: template, reverse: reverse complement). */
function scanCandidates(strand, from, to, opts, clampFrom) {
  const {
    lenMin, lenMax, tmMin, tmMax, gcMin, gcMax,
    requireGcClamp, maxRun, maxSelfScore, maxSelfConsecutive, maxHairpinScore, maxCandidates,
  } = opts;
  const candidates = [];
  const tmCenter = (tmMin + tmMax) / 2;
  for (let start = from; start <= to; start++) {
    for (let len = lenMin; len <= lenMax; len++) {
      if (start + len > strand.length) break;
      const seq = strand.slice(start, start + len);
      let ambiguous = false;
      for (const base of seq) {
        if (!DNA_BASES.has(base)) {
          ambiguous = true;
          break;
        }
      }
      if (ambiguous) continue;
      const { gc, at } = baseCounts(seq);
      const gcPercent = (gc / (gc + at)) * 100;
      if (gcPercent < gcMin || gcPercent > gcMax) continue;
      if (findRuns(seq, maxRun + 1).length > 0) continue;
      if (requireGcClamp && seq[seq.length - 1] !== 'G' && seq[seq.length - 1] !== 'C') continue;
      const sc = selfComplementarity(seq);
      if (sc.bestScore > maxSelfScore || sc.bestConsecutive > maxSelfConsecutive) continue;
      const hairpin = findHairpins(seq, 1)[0];
      if (hairpin !== undefined && hairpin.score > maxHairpinScore) continue;
      let tm;
      try {
        tm = primerTm(seq, DESIGN_TM_OPTS).tm_celsius;
      } catch {
        continue;
      }
      if (tm < tmMin || tm > tmMax) continue;
      candidates.push({
        start,
        length: len,
        sequence: seq,
        tm: round1(tm),
        gc_percent: round1(gcPercent),
        tmDelta: Math.abs(tm - tmCenter),
      });
    }
  }
  candidates.sort((a, b) => a.tmDelta - b.tmDelta || a.start - b.start || a.length - b.length);
  return candidates.slice(0, maxCandidates ?? 2000);
}

/**
 * Design primer pairs flanking an amplicon inside `template`.
 *
 * @param {string} template - normalized template sequence.
 * @param {object} opts - constraints, see DESIGN_DEFAULTS.
 * @returns {Array} ranked pairs.
 */
export function designPrimerPairs(template, opts) {
  const length = template.length;
  const rc = reverseComplement(template);

  // Amplicon window, 0-based inclusive template positions.
  const regionStart = (opts.regionStart ?? 1) - 1;
  const regionEnd = (opts.regionEnd ?? length) - 1;
  if (regionStart < 0 || regionEnd >= length || regionStart >= regionEnd) {
    throw new MolbioInputError(`region ${regionStart + 1}-${regionEnd + 1} is outside the template (length ${length})`);
  }

  // Forward candidates: 3' end must stay inside the region.
  const fwd = scanCandidates(template, regionStart, regionEnd - opts.lenMin + 1, opts);
  // Reverse candidates on the reverse complement, mapped to template coordinates.
  const revOnRc = scanCandidates(rc, 0, rc.length - opts.lenMin, opts);
  const rev = revOnRc
    .map((candidate) => {
      const q = candidate.start;
      const a = length - (q + candidate.length); // 0-based template position of the 3' end
      return { ...candidate, anchor: a };
    })
    .sort((x, y) => x.anchor - y.anchor);
  const anchors = rev.map((candidate) => candidate.anchor);

  const pairs = [];
  const tmCenter = (opts.tmMin + opts.tmMax) / 2;
  for (const f of fwd) {
    const fwdEnd = f.start + f.length - 1; // 0-based 3' end on template
    const aMin = fwdEnd - opts.ampliconMax + 1;
    const aMax = fwdEnd - opts.ampliconMin + 1;
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid] < aMin) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < rev.length; i++) {
      const r = rev[i];
      if (r.anchor > aMax) break;
      if (r.anchor < 0 || r.anchor + r.length - 1 > regionEnd) continue;
      if (Math.abs(f.tm - r.tm) > opts.maxTmDelta) continue;
      const dimer = dimerPotential(f.sequence, r.sequence);
      if (dimer.score > opts.maxDimerScore) continue;
      const ampliconStart = r.anchor;
      const ampliconEnd = fwdEnd;
      const ampliconLength = ampliconEnd - ampliconStart + 1;
      if (ampliconLength < opts.ampliconMin || ampliconLength > opts.ampliconMax) continue;
      const penalty = 0.6 * Math.abs(f.tm - r.tm) + Math.abs(f.tm - tmCenter) + Math.abs(r.tm - tmCenter) + dimer.score / 10;
      pairs.push({
        forward: {
          sequence: f.sequence,
          start: f.start + 1,
          end: f.start + f.length,
          length: f.length,
          tm: f.tm,
          gc_percent: f.gc_percent,
        },
        reverse: {
          sequence: r.sequence,
          start: r.anchor + 1,
          end: r.anchor + r.length,
          length: r.length,
          tm: r.tm,
          gc_percent: r.gc_percent,
        },
        amplicon: {
          start: ampliconStart + 1,
          end: ampliconEnd + 1,
          length: ampliconLength,
        },
        penalty: Math.round(penalty * 100) / 100,
      });
    }
  }
  pairs.sort((a, b) => a.penalty - b.penalty || a.amplicon.start - b.amplicon.start);
  // Dedupe identical amplicon spans.
  const seen = new Set();
  const unique = [];
  for (const pair of pairs) {
    const key = `${pair.amplicon.start}:${pair.amplicon.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pair);
  }
  return unique.slice(0, opts.maxResults ?? 5);
}

/** Bounds for the designer tool. */
export const DESIGN_DEFAULTS = {
  lenMin: 18,
  lenMax: 28,
  tmMin: 55,
  tmMax: 65,
  gcMin: 40,
  gcMax: 60,
  ampliconMin: 80,
  ampliconMax: 1000,
  requireGcClamp: true,
  maxRun: 3,
  maxSelfScore: 8,
  maxSelfConsecutive: 4,
  maxHairpinScore: 10,
  maxDimerScore: 12,
  maxTmDelta: 3,
  maxResults: 5,
  maxCandidates: 2000,
};

/** Merge user options over the defaults with basic range validation. */
export function resolveDesignOptions(raw) {
  const opts = { ...DESIGN_DEFAULTS };
  for (const key of Object.keys(opts)) {
    if (raw[key] !== undefined && raw[key] !== null) opts[key] = raw[key];
  }
  for (const key of ['minJunctionBases', 'minGenomicSpan']) {
    if (raw[key] !== undefined && raw[key] !== null) opts[key] = raw[key];
  }
  if (!Number.isInteger(opts.lenMin) || opts.lenMin < 12) throw new MolbioInputError('primer_len_min must be an integer >= 12');
  if (!Number.isInteger(opts.lenMax) || opts.lenMax > 40 || opts.lenMax < opts.lenMin) throw new MolbioInputError('primer_len_max must be an integer between primer_len_min and 40');
  if (!(opts.tmMin < opts.tmMax)) throw new MolbioInputError('tm_min must be lower than tm_max');
  if (!(opts.gcMin < opts.gcMax)) throw new MolbioInputError('gc_min must be lower than gc_max');
  if (!(opts.ampliconMin <= opts.ampliconMax) || opts.ampliconMin < 1) throw new MolbioInputError('amplicon_min must be >= 1 and <= amplicon_max');
  if (opts.minJunctionBases !== undefined && (!Number.isInteger(opts.minJunctionBases) || opts.minJunctionBases < 3 || opts.minJunctionBases > 15)) throw new MolbioInputError('min_junction_bases must be an integer between 3 and 15');
  if (opts.minGenomicSpan !== undefined && (!Number.isInteger(opts.minGenomicSpan) || opts.minGenomicSpan < 0)) throw new MolbioInputError('min_genomic_span must be a non-negative integer');
  return opts;
}

/** Full entry point used by the tool: normalize + design. */
export function designPrimers(rawTemplate, rawOptions) {
  const template = normalizeSequence(rawTemplate);
  if (template.length < 24) throw new MolbioInputError(`template is too short for primer design (${template.length} bases; need >= 24)`);
  const opts = resolveDesignOptions(rawOptions);
  const pairs = designPrimerPairs(template, opts);
  return { pairs, opts };
}

// ── cross-intron primer design ──────────────────────────────────────────────

/**
 * Design qPCR primer pairs where the forward primer spans an exon-exon
 * junction (>= min_junction_bases on each side) so genomic DNA cannot be
 * amplified, and the reverse primer sits in a different exon. Coordinates are
 * reported both on the spliced transcript and on the genomic sequence.
 */
export function designIntronSpanningPrimers(genomic, exons, opts) {
  if (!Array.isArray(exons) || exons.length < 2) throw new MolbioInputError('exons must be an array of at least two {start, end} spans');
  const sorted = [...exons].sort((a, b) => a.start - b.start);
  for (const exon of sorted) {
    if (!Number.isInteger(exon.start) || !Number.isInteger(exon.end) || exon.start < 1 || exon.end > genomic.length || exon.start > exon.end) {
      throw new MolbioInputError(`exon ${JSON.stringify(exon)} is outside the genomic sequence (length ${genomic.length})`);
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) throw new MolbioInputError('exons must not overlap');
  }
  const minSide = opts.minJunctionBases ?? 6;
  const minGenomicSpan = opts.minGenomicSpan ?? 0;

  // Build the spliced transcript plus coordinate maps.
  let spliced = '';
  const splicedToGenomic = [];
  const splicedToExon = [];
  const junctionPositions = [];
  sorted.forEach((exon, exonIndex) => {
    if (exonIndex > 0) junctionPositions.push({ splicedPos: spliced.length, up: exonIndex - 1, down: exonIndex });
    for (let g = exon.start - 1; g < exon.end; g++) {
      splicedToGenomic.push(g);
      splicedToExon.push(exonIndex);
      spliced += genomic[g];
    }
  });
  if (spliced.length < 24) throw new MolbioInputError('the spliced transcript is too short for primer design');

  // Forward candidates must span a junction with minSide bases on each side.
  const fwd = [];
  for (const candidate of scanCandidates(spliced, 0, spliced.length - opts.lenMin, opts)) {
    for (const junction of junctionPositions) {
      const left = junction.splicedPos - candidate.start;
      const right = candidate.start + candidate.length - junction.splicedPos;
      if (left >= minSide && right >= minSide) {
        fwd.push({ ...candidate, junction, junction_left: left, junction_right: right });
        break;
      }
    }
  }

  // Reverse candidates sit entirely inside one exon.
  const rev = scanCandidates(spliced, 0, spliced.length - opts.lenMin, opts)
    .filter((candidate) => splicedToExon[candidate.start] === splicedToExon[candidate.start + candidate.length - 1])
    .map((candidate) => ({ ...candidate, exon: splicedToExon[candidate.start] }))
    .sort((a, b) => a.start - b.start);
  const revStarts = rev.map((candidate) => candidate.start);

  const tmCenter = (opts.tmMin + opts.tmMax) / 2;
  const pairs = [];
  for (const f of fwd) {
    const fwdEnd = f.start + f.length - 1;
    const aMin = fwdEnd - opts.ampliconMax + 1;
    const aMax = fwdEnd - opts.ampliconMin + 1;
    let lo = 0;
    let hi = revStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (revStarts[mid] < aMin) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < rev.length; i++) {
      const r = rev[i];
      if (r.start > aMax) break;
      if (r.exon === f.junction.down) continue; // reverse primer must sit in a different exon
      const gEnd = splicedToGenomic[fwdEnd];
      const gStart = splicedToGenomic[r.start];
      if (gEnd - gStart + 1 < minGenomicSpan) continue;
      if (Math.abs(f.tm - r.tm) > opts.maxTmDelta) continue;
      const dimer = dimerPotential(f.sequence, r.sequence);
      if (dimer.score > opts.maxDimerScore) continue;
      const penalty = 0.6 * Math.abs(f.tm - r.tm) + Math.abs(f.tm - tmCenter) + Math.abs(r.tm - tmCenter) + dimer.score / 10;
      pairs.push({
        forward: {
          sequence: f.sequence,
          length: f.length,
          tm: f.tm,
          gc_percent: f.gc_percent,
          spliced_start: f.start + 1,
          spliced_end: f.start + f.length,
          genomic_start: splicedToGenomic[f.start] + 1,
          genomic_end: splicedToGenomic[f.start + f.length - 1] + 1,
          exons: [String(f.junction.up + 1), String(f.junction.down + 1)],
          junction_left: f.junction_left,
          junction_right: f.junction_right,
        },
        reverse: {
          sequence: r.sequence,
          length: r.length,
          tm: r.tm,
          gc_percent: r.gc_percent,
          spliced_start: r.start + 1,
          spliced_end: r.start + r.length,
          genomic_start: splicedToGenomic[r.start] + 1,
          genomic_end: splicedToGenomic[r.start + r.length - 1] + 1,
          exon: r.exon + 1,
        },
        spliced_amplicon: { start: r.start + 1, end: fwdEnd + 1, length: fwdEnd - r.start + 1 },
        genomic_amplicon_length: gEnd - gStart + 1,
        penalty: Math.round(penalty * 100) / 100,
      });
    }
  }
  pairs.sort((a, b) => a.penalty - b.penalty || a.spliced_amplicon.start - b.spliced_amplicon.start);
  const seen = new Set();
  const unique = [];
  for (const pair of pairs) {
    const key = `${pair.spliced_amplicon.start}:${pair.spliced_amplicon.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pair);
  }
  return unique.slice(0, opts.maxResults ?? 5);
}

/** Entry point used by the tool: normalize + validate + design. */
export function designIntronPrimers(rawGenomic, exons, rawOptions) {
  const genomic = normalizeSequence(rawGenomic, 'genomic');
  const opts = resolveDesignOptions(rawOptions);
  const pairs = designIntronSpanningPrimers(genomic, exons, opts);
  return { pairs, opts };
}
