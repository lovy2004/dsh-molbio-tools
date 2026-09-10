/**
 * dsh-molbio-tools/build/panel-core.mjs
 *
 * Pure logic behind the browser panels: which workspace files can be opened,
 * how their bytes become a parsed record, and how a record becomes the SVG the
 * panel draws. Deliberately free of React and of the connection API so the
 * whole data path is testable in Node (see test/panel.mjs) — the components in
 * client-entry.mjs only wire this to services and render it.
 *
 * All parsing and rendering is the SAME code the Node tools run: this module
 * re-exports through browser-api.mjs, which points at the root .mjs sources.
 */
import {
  MolbioInputError,
  parseGenBank,
  parseSnapGeneBytes,
  renderPlasmidMap,
  columnComposition,
  renderSequenceLogo,
  progressiveAlign,
} from './browser-api.mjs';

/** Extensions the panel can open, mapped to the parser that handles them. */
export const PLASMID_EXTENSIONS = {
  dna: 'snapgene',
  gb: 'genbank',
  gbk: 'genbank',
  genbank: 'genbank',
};

/** Extensions the panel offers as alignments for a sequence logo. */
export const ALIGNMENT_EXTENSIONS = {
  fa: 'fasta',
  fasta: 'fasta',
  fna: 'fasta',
  fas: 'fasta',
};

/** Lowercase extension without the dot, or '' when there is none. */
export function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name));
  return match === null ? '' : match[1].toLowerCase();
}

/**
 * How the panel should treat one workspace entry.
 * @param {{name?: string, type?: string}} entry a `workspaceFiles.list` row.
 * @returns {'plasmid'|'alignment'|'other'|'directory'}
 */
export function classifyEntry(entry) {
  if (entry === null || typeof entry !== 'object') return 'other';
  if (entry.type === 'directory') return 'directory';
  if (entry.type !== undefined && entry.type !== 'file') return 'other';
  const extension = extensionOf(entry.name ?? '');
  if (PLASMID_EXTENSIONS[extension] !== undefined) return 'plasmid';
  if (ALIGNMENT_EXTENSIONS[extension] !== undefined) return 'alignment';
  return 'other';
}

/** Sort entries: plasmid files first, then alignments, then the rest, by name. */
export function sortEntries(entries) {
  const rank = { plasmid: 0, alignment: 1, other: 2, directory: 3 };
  return [...entries].sort((left, right) => {
    const byKind = rank[classifyEntry(left)] - rank[classifyEntry(right)];
    if (byKind !== 0) return byKind;
    return String(left.name ?? '').localeCompare(String(right.name ?? ''));
  });
}

/** Join a workspace-relative directory and a child name into a workspace path. */
export function childPath(parent, name) {
  const base = String(parent ?? '').replace(/[\\/]+$/, '');
  return base === '' ? String(name) : `${base}/${String(name)}`;
}

/** Decode the base64 payload `workspaceFiles.readAll` returns. */
export function decodeBase64Bytes(base64) {
  if (typeof base64 !== 'string') throw new MolbioInputError('expected a base64 string from the workspace read');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Parse one workspace file into the record the panel renders.
 * @param {string} name file name (drives the parser choice).
 * @param {Uint8Array} bytes raw file content.
 * @returns {{kind: 'plasmid', name: string, length: number, circular: boolean,
 *   topology: string, features: Array, sequence: string}}
 */
export function parsePlasmidFile(name, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new MolbioInputError('file content must be a Uint8Array');
  const extension = extensionOf(name);
  const parser = PLASMID_EXTENSIONS[extension];
  if (parser === undefined) {
    throw new MolbioInputError(`the panel does not open .${extension} files; use .dna, .gb, .gbk or .genbank`);
  }
  const parsed = parser === 'snapgene'
    ? parseSnapGeneBytes(bytes)
    : parseGenBank(new TextDecoder('utf-8').decode(bytes));
  return {
    kind: 'plasmid',
    name: parsed.name === undefined || parsed.name === '' ? name : parsed.name,
    length: parsed.length,
    topology: parsed.topology ?? 'circular',
    circular: (parsed.topology ?? 'circular') !== 'linear',
    features: parsed.features ?? [],
    sequence: parsed.sequence ?? '',
  };
}

/**
 * Render a parsed plasmid as the map SVG the panel injects.
 * @param {object} record a {@link parsePlasmidFile} result.
 * @param {{showFeatures?: boolean}} [options]
 * @returns {string} SVG text.
 */
export function plasmidSvg(record, options = {}) {
  return renderPlasmidMap({
    name: record.name,
    length: record.length,
    circular: record.circular,
    features: options.showFeatures === false ? [] : record.features,
    enzymes: [],
    sequence: record.sequence,
  });
}

/**
 * Parse an alignment file (FASTA) into the rows the logo needs.
 * @param {Uint8Array} bytes raw FASTA content.
 * @returns {{ids: string[], rows: string[]}}
 */
export function parseAlignmentFile(bytes) {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  const ids = [];
  const rows = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('>')) {
      if (current !== null) rows.push(current.join(''));
      current = [];
      ids.push(line.slice(1).trim().split(/\s+/)[0] || `seq${ids.length + 1}`);
      continue;
    }
    if (current === null) throw new MolbioInputError('the FASTA file must start with a ">" header line');
    current.push(line);
  }
  if (current !== null) rows.push(current.join(''));
  if (rows.length < 2) throw new MolbioInputError(`a sequence logo needs at least 2 sequences (found ${rows.length})`);
  // Reuse the plugin's own aligner so the panel shows exactly what
  // molbio_msa_align would produce for the same input.
  const aligned = progressiveAlign(rows.map((sequence, index) => ({ id: ids[index], sequence })));
  return { ids, rows: aligned.alignment.map((row) => row.sequence) };
}

/**
 * Render a sequence logo for an alignment file.
 * @param {{ids: string[], rows: string[]}} alignment
 * @returns {string} SVG text.
 */
export function logoSvg(alignment) {
  const compositions = columnComposition(alignment.rows, { smallSample: true });
  return renderSequenceLogo(compositions, {
    title: 'Sequence logo',
    sequenceCount: alignment.rows.length,
    smallSample: true,
  });
}
