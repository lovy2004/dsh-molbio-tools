/**
 * dsh-molbio-tools/align.mjs
 *
 * Local pairwise alignment (Smith-Waterman) plus an anchor-window heuristic
 * for aligning a short read (Sanger trace) against a long reference. Pure
 * computation; typed arrays keep the matrix scan fast.
 */

import { MolbioInputError } from './lib.mjs';

/**
 * Smith-Waterman local alignment of `a` against `b`.
 * @returns {object} aligned strings, start offsets, identity, and a unified
 *   difference list (kind: mismatch|deletion|insertion; ref positions 1-based
 *   relative to `b`).
 */
export function smithWaterman(a, b, { match = 2, mismatch = -2, gap = -1 } = {}) {
  const m = a.length + 1;
  const n = b.length + 1;
  const H = new Int32Array(m * n);
  const dir = new Uint8Array(m * n); // 1 = diagonal, 2 = up (gap in b), 3 = left (gap in a)
  let best = 0;
  let bestI = 0;
  let bestJ = 0;
  for (let i = 1; i < m; i++) {
    const ai = a.charCodeAt(i - 1);
    const rowBase = i * n;
    for (let j = 1; j < n; j++) {
      const idx = rowBase + j;
      const diag = H[idx - n - 1] + (ai === b.charCodeAt(j - 1) ? match : mismatch);
      const up = H[idx - n] + gap;
      const left = H[idx - 1] + gap;
      let h = 0;
      let d = 0;
      if (diag >= up && diag >= left) {
        if (diag > 0) {
          h = diag;
          d = 1;
        }
      } else if (up >= left) {
        if (up > 0) {
          h = up;
          d = 2;
        }
      } else if (left > 0) {
        h = left;
        d = 3;
      }
      H[idx] = h;
      dir[idx] = d;
      if (h > best) {
        best = h;
        bestI = i;
        bestJ = j;
      }
    }
  }
  if (best === 0) throw new MolbioInputError('no significant local alignment found');
  let i = bestI;
  let j = bestJ;
  let aOut = '';
  let bOut = '';
  const differences = [];
  const endI = bestI;
  const endJ = bestJ;
  while (i > 0 && j > 0 && H[i * n + j] > 0) {
    const d = dir[i * n + j];
    const aIdx = i - 1;
    const bIdx = j - 1;
    if (d === 1) {
      aOut = a[aIdx] + aOut;
      bOut = b[bIdx] + bOut;
      if (a[aIdx] !== b[bIdx]) {
        differences.push({
          kind: 'mismatch',
          ref_pos: bIdx + 1,
          ref_base: b[bIdx],
          trace_base: a[aIdx],
          trace_pos: aIdx + 1,
        });
      }
      i--;
      j--;
    } else if (d === 2) {
      // consume a base of `a` with a gap in `b` → extra base in the trace
      aOut = a[aIdx] + aOut;
      bOut = '-' + bOut;
      differences.push({
        kind: 'insertion',
        ref_pos: bIdx + 1,
        ref_base: '-',
        trace_base: a[aIdx],
        trace_pos: aIdx + 1,
      });
      i--;
    } else {
      // consume a base of `b` with a gap in `a` → base missing from the trace
      aOut = '-' + aOut;
      bOut = b[bIdx] + bOut;
      differences.push({
        kind: 'deletion',
        ref_pos: bIdx + 1,
        ref_base: b[bIdx],
        trace_base: '-',
        trace_pos: aIdx + 1,
      });
      j--;
    }
  }
  let matches = 0;
  for (let k = 0; k < aOut.length; k++) if (aOut[k] === bOut[k]) matches++;
  differences.sort((x, y) => (x.trace_pos ?? 0) - (y.trace_pos ?? 0));
  return {
    a_aligned: aOut,
    b_aligned: bOut,
    a_start: i, // 0-based start of the aligned region in a
    b_start: j, // 0-based start of the aligned region in b
    a_end: endI, // 0-based exclusive end in a
    b_end: endJ, // 0-based exclusive end in b
    score: best,
    identity_percent: aOut.length === 0 ? 0 : Math.round((matches / aOut.length) * 10000) / 100,
    aligned_columns: aOut.length,
    differences,
  };
}

/**
 * Find an exact 21-mer anchor of `trace` inside `reference` and return a
 * window around it; falls back to the whole reference. Keeps alignment fast
 * for kb-scale references.
 */
export function anchorWindow(trace, reference, { k = 21, window = 600 } = {}) {
  if (trace.length < k) return { start: 0, end: reference.length, found: false, offset: 0 };
  const probes = [];
  for (const frac of [0.5, 0.3, 0.7, 0.2, 0.8]) {
    const start = Math.floor(trace.length * frac);
    if (start + k <= trace.length) probes.push(trace.slice(start, start + k));
  }
  for (const probe of probes) {
    const idx = reference.indexOf(probe);
    if (idx !== -1) {
      return {
        start: Math.max(0, idx - window),
        end: Math.min(reference.length, idx + k + window),
        found: true,
        offset: Math.max(0, idx - window),
        anchor: idx,
      };
    }
  }
  return { start: 0, end: reference.length, found: false, offset: 0 };
}

/**
 * Align a short read against a possibly circular reference. The reference is
 * doubled so reads spanning the origin align correctly; reported positions
 * are mapped back onto the original coordinates (1-based).
 */
export function alignToReference(trace, reference, circular = false) {
  const effective = circular ? reference + reference : reference;
  const window = anchorWindow(trace, effective);
  const slice = effective.slice(window.start, window.end);
  const result = smithWaterman(trace, slice);
  const offset = window.offset;
  const differences = result.differences.map((difference) => ({
    ...difference,
    ref_pos: circular ? ((difference.ref_pos + offset - 1) % reference.length) + 1 : difference.ref_pos + offset,
  }));
  differences.sort((x, y) => x.ref_pos - y.ref_pos);
  return {
    ...result,
    b_start: result.b_start + offset,
    b_end: result.b_end + offset,
    differences,
    reference_length: reference.length,
  };
}
