/**
 * dsh-molbio-tools/structure-preview.mjs
 *
 * Pure parsing and 2D rendering for structure files shown in the browser
 * panel: PDB, mmCIF and MDL SDF/MOL V2000.
 *
 * WHAT THIS IS
 * ------------
 * A compact, dependency-free reader for the coordinates and bonds a bench user
 * actually needs to recognise a structure in the sidebar — not a molecular
 * viewer. The drawing is a deterministic PCA projection to two dimensions, so
 * "which chain is which" and "does this file contain the ligand I expect" are
 * answerable without a WebGL stack, a network request or a second parser in the
 * browser.
 *
 * WHAT THIS IS NOT
 * ----------------
 * No secondary structure, no surface, no symmetry, no V3000, no multi-model
 * animation. A failed or unsupported file throws a MolbioInputError with the
 * file kind in the message; the panel turns that into a notice, never a blank
 * pane.
 *
 * The module is browser-safe on purpose: it imports MolbioInputError from
 * lib.mjs and the SVG primitives from svgio.mjs, both of which already ship in
 * the client bundle. It must not import node:fs, node:path or node:zlib.
 */
import { MolbioInputError } from './lib.mjs';
import {
  circle,
  line,
  rect,
  svgDocument,
  textRun,
} from './svgio.mjs';

/** Extension to parser kind. The keys are lowercase. */
export const STRUCTURE_EXTENSIONS = {
  pdb: 'pdb',
  ent: 'pdb',
  cif: 'mmcif',
  mmcif: 'mmcif',
  sdf: 'sdf',
  mol: 'sdf',
};

/** Upper bound on atoms read from one file. */
export const MAX_STRUCTURE_ATOMS = 20000;

/** Upper bound on bonds read from one file. */
export const MAX_STRUCTURE_BONDS = 40000;

/** The format label for a filename, or undefined when it is not a structure. */
export function structureFormatOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name));
  if (match === null) return undefined;
  return STRUCTURE_EXTENSIONS[match[1].toLowerCase()];
}

/**
 * Parse one structure file.
 * @param {string} format 'pdb' | 'mmcif' | 'sdf'
 * @param {string} text file content (UTF-8 decoded).
 * @param {string} [name] display name, used for the title fallback.
 * @returns {object} the parsed record consumed by renderStructureProjection.
 */
export function parseStructureText(format, text, name = 'structure') {
  const kind = String(format).toLowerCase();
  if (kind === 'pdb') return withSummary(parsePdb(text, name));
  if (kind === 'mmcif') return withSummary(parseMmcif(text, name));
  if (kind === 'sdf') return withSummary(parseSdf(text, name));
  throw new MolbioInputError('the structure parser accepts pdb, mmcif or sdf/mol files');
}

// ── shared atom helpers ─────────────────────────────────────────────────────

const ELEMENTS = new Set(['H', 'C', 'N', 'O', 'S', 'P', 'F', 'CL', 'BR', 'I', 'B', 'SI', 'SE', 'FE', 'ZN', 'MG', 'CA', 'NA', 'K']);

/** Element symbol from an atom name, when the file does not carry one. */
function guessElement(atomName) {
  const cleaned = String(atomName ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (cleaned === '') return 'C';
  const two = cleaned.slice(0, 2);
  if (ELEMENTS.has(two)) return two;
  return cleaned.slice(0, 1);
}

/** Element symbol, normalised to upper case and at most two characters. */
function normalizeElement(value, fallbackName) {
  const element = String(value ?? '').trim().toUpperCase();
  if (element !== '' && element !== '?' && element !== '.') return element.slice(0, 2);
  return guessElement(fallbackName);
}

/** One atom record; all coordinates are finite numbers. */
function atomRecord({ serial, name, element, residue, chain, residueNumber, x, y, z, hetatm }) {
  return {
    serial,
    name: String(name ?? '').trim(),
    element: normalizeElement(element, name),
    residue: String(residue ?? '').trim(),
    chain: String(chain ?? '').trim(),
    residue_number: String(residueNumber ?? '').trim(),
    x,
    y,
    z,
    hetatm: hetatm === true,
  };
}

/** Reject a file that produced no usable coordinates. */
function requireAtoms(atoms, format) {
  if (atoms.length === 0) {
    throw new MolbioInputError(`the ${format} file contains no usable atom coordinates`);
  }
  if (atoms.length > MAX_STRUCTURE_ATOMS) {
    throw new MolbioInputError(`the file has ${atoms.length} atoms; the panel reads at most ${MAX_STRUCTURE_ATOMS}`);
  }
}

/** Attach the derived facts the panel shows, without copying the arrays. */
function withSummary(record) {
  const chains = [...new Set(record.atoms.map((atom) => atom.chain).filter((chain) => chain !== ''))];
  const residues = new Set(record.atoms.map((atom) => `${atom.chain}:${atom.residue_number}:${atom.residue}`));
  return {
    ...record,
    chains,
    chain_count: chains.length,
    residue_count: residues.size,
    hetatm_count: record.atoms.filter((atom) => atom.hetatm).length,
  };
}

// ── PDB ─────────────────────────────────────────────────────────────────────

/** Parse PDB ATOM/HETATM records from the first model. */
export function parsePdb(text, name = 'structure') {
  const atoms = [];
  const serials = new Map();
  const conect = [];
  const titleParts = [];
  let model = 0;
  let sawModel = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const lineText = rawLine.padEnd(80, ' ');
    const recordName = lineText.slice(0, 6).trim().toUpperCase();
    if (recordName === 'TITLE') {
      titleParts.push(lineText.slice(10).trim());
      continue;
    }
    if (recordName === 'MODEL') {
      sawModel = true;
      model += 1;
      continue;
    }
    if (recordName === 'ENDMDL') {
      if (atoms.length > 0) break;
      continue;
    }
    if (recordName !== 'ATOM' && recordName !== 'HETATM') {
      if (recordName === 'CONECT') {
        const numbers = lineText.slice(6).trim().split(/\s+/).map((value) => Number(value)).filter((value) => Number.isInteger(value));
        if (numbers.length > 1) conect.push(numbers);
      }
      continue;
    }
    if (sawModel && model > 1) continue;
    const altLocation = lineText.slice(16, 17);
    if (altLocation !== ' ' && altLocation !== 'A') continue;
    const x = Number(lineText.slice(30, 38));
    const y = Number(lineText.slice(38, 46));
    const z = Number(lineText.slice(46, 54));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const serial = Number(lineText.slice(6, 11).trim());
    const atom = atomRecord({
      serial: Number.isInteger(serial) ? serial : atoms.length + 1,
      name: lineText.slice(12, 16),
      element: lineText.slice(76, 78),
      residue: lineText.slice(17, 20),
      chain: lineText.slice(21, 22),
      residueNumber: lineText.slice(22, 26),
      x,
      y,
      z,
      hetatm: recordName === 'HETATM',
    });
    if (Number.isInteger(atom.serial)) serials.set(atom.serial, atoms.length);
    atoms.push(atom);
  }

  requireAtoms(atoms, 'PDB');
  const bonds = [];
  for (const numbers of conect) {
    const from = serials.get(numbers[0]);
    if (from === undefined) continue;
    for (const target of numbers.slice(1)) {
      const to = serials.get(target);
      if (to !== undefined) bonds.push({ a: from, b: to, order: 1 });
    }
  }
  return {
    kind: 'structure',
    format: 'pdb',
    name,
    title: titleParts.join(' ').replace(/\s+/g, ' ').trim(),
    atoms,
    bonds: bonds.slice(0, MAX_STRUCTURE_BONDS),
  };
}

// ── mmCIF ───────────────────────────────────────────────────────────────────

/** Split a CIF document into tokens, honouring quotes and ; text blocks. */
function cifTokens(text) {
  const tokens = [];
  const lines = String(text).split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const lineText = lines[index];
    if (lineText.startsWith(';')) {
      const parts = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith(';')) {
        parts.push(lines[index]);
        index += 1;
      }
      index += 1;
      tokens.push(parts.join('\n'));
      continue;
    }
    let position = 0;
    while (position < lineText.length) {
      while (position < lineText.length && /\s/.test(lineText[position])) position += 1;
      if (position >= lineText.length) break;
      if (lineText[position] === '#') break;
      const quote = lineText[position];
      if (quote === "'" || quote === '"') {
        position += 1;
        const start = position;
        while (position < lineText.length && lineText[position] !== quote) position += 1;
        tokens.push(lineText.slice(start, position));
        if (position < lineText.length) position += 1;
        continue;
      }
      const start = position;
      while (position < lineText.length && !/\s/.test(lineText[position])) position += 1;
      tokens.push(lineText.slice(start, position));
    }
    index += 1;
  }
  return tokens;
}

/** Index of the first tag matching one of the candidate names. */
function firstTagIndex(tags, candidates) {
  for (const candidate of candidates) {
    const index = tags.indexOf(candidate);
    if (index !== -1) return index;
  }
  return -1;
}

/** Parse the _atom_site loop of an mmCIF document. */
export function parseMmcif(text, name = 'structure') {
  const tokens = cifTokens(text);
  let atoms = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].toLowerCase() !== 'loop_') continue;
    const tags = [];
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor].startsWith('_')) {
      tags.push(tokens[cursor]);
      cursor += 1;
    }
    if (!tags.some((tag) => tag.startsWith('_atom_site.'))) {
      index = cursor - 1;
      continue;
    }
    const values = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.startsWith('_') || token.toLowerCase() === 'loop_' || token.toLowerCase() === 'stop_' || token.toLowerCase().startsWith('data_')) break;
      values.push(token);
      cursor += 1;
    }
    const rowWidth = tags.length;
    if (rowWidth === 0) continue;
    const column = (candidates) => firstTagIndex(tags, candidates);
    const groupColumn = column(['_atom_site.group_PDB']);
    const atomColumn = column(['_atom_site.label_atom_id', '_atom_site.auth_atom_id']);
    const residueColumn = column(['_atom_site.label_comp_id', '_atom_site.auth_comp_id']);
    const chainColumn = column(['_atom_site.auth_asym_id', '_atom_site.label_asym_id']);
    const residueNumberColumn = column(['_atom_site.auth_seq_id', '_atom_site.label_seq_id']);
    const xColumn = column(['_atom_site.Cartn_x']);
    const yColumn = column(['_atom_site.Cartn_y']);
    const zColumn = column(['_atom_site.Cartn_z']);
    const elementColumn = column(['_atom_site.type_symbol']);
    const modelColumn = column(['_atom_site.pdbx_PDB_model_num']);
    const altColumn = column(['_atom_site.label_alt_id']);
    if (xColumn === -1 || yColumn === -1 || zColumn === -1) continue;
    const rows = [];
    for (let start = 0; start + rowWidth <= values.length; start += rowWidth) {
      rows.push(values.slice(start, start + rowWidth));
    }
    let firstModel;
    const parsed = [];
    for (const row of rows) {
      const cell = (position) => (position === -1 ? '' : row[position]);
      const modelValue = cell(modelColumn);
      if (firstModel === undefined && modelValue !== '' && modelValue !== '.' && modelValue !== '?') firstModel = modelValue;
      if (firstModel !== undefined && modelValue !== '' && modelValue !== '.' && modelValue !== '?' && modelValue !== firstModel) continue;
      const alt = cell(altColumn);
      if (alt !== '' && alt !== '.' && alt !== '?' && alt !== 'A') continue;
      const x = Number(cell(xColumn));
      const y = Number(cell(yColumn));
      const z = Number(cell(zColumn));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const group = cell(groupColumn).toUpperCase();
      parsed.push(atomRecord({
        serial: parsed.length + 1,
        name: cell(atomColumn),
        element: cell(elementColumn),
        residue: cell(residueColumn),
        chain: cell(chainColumn),
        residueNumber: cell(residueNumberColumn),
        x,
        y,
        z,
        hetatm: group === 'HETATM',
      }));
    }
    atoms = parsed;
    break;
  }

  requireAtoms(atoms, 'mmCIF');
  return {
    kind: 'structure',
    format: 'mmcif',
    name,
    title: '',
    atoms,
    bonds: [],
  };
}

// ── SDF / MOL V2000 ─────────────────────────────────────────────────────────

/** Parse the first molecule of an SDF/MOL V2000 file. */
export function parseSdf(text, name = 'structure') {
  // The first record ends at $$$$; later records are deliberately ignored.
  const first = String(text).split(/^\$\$\$\$/m)[0];
  const lines = first.split(/\r?\n/);
  const title = (lines[0] ?? '').trim();
  let countsIndex = -1;
  for (let index = 0; index < Math.min(lines.length, 8); index++) {
    if (/V2000|V3000/.test(lines[index])) {
      countsIndex = index;
      break;
    }
  }
  if (countsIndex === -1) throw new MolbioInputError('the SDF/MOL file has no V2000 counts line');
  if (/V3000/.test(lines[countsIndex])) {
    throw new MolbioInputError('MDL V3000 is not supported; export the molecule as V2000 SDF or MOL');
  }
  const counts = lines[countsIndex] ?? '';
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6), 10);
  if (!Number.isInteger(atomCount) || atomCount <= 0) throw new MolbioInputError('the SDF/MOL counts line declares no atoms');
  if (atomCount > MAX_STRUCTURE_ATOMS) throw new MolbioInputError(`the file has ${atomCount} atoms; the panel reads at most ${MAX_STRUCTURE_ATOMS}`);
  const atoms = [];
  for (let offset = 0; offset < atomCount; offset++) {
    const lineText = lines[countsIndex + 1 + offset] ?? '';
    const x = Number(lineText.slice(0, 10));
    const y = Number(lineText.slice(10, 20));
    const z = Number(lineText.slice(20, 30));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const symbol = lineText.slice(31, 34).trim() || lineText.trim().split(/\s+/)[3] || 'C';
    atoms.push(atomRecord({
      serial: offset + 1,
      name: symbol,
      element: symbol,
      residue: '',
      chain: '',
      residueNumber: '',
      x,
      y,
      z,
      hetatm: false,
    }));
  }
  requireAtoms(atoms, 'SDF/MOL');
  const bonds = [];
  const bondStart = countsIndex + 1 + atomCount;
  for (let offset = 0; offset < bondCount; offset++) {
    const lineText = lines[bondStart + offset] ?? '';
    const from = Number.parseInt(lineText.slice(0, 3), 10) - 1;
    const to = Number.parseInt(lineText.slice(3, 6), 10) - 1;
    const order = Number.parseInt(lineText.slice(6, 9), 10);
    if (from < 0 || to < 0 || from >= atoms.length || to >= atoms.length) continue;
    bonds.push({ a: from, b: to, order: Number.isInteger(order) && order > 0 ? order : 1 });
  }
  return {
    kind: 'structure',
    format: 'sdf',
    name,
    title,
    atoms,
    bonds: bonds.slice(0, MAX_STRUCTURE_BONDS),
  };
}

// ── 2D PCA projection ───────────────────────────────────────────────────────

/** Jacobi eigenvalues/vectors of a symmetric 3x3 matrix (deterministic). */
function jacobiEigen(matrix) {
  const a = matrix.map((row) => row.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(a[0][1]);
    for (const [row, column] of [[0, 2], [1, 2]]) {
      const candidate = Math.abs(a[row][column]);
      if (candidate > largest) {
        largest = candidate;
        p = row;
        q = column;
      }
    }
    if (largest < 1e-12) break;
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const theta = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = cos * akp - sin * akq;
      a[k][q] = sin * akp + cos * akq;
      a[p][k] = a[k][p];
      a[q][k] = a[k][q];
    }
    a[p][p] = cos * cos * app - 2 * sin * cos * apq + sin * sin * aqq;
    a[q][q] = sin * sin * app + 2 * sin * cos * apq + cos * cos * aqq;
    a[p][q] = 0;
    a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = cos * vkp - sin * vkq;
      v[k][q] = sin * vkp + cos * vkq;
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]];
  return { values, vectors: v };
}

/** Project 3D points to their two largest-variance axes. */
function projectPoints(points) {
  const count = points.length;
  const center = [0, 0, 0];
  for (const point of points) {
    center[0] += point[0];
    center[1] += point[1];
    center[2] += point[2];
  }
  center[0] /= count;
  center[1] /= count;
  center[2] /= count;
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const point of points) {
    const d = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) covariance[row][column] += d[row] * d[column];
    }
  }
  const { values, vectors } = jacobiEigen(covariance);
  const order = [0, 1, 2].sort((left, right) => values[right] - values[left]);
  const axis = (position) => [vectors[0][order[position]], vectors[1][order[position]], vectors[2][order[position]]];
  let first = axis(0);
  let second = axis(1);
  if (!first.every(Number.isFinite)) first = [1, 0, 0];
  if (!second.every(Number.isFinite)) second = [0, 1, 0];
  return points.map((point) => {
    const d = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
    return {
      x: d[0] * first[0] + d[1] * first[1] + d[2] * first[2],
      y: d[0] * second[0] + d[1] * second[1] + d[2] * second[2],
    };
  });
}

/** Pick the atoms to draw: CA trace for polymers, heavy atoms otherwise. */
function drawingSubset(record) {
  const alphaCarbons = record.atoms.filter((atom) => atom.name.toUpperCase() === 'CA' && atom.hetatm === false);
  if ((record.format === 'pdb' || record.format === 'mmcif') && alphaCarbons.length >= 3) {
    const traceIndexes = record.atoms
      .map((atom, index) => ({ atom, index }))
      .filter((entry) => entry.atom.name.toUpperCase() === 'CA' && entry.atom.hetatm === false)
      .map((entry) => entry.index);
    return { mode: 'trace', indexes: traceIndexes };
  }
  const heavy = record.atoms
    .map((atom, index) => ({ atom, index }))
    .filter((entry) => entry.atom.element !== 'H')
    .map((entry) => entry.index);
  return { mode: 'atoms', indexes: heavy.length > 0 ? heavy : record.atoms.map((_, index) => index) };
}

const ELEMENT_COLORS = {
  C: '#57606a',
  N: '#0969da',
  O: '#cf222e',
  S: '#bf8700',
  P: '#8250df',
  F: '#1a7f37',
  CL: '#1a7f37',
  BR: '#a40e26',
  I: '#8250df',
  H: '#d0d7de',
  FE: '#bc4c00',
  ZN: '#6e7781',
  MG: '#1a7f37',
  CA: '#1a7f37',
  NA: '#1a7f37',
  K: '#1a7f37',
};
const CHAIN_COLORS = ['#0969da', '#cf222e', '#1a7f37', '#8250df', '#bf8700', '#0550ae', '#a40e26', '#116329'];

/** Colour for an element symbol. */
function elementColor(element) {
  return ELEMENT_COLORS[element] ?? '#1a7f37';
}

/**
 * Render a parsed structure as an SVG PCA projection.
 *
 * The drawing is deliberately deterministic: the same file always produces the
 * same coordinates, so a test can assert a point's position rather than merely
 * that a circle exists.
 * @param {object} record a parseStructureText result.
 * @param {{width?: number, height?: number, max_segments?: number}} [options]
 * @returns {string} SVG text.
 */
export function renderStructureProjection(record, options = {}) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.atoms) || record.atoms.length === 0) {
    throw new MolbioInputError('renderStructureProjection needs a parsed structure with atoms');
  }
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const plot = { x: 24, y: 58, width: width - 48, height: height - 112 };
  const subset = drawingSubset(record);
  const points = subset.indexes.map((index) => [record.atoms[index].x, record.atoms[index].y, record.atoms[index].z]);
  const projected = projectPoints(points);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const point of projected) {
    if (point.x < xMin) xMin = point.x;
    if (point.x > xMax) xMax = point.x;
    if (point.y < yMin) yMin = point.y;
    if (point.y > yMax) yMax = point.y;
  }
  const spanX = Math.max(1e-9, xMax - xMin);
  const spanY = Math.max(1e-9, yMax - yMin);
  const scale = Math.min(plot.width / spanX, plot.height / spanY) * 0.9;
  const centerX = (xMin + xMax) / 2;
  const centerY = (yMin + yMax) / 2;
  const toScreen = (point) => ({
    x: plot.x + plot.width / 2 + (point.x - centerX) * scale,
    y: plot.y + plot.height / 2 - (point.y - centerY) * scale,
  });
  const screen = projected.map(toScreen);

  const body = [];
  body.push(textRun({ x: plot.x, y: 26, text: record.title === '' ? record.name : record.title, size: 14, weight: 'bold', fill: '#24292f' }));
  body.push(textRun({
    x: plot.x,
    y: 44,
    text: `${record.format.toUpperCase()} · ${record.atoms.length} atoms · ${record.chain_count} chain(s) · ${record.residue_count} residue(s)`,
    size: 10,
    fill: '#57606a',
  }));
  body.push(rect({ x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: '#fbfcfd', stroke: '#d0d7de' }));

  const segmentColor = (chain) => {
    if (record.chain_count <= 1) return '#57606a';
    const position = record.chains.indexOf(chain);
    return CHAIN_COLORS[(position < 0 ? 0 : position) % CHAIN_COLORS.length];
  };
  const maxSegments = options.max_segments ?? 6000;
  let segments = 0;
  let drawnPoints = screen.length;
  let subsampled = false;

  if (subset.mode === 'trace') {
    for (let position = 1; position < subset.indexes.length; position++) {
      const previous = record.atoms[subset.indexes[position - 1]];
      const current = record.atoms[subset.indexes[position]];
      if (previous.chain !== current.chain) continue;
      const distance = Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z);
      if (distance > 4.5) continue;
      if (segments >= maxSegments) {
        subsampled = true;
        break;
      }
      const from = screen[position - 1];
      const to = screen[position];
      body.push(line({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: segmentColor(current.chain), width: 2, cap: 'round' }));
      segments += 1;
    }
    for (let position = 0; position < screen.length; position++) {
      const atom = record.atoms[subset.indexes[position]];
      const point = screen[position];
      body.push(circle({ cx: point.x, cy: point.y, r: 2.2, fill: segmentColor(atom.chain) }));
    }
  } else {
    const indexOf = new Map(subset.indexes.map((atomIndex, position) => [atomIndex, position]));
    for (const bond of record.bonds) {
      const from = indexOf.get(bond.a);
      const to = indexOf.get(bond.b);
      if (from === undefined || to === undefined) continue;
      if (segments >= maxSegments) {
        subsampled = true;
        break;
      }
      const a = screen[from];
      const b = screen[to];
      body.push(line({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#8c959f', width: bond.order >= 2 ? 2.4 : 1.4 }));
      segments += 1;
    }
    for (let position = 0; position < screen.length; position++) {
      const atom = record.atoms[subset.indexes[position]];
      const point = screen[position];
      body.push(circle({ cx: point.x, cy: point.y, r: 3.1, fill: elementColor(atom.element), stroke: '#ffffff', strokeWidth: 0.6 }));
    }
  }

  const legend = [];
  if (subset.mode === 'trace') {
    record.chains.slice(0, 8).forEach((chain, position) => {
      const x = plot.x + 8 + position * 72;
      legend.push(circle({ cx: x + 4, cy: plot.y + plot.height - 12, r: 3, fill: CHAIN_COLORS[position % CHAIN_COLORS.length] }));
      legend.push(textRun({ x: x + 12, y: plot.y + plot.height - 8, text: `chain ${chain}`, size: 9, fill: '#57606a' }));
    });
  } else {
    const counts = new Map();
    for (const index of subset.indexes) {
      const element = record.atoms[index].element;
      counts.set(element, (counts.get(element) ?? 0) + 1);
    }
    [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).forEach(([element, count], position) => {
      const x = plot.x + 8 + position * 64;
      legend.push(circle({ cx: x + 4, cy: plot.y + plot.height - 12, r: 3, fill: elementColor(element) }));
      legend.push(textRun({ x: x + 12, y: plot.y + plot.height - 8, text: `${element} ${count}`, size: 9, fill: '#57606a' }));
    });
  }

  const noteParts = [subset.mode === 'trace' ? 'Cα trace' : 'heavy atoms', '2D PCA projection — not a molecular viewer'];
  if (subsampled) noteParts.push('drawing capped');
  body.push(textRun({ x: plot.x, y: height - 16, text: noteParts.join(' · '), size: 9, fill: '#6e7781' }));
  body.push(...legend);

  const description = `${record.format} structure ${record.name}: ${record.atoms.length} atoms, ${record.bonds.length} bonds, 2D PCA projection`;
  return svgDocument({ width, height, title: record.title === '' ? record.name : record.title, description, body: body.join('\n') });
}
