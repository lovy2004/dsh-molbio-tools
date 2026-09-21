/**
 * dsh-molbio-tools/phylo.mjs
 *
 * Distance-based phylogenetics from an alignment: corrected distances,
 * UPGMA / neighbour-joining trees, bootstrap support, consensus trees, Newick
 * I/O and SVG rendering.
 *
 * SCOPE, STATED PLAINLY
 * ---------------------
 * This is a DISTANCE method (phenetic / minimum-evolution style). It is NOT a
 * maximum-likelihood search: no substitution-rate matrix is optimised, no
 * topology space is explored, and bootstrap percentages are NOT p-values. The
 * tool output says all of that, and the package README lists ML/Bayesian trees
 * among the things this toolset deliberately does not do.
 *
 * DISTANCE CORRECTIONS AND THEIR EDGES
 * ------------------------------------
 * Every model here divides by (1 − something). When the observed difference is
 * large enough that the correction has no solution (saturation), the distance
 * is UNDEFINED in the model; returning a huge number silently would corrupt the
 * tree, and throwing would refuse work a user legitimately wants. So the pair
 * is reported in `saturated_pairs` and its distance is clamped to the model's
 * limit, which is exactly what `dist.dna`-style tools do with a warning.
 *
 * The k-mer distance used to place sequences before alignment is deliberately
 * the SAME formula `msa.mjs` uses for its guide tree (feature-count MinHash
 * style, `k = MSA_SCORING.kmerK`); `test/smoke.mjs` asserts the two agree on a
 * real fixture, so one cannot drift away from the other unnoticed.
 */

import { CODON_TABLE_BY_NAME } from './lib.mjs';
import { MSA_SCORING } from './msa.mjs';
import { MolbioInputError } from './lib.mjs';
import { panel, rect, series, svgDocument, textRun, textSpanLines, wrapTextLines, line as svgLine, circle as svgCircle, escapeXml, round } from './svgio.mjs';

/** Safety limits, exported so tools and tests share one source. */
export const PHYLO_LIMITS = {
  max_sequences: 200,
  max_alignment_length: 20000,
  max_bootstrap: 1000,
  /** Work budget for bootstrap = replicates x pairs x columns. */
  max_bootstrap_work: 10_000_000,
};

export const DISTANCE_MODELS = ['p-distance', 'jukes-cantor', 'kimura-2p', 'tn93'];
export const TREE_METHODS = ['upgma', 'nj'];
export const LAYOUTS = ['rectangular', 'circular', 'fan'];

/** True for a residue that is one of the four unambiguous DNA bases. */
function isPlainBase(base) {
  return base === 'A' || base === 'C' || base === 'G' || base === 'T';
}

/** A purine (A/G) or pyrimidine (C/T), or undefined for anything else. */
function purineOf(base) {
  if (base === 'A' || base === 'G') return 'R';
  if (base === 'C' || base === 'T') return 'Y';
  return undefined;
}

/**
 * Pairwise distances over an alignment.
 *
 * Sites where either sequence carries a gap or an ambiguous base are SKIPPED
 * per pair (complete deletion is not applied globally, which keeps short
 * sequences usable), and `compared_sites` records how many sites actually
 * informed each pair so a distance built on 4 sites is visible as such.
 *
 * @returns {{matrix: number[][], compared: number[][], saturated: Array<object>, model: string}}
 */
export function distanceMatrix(rows, { model = 'jukes-cantor' } = {}) {
  if (!DISTANCE_MODELS.includes(model)) {
    throw new MolbioInputError(`unknown distance model ${JSON.stringify(model)}; available: ${DISTANCE_MODELS.join(', ')}`);
  }
  if (!Array.isArray(rows) || rows.length < 2) throw new MolbioInputError('phylogenetics needs at least 2 sequences');
  const length = rows[0].sequence.length;
  for (const row of rows) {
    if (row.sequence.length !== length) {
      throw new MolbioInputError(`all rows must be aligned to the same length (${rows[0].id} is ${length}, ${row.id} is ${row.sequence.length}); align them first (molbio_msa_align)`);
    }
  }
  const n = rows.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const compared = Array.from({ length: n }, () => new Array(n).fill(0));
  const saturated = [];

  // Base composition, needed by TN93 (and reported by the caller).
  const frequency = { A: 0, C: 0, G: 0, T: 0 };
  let observedBases = 0;
  for (const row of rows) {
    for (const base of row.sequence) {
      if (!isPlainBase(base)) continue;
      frequency[base]++;
      observedBases++;
    }
  }
  const composition = observedBases === 0
    ? { A: 0.25, C: 0.25, G: 0.25, T: 0.25 }
    : { A: frequency.A / observedBases, C: frequency.C / observedBases, G: frequency.G / observedBases, T: frequency.T / observedBases };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sites = 0;
      let differences = 0;
      let transitions = 0;
      let transversions = 0;
      // TN93 needs the two transition classes separately.
      let cToT = 0;
      let aToG = 0;
      const left = rows[i].sequence;
      const right = rows[j].sequence;
      for (let position = 0; position < length; position++) {
        const a = left[position];
        const b = right[position];
        if (!isPlainBase(a) || !isPlainBase(b)) continue;
        sites++;
        if (a === b) continue;
        differences++;
        const purineA = purineOf(a);
        const purineB = purineOf(b);
        if (purineA === purineB) {
          transitions++;
          if ((a === 'C' && b === 'T') || (a === 'T' && b === 'C')) cToT++;
          else aToG++;
        } else {
          transversions++;
        }
      }
      compared[i][j] = sites;
      compared[j][i] = sites;
      if (sites === 0) {
        matrix[i][j] = 0;
        matrix[j][i] = 0;
        saturated.push({ pair: [rows[i].id, rows[j].id], reason: 'the two sequences share no comparable site (gaps or ambiguous bases everywhere)' });
        continue;
      }
      const p = differences / sites;
      const q = transversions / sites;
      const transitionRate = transitions / sites;
      let distance;
      let limit;
      let reason = '';
      if (model === 'p-distance') {
        distance = p;
        limit = 1;
        if (p >= 1) reason = 'every comparable site differs';
      } else if (model === 'jukes-cantor') {
        limit = 0.75;
        const inner = 1 - (4 / 3) * p;
        if (inner <= 0) {
          distance = limit;
          reason = `p-distance ${round(p, 4)} is at or beyond the Jukes-Cantor limit 0.75`;
        } else {
          distance = (-3 / 4) * Math.log(inner);
        }
      } else if (model === 'kimura-2p') {
        limit = 1;
        const first = 1 - 2 * transitionRate - q;
        const second = 1 - 2 * q;
        if (first <= 0 || second <= 0) {
          distance = 1;
          reason = `the K2P arguments (${round(first, 4)}, ${round(second, 4)}) are not both positive`;
        } else {
          distance = (-1 / 2) * Math.log(first) - (1 / 4) * Math.log(second);
        }
      } else {
        // Tamura-Nei 1993: the two transition classes are separated (C<->T and
        // A<->G) and the equilibrium base composition enters the coefficients.
        const gR = composition.A + composition.G;
        const gY = composition.C + composition.T;
        const gT = composition.T;
        const gC = composition.C;
        const gA = composition.A;
        const gG = composition.G;
        // The transition probabilities P1 (C<->T) and P2 (A<->G) are broken out
        // of the overall difference p: P1 + P2 + Q = p, with Q the transversions.
        const p1 = cToT / sites;
        const p2 = aToG / sites;
        const coefficient1 = 1 - (p1 / (2 * gY)) - (((gR - gY) / (2 * gR * gY)) * p);
        const coefficient2 = 1 - (p2 / (2 * gR)) - (((gY - gR) / (2 * gR * gY)) * p);
        const coefficient3 = 1 - (p / (2 * gR * gY));
        if (coefficient1 <= 0 || coefficient2 <= 0 || coefficient3 <= 0) {
          distance = 1;
          reason = 'the Tamura-Nei coefficients are not all positive';
        } else {
          distance = -2 * gR * gY * Math.log(coefficient3)
            + 2 * gA * gG * Math.log(coefficient2) / gR
            + 2 * gT * gC * Math.log(coefficient1) / gY;
        }
      }
      if (!Number.isFinite(distance)) {
        distance = limit ?? 1;
        reason = reason === '' ? 'the correction did not produce a finite value' : reason;
      }
      if (reason !== '') saturated.push({ pair: [rows[i].id, rows[j].id], reason, clipped_to: round(distance, 4) });
      matrix[i][j] = Math.max(0, distance);
      matrix[j][i] = Math.max(0, distance);
    }
  }
  return { matrix, compared, saturated, model, composition };
}

/**
 * The k-mer distance `msa.mjs` uses to order sequences before alignment,
 * reproduced exactly (feature-count overlap, k = MSA_SCORING.kmerK). Exposed
 * here so the phylogenetic tree can be built from UNALIGNED sequences and so
 * the test suite can assert the two implementations agree.
 */
export function kmerDistanceMatrix(rows, k = MSA_SCORING.kmerK) {
  const n = rows.length;
  const profiles = rows.map((row) => {
    const map = new Map();
    const width = Math.min(k, row.sequence.length);
    for (let index = 0; index + width <= row.sequence.length; index++) {
      const mer = row.sequence.slice(index, index + width);
      map.set(mer, (map.get(mer) ?? 0) + 1);
    }
    return { map, total: row.sequence.length - width + 1 };
  });
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [small, big] = profiles[i].total <= profiles[j].total ? [profiles[i], profiles[j]] : [profiles[j], profiles[i]];
      let shared = 0;
      for (const [mer, count] of small.map) shared += Math.min(count, big.map.get(mer) ?? 0);
      const value = 1 - (2 * shared) / (profiles[i].total + profiles[j].total);
      dist[i * n + j] = value;
      dist[j * n + i] = value;
    }
  }
  return dist;
}

/** One tree node. Leaves carry a name; every node carries a branch length. */
function leaf(index, name) {
  return { name, children: [], length: 0, support: undefined, leafIndex: index };
}

/**
 * UPGMA (average linkage, assumes a molecular clock).
 * `dist` is a flat n x n Float64Array and is CONSUMED (as in msa.mjs).
 */
export function upgmaTree(dist, names) {
  const n = Math.round(Math.sqrt(dist.length));
  const size = new Array(n).fill(1);
  const active = Array.from({ length: n }, (_, index) => index);
  const nodes = new Map(active.map((index) => [index, leaf(index, names[index])]));
  const height = new Map(active.map((index) => [index, 0]));
  while (active.length > 1) {
    let bestI = 0;
    let bestJ = 1;
    let best = Infinity;
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const value = dist[active[x] * n + active[y]];
        if (value < best) {
          best = value;
          bestI = x;
          bestJ = y;
        }
      }
    }
    const i = active[bestI];
    const j = active[bestJ];
    const clusterHeight = dist[i * n + j] / 2;
    const left = nodes.get(i);
    const right = nodes.get(j);
    left.length = Math.max(0, clusterHeight - height.get(i));
    right.length = Math.max(0, clusterHeight - height.get(j));
    const node = { name: '', children: [left, right], length: 0, support: undefined };
    for (const k of active) {
      if (k === i || k === j) continue;
      const value = (size[i] * dist[i * n + k] + size[j] * dist[j * n + k]) / (size[i] + size[j]);
      dist[i * n + k] = value;
      dist[k * n + i] = value;
    }
    size[i] += size[j];
    active.splice(bestJ, 1);
    nodes.set(i, node);
    height.set(i, clusterHeight);
  }
  return nodes.get(active[0]);
}

/**
 * Neighbour-joining (Saitou & Nei 1987), no clock assumption.
 * Returns a tree whose leaves carry branch lengths and whose root is the last
 * join point (an unrooted tree drawn as rooted).
 */
export function neighbourJoiningTree(matrix, names) {
  const n = names.length;
  const dist = matrix.map((row) => row.slice());
  const active = Array.from({ length: n }, (_, index) => index);
  const nodes = new Map(active.map((index) => [index, leaf(index, names[index])]));
  while (active.length > 2) {
    const count = active.length;
    const rowSums = new Map();
    for (const i of active) {
      let sum = 0;
      for (const j of active) sum += dist[i][j];
      rowSums.set(i, sum);
    }
    let bestI = active[0];
    let bestJ = active[1];
    let best = Infinity;
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const i = active[x];
        const j = active[y];
        const q = (count - 2) * dist[i][j] - rowSums.get(i) - rowSums.get(j);
        if (q < best) {
          best = q;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const i = bestI;
    const j = bestJ;
    const limbI = 0.5 * dist[i][j] + (rowSums.get(i) - rowSums.get(j)) / (2 * (count - 2));
    const limbJ = dist[i][j] - limbI;
    const left = nodes.get(i);
    const right = nodes.get(j);
    left.length = Math.max(0, limbI);
    right.length = Math.max(0, limbJ);
    const node = { name: '', children: [left, right], length: 0, support: undefined };
    // Distance from the new node to every remaining node.
    const merged = new Array(n).fill(0);
    for (const k of active) {
      if (k === i || k === j) continue;
      merged[k] = 0.5 * (dist[i][k] + dist[j][k] - dist[i][j]);
    }
    for (const k of active) {
      if (k === i || k === j) continue;
      dist[i][k] = merged[k];
      dist[k][i] = merged[k];
    }
    active.splice(active.indexOf(j), 1);
    nodes.set(i, node);
  }
  // Three (or two) lineages left: join them under one root.
  const left = nodes.get(active[0]);
  const right = nodes.get(active[1]);
  const lastDistance = dist[active[0]][active[1]];
  if (active.length === 2) {
    left.length = Math.max(0, lastDistance / 2);
    right.length = Math.max(0, lastDistance / 2);
    return { name: '', children: [left, right], length: 0, support: undefined };
  }
  const third = nodes.get(active[2]);
  const limbLeft = Math.max(0, (dist[active[0]][active[1]] + dist[active[0]][active[2]] - dist[active[1]][active[2]]) / 2);
  const limbRight = Math.max(0, (dist[active[0]][active[1]] + dist[active[1]][active[2]] - dist[active[0]][active[2]]) / 2);
  const limbThird = Math.max(0, (dist[active[0]][active[2]] + dist[active[1]][active[2]] - dist[active[0]][active[1]]) / 2);
  left.length = limbLeft;
  right.length = limbRight;
  third.length = limbThird;
  const root = { name: '', children: [left, right, third], length: 0, support: undefined };
  return root;
}

/**
 * Rows whose alignment kept fewer residues than the caller supplied, as
 * `"<id> (<kept> of <supplied> bases kept)"` strings (empty when every residue
 * was placed).
 *
 * WHY THIS GUARD EXISTS: building a tree from an alignment that quietly dropped
 * residues means building it from data the user never supplied — the worst kind
 * of silent error in phylogenetics. It was written in v19, when the progressive
 * aligner really could lose an unplaceable trailing residue (11 bp vs 10 bp
 * returned 10 columns). v20 fixed the aligner's trailing overhang, so the guard
 * should now stay silent on real output; it is kept because it is the thing
 * that would catch a FUTURE regression, and its own test drives it with a
 * deliberately damaged row (a guard nobody has seen fail is not a guard).
 *
 * @param {Array<{id: string, sequence: string}>} rows - aligned rows.
 * @param {Array<{sequence: string}>} entries - the supplied sequences.
 * @returns {string[]} one entry per short row.
 */
export function coverageShortfall(rows, entries) {
  const short = [];
  rows.forEach((row, index) => {
    const kept = [...String(row.sequence)].filter((base) => base !== '-').length;
    const supplied = String(entries[index]?.sequence ?? '').length;
    if (kept !== supplied) short.push(`${row.id} (${kept} of ${supplied} bases kept)`);
  });
  return short;
}

/** Every leaf of a tree, in left-to-right order. */
export function leavesOf(tree) {
  const out = [];
  const walk = (node) => {
    if (node.children.length === 0) {
      out.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

/** Every node of a tree (pre-order). */
export function nodesOf(tree) {
  const out = [];
  const walk = (node) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

/**
 * Newick text for a tree. Internal labels carry bootstrap support when the
 * nodes have it (`support`), which is the conventional way to write a tree
 * with support values.
 */
export function toNewick(tree, { includeSupport = true, precision = 6 } = {}) {
  const nameOf = (name) => (/^[A-Za-z0-9_.\-]+$/.test(name) ? name : `'${String(name).replace(/'/g, '\'\'')}'`);
  const number = (value) => {
    const rounded = Number(value.toFixed(precision));
    return String(rounded);
  };
  const render = (node) => {
    // A leaf is just its label; only internal nodes get parentheses. The caller
    // strips the ROOT's branch length afterwards: a length on the root is
    // meaningless in Newick and upstream parsers disagree about how to read it.
    if (node.children.length === 0) return `${nameOf(node.name)}:${number(node.length)}`;
    const children = node.children.map(render).join(',');
    const label = includeSupport && Number.isFinite(node.support) ? number(node.support) : '';
    return `(${children})${label}:${number(node.length)}`;
  };
  const rendered = render(tree);
  // Only strip the root's OWN trailing `:length`, and only at depth 0.
  return `${rendered.replace(/:[\d.eE+-]+$/, '')};`;
}

/**
 * Parse Newick text back into a tree. Tolerates quoted labels, whitespace,
 * scientific notation and the trailing semicolon.
 */
export function parseNewick(text) {
  const source = String(text);
  let index = 0;
  const skip = () => {
    while (index < source.length && /\s/.test(source[index])) index++;
  };
  const readLabel = () => {
    skip();
    if (source[index] === '\'') {
      index++;
      let out = '';
      while (index < source.length) {
        if (source[index] === '\'' && source[index + 1] === '\'') {
          out += '\'';
          index += 2;
          continue;
        }
        if (source[index] === '\'') {
          index++;
          break;
        }
        out += source[index++];
      }
      return out;
    }
    let out = '';
    while (index < source.length && !/[,():;]/.test(source[index])) out += source[index++];
    return out.trim();
  };
  const readLength = () => {
    skip();
    if (source[index] !== ':') return 0;
    index++;
    let out = '';
    while (index < source.length && !/[,();]/.test(source[index])) out += source[index++];
    const value = Number(out.trim());
    if (!Number.isFinite(value)) throw new MolbioInputError(`invalid branch length ${JSON.stringify(out.trim())} in Newick at offset ${index}`);
    return value;
  };
  const parseNode = () => {
    skip();
    if (index >= source.length) throw new MolbioInputError('unexpected end of Newick text');
    let node;
    if (source[index] === '(') {
      index++;
      const children = [];
      for (;;) {
        children.push(parseNode());
        skip();
        if (source[index] === ',') {
          index++;
          continue;
        }
        if (source[index] === ')') {
          index++;
          break;
        }
        throw new MolbioInputError(`expected "," or ")" at offset ${index} in Newick text`);
      }
      const label = readLabel();
      const support = label === '' ? undefined : Number(label);
      node = { name: '', children, length: 0, support: Number.isFinite(support) ? support : undefined };
      if (label !== '' && !Number.isFinite(support)) node.name = label;
    } else {
      const label = readLabel();
      if (label === '') throw new MolbioInputError(`empty leaf label at offset ${index} in Newick text`);
      node = { name: label, children: [], length: 0, support: undefined };
    }
    node.length = readLength();
    return node;
  };
  const tree = parseNode();
  skip();
  if (source[index] === ';') index++;
  skip();
  if (index < source.length) throw new MolbioInputError(`unexpected trailing text in Newick at offset ${index}`);
  return tree;
}

/** The set of leaf names below each clade, as a canonical string key. */
function cladeKey(node) {
  return leavesOf(node).map((leafNode) => leafNode.name).sort().join('\u0000');
}

/**
 * Bootstrap support: resample alignment columns with replacement, rebuild the
 * tree `replicates` times, and count how often each clade of `tree` appears.
 * `seed` is explicit so the whole procedure is reproducible.
 *
 * @returns {{support: Map<string, number>, replicates: number, seed: number, consensus: object}}
 */
export function bootstrapSupport(rows, tree, { method = 'nj', model = 'jukes-cantor', replicates = 100, seed = 1 } = {}) {
  if (!Number.isInteger(replicates) || replicates < 1) throw new MolbioInputError('replicates must be a positive integer');
  if (replicates > PHYLO_LIMITS.max_bootstrap) throw new MolbioInputError(`at most ${PHYLO_LIMITS.max_bootstrap} bootstrap replicates are supported (asked for ${replicates})`);
  const length = rows[0].sequence.length;
  const names = rows.map((row) => row.id);
  // The budget counts the real cost of one replicate: n^2 pair distances over
  // `length` columns, rebuilt from scratch every time.
  const work = replicates * names.length ** 2 * length;
  if (work > PHYLO_LIMITS.max_bootstrap_work) {
    throw new MolbioInputError(`bootstrap budget exceeded: ${replicates} replicates x ${names.length} sequences x ${length} columns is ${work} operations (limit ${PHYLO_LIMITS.max_bootstrap_work}); use fewer replicates, fewer sequences, or a shorter alignment`);
  }
  const counts = new Map();
  let state = seed >>> 0;
  const random = () => {
    // Deterministic xorshift32: the same seed must give the same tree.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  // Enumerate the clades of the reference tree that bootstrap can support:
  // every proper clade (a leaf is always present, the root always too).
  const referenceClades = new Set();
  const collect = (node) => {
    if (node.children.length > 0) referenceClades.add(cladeKey(node));
    for (const child of node.children) collect(child);
  };
  collect(tree);
  const replicateTrees = [];
  for (let replicate = 0; replicate < replicates; replicate++) {
    const columns = new Array(length);
    for (let position = 0; position < length; position++) columns[position] = Math.floor(random() * length);
    const resampled = rows.map((row) => {
      let sequence = '';
      for (const column of columns) sequence += row.sequence[column];
      return { id: row.id, sequence };
    });
    const resampledTree = buildTree(resampled, { method, model });
    replicateTrees.push(resampledTree);
    const seen = new Set();
    const visit = (node) => {
      if (node.children.length > 0) {
        const key = cladeKey(node);
        if (!seen.has(key)) {
          seen.add(key);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      for (const child of node.children) visit(child);
    };
    visit(resampledTree);
  }
  const support = new Map();
  for (const key of referenceClades) support.set(key, Math.round(((counts.get(key) ?? 0) / replicates) * 1000) / 10);
  return { support, replicates, seed, replicateTrees };
}

/** Annotate a tree's internal nodes with bootstrap support (percent). */
export function applySupport(tree, support) {
  const walk = (node) => {
    if (node.children.length > 0) {
      const value = support.get(cladeKey(node));
      node.support = value === undefined ? 0 : value;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return tree;
}

/**
 * Consensus of a set of replicate trees. `strict` keeps only clades present in
 * every replicate; `majority` keeps clades above the threshold (default 50%)
 * that do not conflict with a better-supported one; `greedy` keeps every
 * non-conflicting clade above the threshold in descending support order.
 */
export function consensusTree(rows, replicateTrees, { mode = 'majority', threshold = 0.5 } = {}) {
  const names = rows.map((row) => row.id);
  const counts = new Map();
  const cladeLeaves = new Map();
  for (const tree of replicateTrees) {
    const seen = new Set();
    for (const node of nodesOf(tree)) {
      if (node.children.length === 0) continue;
      const key = cladeKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!cladeLeaves.has(key)) cladeLeaves.set(key, leavesOf(node).map((leafNode) => leafNode.name));
    }
  }
  const total = replicateTrees.length;
  const required = mode === 'strict' ? total : threshold * total;
  const accepted = [...counts.entries()]
    .filter(([, count]) => count >= required)
    .map(([key, count]) => ({ key, count, names: cladeLeaves.get(key) }))
    .filter((entry) => entry.names.length > 1 && entry.names.length < names.length)
    .sort((a, b) => b.names.length - a.names.length || b.count - a.count);

  // Build the tree by repeatedly merging the accepted clades, skipping any
  // clade that crosses an already-built group (that is the "conflict" rule).
  let groups = names.map((name) => ({ names: [name], node: { name, children: [], length: 0, support: undefined } }));
  for (const entry of accepted) {
    const inside = groups.filter((group) => group.names.every((name) => entry.names.includes(name)));
    if (inside.length < 2) continue;
    const outside = groups.filter((group) => group.names.some((name) => entry.names.includes(name)) && !inside.includes(group));
    if (outside.length > 0) continue;
    const merged = {
      names: inside.flatMap((group) => group.names),
      node: { name: '', children: inside.map((group) => group.node), length: 0, support: Math.round((entry.count / total) * 1000) / 10 },
    };
    groups = groups.filter((group) => !inside.includes(group));
    groups.push(merged);
  }
  // Anything left unresolved becomes a polytomy under the root.
  const root = groups.length === 1
    ? groups[0].node
    : { name: '', children: groups.map((group) => group.node), length: 0, support: undefined };
  return { tree: root, clades: accepted.length, mode, threshold };
}

/** Build a tree from aligned rows (or unaligned rows via the k-mer distance). */
export function buildTree(rows, { method = 'nj', model = 'jukes-cantor', unaligned = false } = {}) {
  if (!TREE_METHODS.includes(method)) throw new MolbioInputError(`unknown tree method ${JSON.stringify(method)}; available: ${TREE_METHODS.join(', ')}`);
  if (rows.length > PHYLO_LIMITS.max_sequences) {
    throw new MolbioInputError(`at most ${PHYLO_LIMITS.max_sequences} sequences per tree (got ${rows.length})`);
  }
  const longest = Math.max(...rows.map((row) => row.sequence.length));
  if (longest > PHYLO_LIMITS.max_alignment_length) {
    throw new MolbioInputError(`alignment length ${longest} exceeds the supported ${PHYLO_LIMITS.max_alignment_length} columns`);
  }
  const names = rows.map((row) => row.id);
  if (unaligned) {
    const dist = kmerDistanceMatrix(rows);
    return upgmaTree(dist, names);
  }
  const { matrix, compared, saturated } = distanceMatrix(rows, { model });
  const tree = method === 'upgma'
    ? upgmaTree(flatFrom(matrix), names)
    : neighbourJoiningTree(matrix, names);
  return { ...tree, compared, saturated, matrix };
}

/** A plain n x n matrix as the flat Float64Array upgmaTree consumes. */
function flatFrom(matrix) {
  const n = matrix.length;
  const flat = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) flat[i * n + j] = matrix[i][j];
  }
  return flat;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Cumulative distance from the root to each node. */
function depths(tree) {
  const map = new Map();
  const walk = (node, depth) => {
    const value = depth + (node.length ?? 0);
    map.set(node, value);
    for (const child of node.children) walk(child, value);
  };
  walk(tree, 0);
  return map;
}

/**
 * SVG for a tree. Three layouts, all drawn inside a panel so the picture says
 * what it is:
 *   - `rectangular`: classic right-angle phylogram (branch lengths on x),
 *   - `circular`: radial phylogram (equal angles per leaf, radius = distance),
 *   - `fan`: equal-angle unrooted-style fan (topology only, lengths ignored).
 * A scale bar is drawn whenever the layout uses branch lengths.
 */
export function renderTreeSvg(tree, {
  layout = 'rectangular',
  title = 'Phylogenetic tree',
  subtitle = '',
  width = 780,
  height = 620,
  scaleBar = true,
  showSupport = true,
  supportThreshold = 0,
  leafFontSize = 11,
} = {}) {
  if (!LAYOUTS.includes(layout)) throw new MolbioInputError(`unknown layout ${JSON.stringify(layout)}; available: ${LAYOUTS.join(', ')}`);
  const leaves = leavesOf(tree);
  if (leaves.length < 2) throw new MolbioInputError('a tree needs at least two leaves to draw');
  const depthMap = depths(tree);
  const maxDepth = Math.max(...[...depthMap.values()], 1e-9);
  const frame = panel({ x: 12, y: 12, width: width - 24, height: height - 24, title, subtitle, inset: { top: 44, right: 20, bottom: 34, left: 20 } });
  const plot = frame.plot;
  const parts = [frame.markup];
  const labelLength = Math.max(...leaves.map((leafNode) => leafNode.name.length));

  if (layout === 'rectangular') {
    // Long leaf names are WRAPPED onto <tspan> lines instead of being drawn
    // straight through their neighbours (v19's failure: the label ran into the
    // row above it). The label column gets a fixed share of the panel, and the
    // font shrinks only when even that share cannot hold every leaf's label in
    // a readable number of lines.
    const labelBudget = Math.max(90, plot.width * 0.4);
    const minimumLeafFont = 5;
    let size = leafFontSize;
    let layoutOf = null;
    for (;;) {
      layoutOf = new Map(leaves.map((leafNode) => [leafNode, wrapTextLines(leafNode.name, labelBudget, size)]));
      const tallest = Math.max(...[...layoutOf.values()].map((block) => block.height), size * 1.2);
      // One line per leaf must fit the row pitch for the drawing to be legible.
      if (tallest <= (plot.height / leaves.length) * 1.05 || size <= minimumLeafFont) break;
      size = Math.max(minimumLeafFont, size - 0.5);
    }
    const labelWidth = Math.max(...[...layoutOf.values()].map((block) => block.width));
    const xOf = (node) => plot.x + (depthMap.get(node) / maxDepth) * (plot.width - labelWidth - 8);
    const step = plot.height / leaves.length;
    const yOf = new Map();
    leaves.forEach((leafNode, index) => yOf.set(leafNode, plot.y + step * (index + 0.5)));
    const place = (node) => {
      if (node.children.length === 0) return;
      for (const child of node.children) {
        place(child);
        if (child.children.length > 0) {
          const first = leavesOf(child)[0];
          const last = leavesOf(child)[leavesOf(child).length - 1];
          yOf.set(child, (yOf.get(first) + yOf.get(last)) / 2);
        }
      }
    };
    place(tree);
    const draw = (node) => {
      const y = yOf.get(node);
      if (node.children.length > 0) {
        const childYs = node.children.map((child) => yOf.get(child));
        parts.push(svgLine({ x1: xOf(node), y1: Math.min(...childYs), x2: xOf(node), y2: Math.max(...childYs), stroke: '#57606a', width: 1 }));
        if (showSupport && Number.isFinite(node.support)) {
          const dashed = node.support < supportThreshold;
          parts.push(textRun({ x: xOf(node) + 2, y: y - 3, text: String(node.support), size: 9, fill: dashed ? '#d1242f' : '#57606a' }));
        }
      }
      for (const child of node.children) {
        parts.push(svgLine({
          x1: xOf(node), y1: yOf.get(child), x2: xOf(child), y2: yOf.get(child),
          stroke: '#24292f', width: 1.4,
          dash: showSupport && Number.isFinite(child.support) && child.support < supportThreshold ? [4, 3] : undefined,
        }));
        draw(child);
      }
      if (node.children.length === 0) {
        const block = layoutOf.get(node);
        parts.push(textSpanLines({
          x: xOf(node) + 5,
          // Centre the block on the leaf's row, then place the first baseline
          // so a single-line label sits exactly where `y + 4` used to.
          y: y + 4 - (block.height - block.step) / 2,
          lines: block.lines,
          size,
          fill: '#24292f',
        }));
      }
    };
    draw(tree);
    if (scaleBar) parts.push(scaleBarMarkup(plot, maxDepth, xOf, plot.y + plot.height - 6));
  } else {
    // Radial layouts: equal angle per leaf, radius from cumulative distance
    // (circular) or from node depth only (fan).
    //
    // The radius is a LINEAR SCALE over the observed depth range rather than a
    // fraction of the maximum: real distances are often ~0.01, and `depth/max`
    // would then collapse the whole tree into the centre. Scaling to fill the
    // panel means the drawing is always readable, and the scale bar carries the
    // real units, exactly as in the rectangular layout.
    const centre = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 };
    const headroom = labelLength * leafFontSize * 0.62 + 8;
    const radius = Math.min(plot.width, plot.height) / 2 - headroom;
    const angleOf = new Map();
    leaves.forEach((leafNode, index) => angleOf.set(leafNode, (index / leaves.length) * Math.PI * 2 - Math.PI / 2));
    const place = (node) => {
      if (node.children.length === 0) return;
      for (const child of node.children) place(child);
      const values = node.children.map((child) => angleOf.get(child));
      angleOf.set(node, values.reduce((sum, value) => sum + value, 0) / values.length);
    };
    place(tree);
    // Subtree leaf counts are still useful for the support-label placement.
    const countOf = new Map();
    const countLeaves = (node) => {
      const value = node.children.length === 0 ? 1 : node.children.reduce((sum, child) => sum + countLeaves(child), 0);
      countOf.set(node, value);
      return value;
    };
    countLeaves(tree);
    // A cladogram fan: every taxon sits on the same arc (equal angle per leaf)
    // and only the TOPOLOGY is shown, which is the honest thing for an
    // equal-angle drawing — a log-scaled radius would imply a distance
    // relationship that the layout does not actually encode.
    const radiusOf = (node) => (layout === 'circular' ? 2 + (depthMap.get(node) / maxDepth) * (radius - 2) : radius);
    const pointOf = (node) => {
      const angle = angleOf.get(node);
      const r = radiusOf(node);
      return [centre.x + Math.cos(angle) * r, centre.y + Math.sin(angle) * r];
    };
    const draw = (node) => {
      const [x, y] = pointOf(node);
      for (const child of node.children) {
        const [childX, childY] = pointOf(child);
        const lowSupport = showSupport && Number.isFinite(child.support) && child.support < supportThreshold;
        parts.push(svgLine({
          x1: x, y1: y, x2: childX, y2: childY,
          stroke: lowSupport ? '#d1242f' : '#24292f',
          width: 1.4,
          dash: lowSupport ? [4, 3] : undefined,
        }));
        if (lowSupport) {
          parts.push(textRun({ x: (x + childX) / 2, y: (y + childY) / 2, text: String(child.support), size: 8, fill: '#d1242f' }));
        }
        draw(child);
      }
      if (node.children.length === 0) {
        const angle = angleOf.get(node);
        const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
        const [labelX, labelY] = [centre.x + dx * (radiusOf(node) + 6), centre.y + dy * (radiusOf(node) + 6)];
        const anchor = Math.cos(angle) >= 0.1 ? 'start' : Math.cos(angle) <= -0.1 ? 'end' : 'middle';
        parts.push(textRun({ x: labelX, y: labelY + 4, text: node.name, size: leafFontSize, fill: '#24292f', anchor }));
      }
    };
    parts.push(svgCircle({ cx: centre.x, cy: centre.y, r: 2, fill: '#d1242f' }));
    draw(tree);
    if (layout === 'circular' && scaleBar) {
      const barLength = Math.min(plot.width * 0.24, 150);
      const barY = plot.y + plot.height - 10;
      const units = round((barLength / (radius - 2)) * maxDepth, 4);
      parts.push(textRun({ x: plot.x + 2, y: barY - 5, text: `${units} substitutions/site`, size: 9, fill: '#57606a' }));
      parts.push(svgLine({ x1: plot.x + 2, y1: barY, x2: plot.x + 2 + barLength, y2: barY, stroke: '#57606a', width: 2 }));
      parts.push(svgLine({ x1: plot.x + 2, y1: barY - 4, x2: plot.x + 2, y2: barY + 4, stroke: '#57606a', width: 1 }));
      parts.push(svgLine({ x1: plot.x + 2 + barLength, y1: barY - 4, x2: plot.x + 2 + barLength, y2: barY + 4, stroke: '#57606a', width: 1 }));
    }
    if (layout === 'fan') {
      parts.push(textRun({ x: plot.x + 2, y: plot.y + plot.height - 4, text: 'equal-angle fan: topology only (branch lengths not to scale)', size: 9, fill: '#57606a' }));
    }
  }
  const caption = subtitle === '' ? `${leaves.length} leaves · ${layout}` : subtitle;
  return svgDocument({
    width,
    height,
    title,
    description: caption,
    body: parts.join('\n'),
  });
}

/** A scale bar with its own little axis, annotated with the distance. */
function scaleBarMarkup(plot, maxDepth, xOf, y) {
  const span = maxDepth;
  const length = (span / maxDepth) * (plot.width * 0.25);
  return [
    rect({ x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: 'none' }),
    svgLine({ x1: plot.x, y1: y, x2: plot.x + length, y2: y, stroke: '#57606a', width: 1.5 }),
    svgLine({ x1: plot.x, y1: y - 4, x2: plot.x, y2: y + 4, stroke: '#57606a', width: 1 }),
    svgLine({ x1: plot.x + length, y1: y - 4, x2: plot.x + length, y2: y + 4, stroke: '#57606a', width: 1 }),
    textRun({ x: plot.x + length / 2, y: y - 6, text: `${round(span * 0.25, 3)} substitutions/site`, size: 9, fill: '#57606a', anchor: 'middle' }),
  ].join('\n');
}
