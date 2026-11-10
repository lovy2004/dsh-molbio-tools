/**
 * dsh-molbio-tools/structure-preview.mjs
 *
 * Pure parsing for structure files shown in the browser panel: PDB, mmCIF and
 * MDL SDF/MOL V2000. Rendering lives in structure-render.mjs, which turns this
 * record into a realistic ball-and-stick or space-filling RGB frame.
 *
 * WHAT THIS IS
 * ------------
 * A compact, dependency-free reader for the coordinates, elements, chains and
 * bonds a preview needs. It does not interpret secondary structure, surfaces,
 * symmetry or multiple models; a failed/unsupported file throws a
 * MolbioInputError naming the file kind, and the panel turns that into a notice.
 *
 * The module is browser-safe on purpose: it imports only MolbioInputError from
 * lib.mjs. It must not import node:fs, node:path or node:zlib.
 */
import { MolbioInputError } from './lib.mjs';

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
 * @returns {object} the parsed record consumed by structure-render.mjs.
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
