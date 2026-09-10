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

// ── literature library (papers.json) ────────────────────────────────────────

/** The library file the molbio_paper_* tools write, relative to the workspace. */
export const LIBRARY_FILE = 'papers.json';

/** This panel's field order in the detail pane; unknown keys are ignored. */
const PAPER_FIELDS = [
  ['authors', 'Authors'],
  ['journal', 'Journal'],
  ['year', 'Year'],
  ['pmid', 'PMID'],
  ['url', 'URL'],
  ['added_at', 'Added'],
];

/**
 * Read one workspace file as text.
 * @returns {{kind: 'text', text: string} | {kind: 'missing'} | {kind: 'error', message: string}}
 *   A missing file is not an error: an absent `papers.json` is simply an empty
 *   library, which is what the molbio_paper_list tool reports too.
 */
export async function readWorkspaceText(remote, sessionId, path, signal) {
  let result;
  try {
    result = await remote.workspaceFiles.read({ sessionId }, path, undefined, signal);
  } catch (error) {
    return { kind: 'error', message: String(error?.message ?? error) };
  }
  if (result === null || typeof result !== 'object') return { kind: 'error', message: 'the workspace read returned nothing' };
  if (result.ok) return { kind: 'text', text: result.value?.text ?? '' };
  const failure = result.error;
  // The wire carries typed codes; not-found is the one that means "empty".
  if (failure?.code === 'workspace-file/not-found' || /not-found|does not exist/i.test(String(failure?.message ?? ''))) {
    return { kind: 'missing' };
  }
  return { kind: 'error', message: String(failure?.message ?? 'the workspace read failed') };
}

/**
 * Parse a paper library document.
 *
 * Mirrors `molbio_paper_list`'s contract (papers.mjs): an object with a
 * `papers` array. A corrupt file is reported, never silently treated as empty —
 * the panel exists to show the researcher their library, so "0 papers" and "the
 * file is broken" must not look the same.
 * @param {string} text the file's content.
 * @returns {{papers: Array}} parsed library.
 */
export function parseLibrary(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MolbioInputError(`papers.json is not valid JSON: ${String(error?.message ?? error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.papers)) {
    throw new MolbioInputError('papers.json must be an object with a "papers" array');
  }
  return { papers: parsed.papers.filter((entry) => entry !== null && typeof entry === 'object') };
}

/** Every tag in the library, deduped and sorted, with occurrence counts. */
export function libraryTags(papers) {
  const counts = new Map();
  for (const paper of papers) {
    for (const tag of Array.isArray(paper.tags) ? paper.tags : []) {
      if (typeof tag !== 'string' || tag.trim() === '') continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

/**
 * Filter papers for the panel's search box.
 * @param {Array} papers library entries.
 * @param {{query?: string, tag?: string}} [filter]
 * @returns {Array} matching papers, newest `added_at` first.
 */
export function filterPapers(papers, filter = {}) {
  const query = String(filter.query ?? '').trim().toLowerCase();
  const tag = filter.tag;
  return papers
    .filter((paper) => {
      if (tag !== undefined && tag !== '' && !(Array.isArray(paper.tags) && paper.tags.includes(tag))) return false;
      if (query === '') return true;
      const haystack = [paper.title, paper.authors, paper.journal, paper.year, paper.pmid, paper.url, paper.note, ...(Array.isArray(paper.tags) ? paper.tags : [])]
        .filter((value) => value !== undefined && value !== null)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((left, right) => String(right.added_at ?? '').localeCompare(String(left.added_at ?? '')) || String(left.title ?? '').localeCompare(String(right.title ?? '')));
}

/** The fields the detail pane lists, in a fixed order, skipping empty ones. */
export function paperFields(paper) {
  const fields = [];
  for (const [key, label] of PAPER_FIELDS) {
    const value = paper[key];
    if (typeof value === 'string' && value.trim() !== '') fields.push({ key, label, value: value.trim() });
  }
  return fields;
}

/** A one-line summary for the list row. */
export function paperSummary(paper) {
  const parts = [];
  if (typeof paper.authors === 'string' && paper.authors !== '') parts.push(paper.authors.split(',')[0].trim() + (paper.authors.includes(',') ? ' et al.' : ''));
  if (paper.journal !== undefined) parts.push(String(paper.journal));
  if (paper.year !== undefined) parts.push(String(paper.year));
  return parts.join(' · ');
}

/** The URL a paper's title links to, when it has one. */
export function paperLink(paper) {
  if (typeof paper.url === 'string' && paper.url !== '') return paper.url;
  if (typeof paper.pmid === 'string' && paper.pmid !== '') return `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`;
  return undefined;
}
