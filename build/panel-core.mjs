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
  parseStructureText,
  renderStructureImage,
  DEFAULT_STRUCTURE_VIEW,
  STRUCTURE_ELEMENT_COLORS,
  STRUCTURE_EXTENSIONS,
  STRUCTURE_REPRESENTATIONS,
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

/** Structure formats the panel opens, mapped to the parser kind. */
export { DEFAULT_STRUCTURE_VIEW, STRUCTURE_ELEMENT_COLORS, STRUCTURE_EXTENSIONS, STRUCTURE_REPRESENTATIONS };

/** Lowercase extension without the dot, or '' when there is none. */
export function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name));
  return match === null ? '' : match[1].toLowerCase();
}

/**
 * How the panel should treat one workspace entry.
 * @param {{name?: string, type?: string}} entry a `workspaceFiles.list` row.
 * @returns {'plasmid'|'alignment'|'structure'|'other'|'directory'}
 */
export function classifyEntry(entry) {
  if (entry === null || typeof entry !== 'object') return 'other';
  if (entry.type === 'directory') return 'directory';
  if (entry.type !== undefined && entry.type !== 'file') return 'other';
  const extension = extensionOf(entry.name ?? '');
  if (PLASMID_EXTENSIONS[extension] !== undefined) return 'plasmid';
  if (ALIGNMENT_EXTENSIONS[extension] !== undefined) return 'alignment';
  if (STRUCTURE_EXTENSIONS[extension] !== undefined) return 'structure';
  return 'other';
}

/** Whether the panel can open this entry at all. */
export function isOpenable(entry) {
  const kind = classifyEntry(entry);
  return kind === 'plasmid' || kind === 'alignment' || kind === 'structure';
}

/** Sort entries: plasmid files first, then alignments, structures, the rest. */
export function sortEntries(entries) {
  const rank = { plasmid: 0, alignment: 1, structure: 2, other: 3, directory: 4 };
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

/**
 * Normalise one workspace read into the raw bytes the parsers consume.
 *
 * Two transports reach this function and they do NOT agree on the spelling:
 *
 *   - pre-0.1.7 `readAll` answered `data` as a base64 STRING;
 *   - 0.1.7-alpha.1 `readBytes` answers `data` as a `Uint8Array`, because the
 *     gateway lifts native bytes into a base64 attachment and reassembles them
 *     client-side before the call resolves.
 *
 * Accepting both here is what keeps the panel working across the change: the
 * caller feature-detects the METHOD, and this function normalises the VALUE.
 * A `Uint8Array` is passed through by reference (no copy), so a large plasmid
 * costs nothing extra.
 *
 * @param {string|Uint8Array} data the `data` field of a successful read.
 * @returns {Uint8Array} the file's raw bytes.
 */
export function decodeWorkspaceBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data !== 'string') throw new MolbioInputError('expected base64 text or bytes from the workspace read');
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Guard for the browser half only: the panel parses on the UI thread, so an
 * oversized file is refused with a message instead of freezing the tab.
 * Deliberately much smaller than the host's read cap (`MAX_DNA_BYTES` in
 * index.mjs, 50 MB) — the host does not block a user interface.
 */
export const MAX_PANEL_FILE_BYTES = 5 * 1024 * 1024;

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
  if (bytes.length > MAX_PANEL_FILE_BYTES) {
    throw new MolbioInputError(
      `${name} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the panel opens sequence files up to ${MAX_PANEL_FILE_BYTES / 1024 / 1024} MB`,
    );
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
 * Parse a structure file into the record the panel draws.
 *
 * The size guard is the same browser-specific cap as {@link parsePlasmidFile}:
 * parsing runs on the UI thread, so a 200 MB PDB must be refused with a message
 * rather than freeze the tab. The format comes from the extension, exactly as
 * the Node tools choose their parser.
 * @param {string} name file name.
 * @param {Uint8Array} bytes raw file content.
 * @returns {object} a parseStructureText record.
 */
export function parseStructureFile(name, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new MolbioInputError('file content must be a Uint8Array');
  const extension = extensionOf(name);
  const format = STRUCTURE_EXTENSIONS[extension];
  if (format === undefined) {
    throw new MolbioInputError(`the panel does not open .${extension} structure files; use .pdb, .ent, .cif, .mmcif, .sdf or .mol`);
  }
  if (bytes.length > MAX_PANEL_FILE_BYTES) {
    throw new MolbioInputError(
      `${name} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the panel opens structure files up to ${MAX_PANEL_FILE_BYTES / 1024 / 1024} MB`,
    );
  }
  return parseStructureText(format, new TextDecoder('utf-8').decode(bytes), name);
}

/**
 * Render a parsed structure to an RGB buffer for the canvas.
 * @param {object} record a {@link parseStructureFile} result.
 * @param {{width?: number, height?: number, yaw?: number, pitch?: number,
 *   zoom?: number, representation?: string, supersample?: 1|2}} [options]
 * @returns {{width:number, height:number, rgb:Uint8Array, atoms:number,
 *   bonds:number, representation:string}}
 */
export function structureImage(record, options = {}) {
  return renderStructureImage(record, options);
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

// ── tool cards (the `tool.call.toolview` seat) ──────────────────────────────

/** The meta kind this package's map tools attach to their results. */
export const MAP_CARD_KIND = 'molbio-map';

/** Accept only a string that looks like the renderer's own output. */
function isSvgMarkup(value) {
  return typeof value === 'string' && value.startsWith('<svg') && value.endsWith('</svg>');
}

/**
 * Read a tool-result block's `meta` into what the map card draws.
 *
 * The tool layer records `output.presentationMeta(args, value)` for a root call
 * and the browser surfaces it as the block's `meta` — a value this package
 * produced itself (see `mapCardMeta` in index.mjs). It is still checked rather
 * than trusted, because the card renders inside the conversation: a block whose
 * meta is absent, of another kind, or shaped differently must degrade to a
 * notice, never throw in the transcript.
 *
 * @param {unknown} meta the block's meta, as the client received it.
 * @returns {{kind: 'notice', message: string} | {kind: 'map', name: string,
 *   svg: string, svgPath: string, length: number, circular: boolean,
 *   featureCount: number, enzymeCount: number, svgBytes: number}}
 */
export function mapCardView(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { kind: 'notice', message: 'No map data was attached to this call.' };
  }
  if (meta.kind !== MAP_CARD_KIND) {
    return { kind: 'notice', message: 'This call carries no plasmid map.' };
  }
  const base = {
    name: typeof meta.name === 'string' && meta.name !== '' ? meta.name : 'plasmid',
    svg: '',
    svgPath: typeof meta.svg_path === 'string' ? meta.svg_path : '',
    length: Number.isInteger(meta.length) ? meta.length : 0,
    circular: meta.circular !== false,
    featureCount: Number.isInteger(meta.feature_count) ? meta.feature_count : 0,
    enzymeCount: Number.isInteger(meta.enzyme_count) ? meta.enzyme_count : 0,
    svgBytes: Number.isInteger(meta.svg_bytes) ? meta.svg_bytes : 0,
  };
  if (!isSvgMarkup(meta.svg)) {
    // The tool always writes the file; only the in-meta copy is optional (it is
    // dropped when a map is too large to belong in the session log).
    const reason = meta.svg_omitted === true
      ? `The map is too large to draw inline (${Math.round(base.svgBytes / 1024)} KB); it was written to the file above.`
      : 'The map markup did not travel with this call.';
    return { kind: 'notice', message: reason, ...base };
  }
  return { kind: 'map', ...base, svg: meta.svg };
}

/** A one-line summary of a map card, for the card header and for tests. */
export function mapCardSummary(view) {
  const parts = [view.name, `${view.length} bp`, view.circular ? 'circular' : 'linear', `${view.featureCount} feature(s)`];
  if (view.enzymeCount > 0) parts.push(`${view.enzymeCount} cut mark(s)`);
  return parts.join(' · ');
}

// ── figure cards (the same `tool.call.toolview` seat) ───────────────────────

/** The meta kind the sequence-logo and gRNA tools attach to their results. */
export const FIGURE_CARD_KIND = 'molbio-figure';

const CARD_SUMMARY_MAX = 300;
const CARD_PATH_MAX = 500;
const CARD_GUIDES_MAX = 5;

/** A bounded string, or '' when the value is not a string. */
function cardText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** One guide row, validated field by field; malformed rows are dropped. */
function cardGuide(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const sequence = cardText(row.sequence, 60);
  if (sequence === '') return undefined;
  return {
    rank: Number.isInteger(row.rank) ? row.rank : 0,
    sequence,
    pam: cardText(row.pam, 12),
    strand: row.strand === 'reverse' ? 'reverse' : 'forward',
    start: Number.isInteger(row.start) ? row.start : 0,
    end: Number.isInteger(row.end) ? row.end : 0,
    score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0,
    offTargets: Number.isInteger(row.off_target_count) ? row.off_target_count : 0,
  };
}

/**
 * Read a tool-result block's meta into what the figure card draws.
 *
 * Like `mapCardView`, the value is a projection this package produced itself,
 * but the card renders inside the conversation, so every field is checked and
 * bounded rather than trusted: a block from an older version, another tool, a
 * running call or a failed run must degrade to a notice, never throw.
 *
 * @param {unknown} meta the block's meta, as the client received it.
 * @returns {{kind: 'notice', message: string, ...} | {kind: 'figure', figure:
 *   'logo'|'grna', summary: string, svg: string, svgPath: string,
 *   csvPath: string, mapPath: string, guides: Array}}
 */
export function figureCardView(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { kind: 'notice', message: 'No figure data was attached to this call.' };
  }
  if (meta.kind !== FIGURE_CARD_KIND) {
    return { kind: 'notice', message: 'This call carries no figure.' };
  }
  const figure = meta.figure === 'grna' ? 'grna' : meta.figure === 'logo' ? 'logo' : '';
  if (figure === '') {
    return { kind: 'notice', message: 'This call carries an unknown figure type.' };
  }
  const base = {
    figure,
    summary: cardText(meta.summary, CARD_SUMMARY_MAX),
    svgPath: cardText(meta.svg_path, CARD_PATH_MAX),
    csvPath: cardText(meta.csv_path, CARD_PATH_MAX),
    mapPath: cardText(meta.map_path, CARD_PATH_MAX),
    guides: Array.isArray(meta.guides)
      // Bound the work before validating, then keep at most five VALID rows:
      // malformed entries must not consume the budget and hide good ones.
      ? meta.guides.slice(0, 50).map(cardGuide).filter((guide) => guide !== undefined).slice(0, CARD_GUIDES_MAX)
      : [],
    svg: '',
  };
  if (!isSvgMarkup(meta.svg)) {
    const message = meta.svg_missing === true
      ? 'No picture was requested for this call; the numbers are in the tool result.'
      : meta.svg_omitted === true
        ? `The figure is too large to draw inline (${Math.round((Number.isInteger(meta.svg_bytes) ? meta.svg_bytes : 0) / 1024)} KB); the written file is named below.`
        : 'The figure markup did not travel with this call.';
    return { kind: 'notice', message, ...base };
  }
  return { kind: 'figure', ...base, svg: meta.svg };
}

/** The header line for a figure card, with a stable fallback. */
export function figureCardSummary(view) {
  if (view.summary !== '') return view.summary;
  return view.figure === 'logo' ? 'Sequence logo' : 'gRNA design';
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

/** The credential reference the PubMed tools read first. */
export const NCBI_KEY_REF = 'NCBI_API_KEY';

/**
 * Whether a Plugins-page detail subject is this package's own entry.
 *
 * Bundles and rows both expose `pkg.name`; the key section is offered on the
 * bundle page and on every row page the bundle declares, and on nothing else.
 */
export function isMolbioDetailSubject(subject) {
  if (subject === null || typeof subject !== 'object') return false;
  if (subject.kind !== 'bundle' && subject.kind !== 'row') return false;
  const pkg = subject.pkg;
  return pkg !== null && typeof pkg === 'object' && pkg.name === 'dsh-molbio-tools';
}

/**
 * The host failure message carried by a Remote result, or '' on success.
 * Remote calls answer `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function remoteFailure(response) {
  if (response === null || typeof response !== 'object' || response.ok !== false) return '';
  const message = response.error?.message;
  return typeof message === 'string' && message !== '' ? message : 'the host refused the request';
}

/** One reference's view from a `credentials.describe` response (never the value). */
export function credentialInfo(response, ref) {
  const view = response !== null && typeof response === 'object' && response.ok !== false
    ? response.value?.[ref]
    : undefined;
  return {
    configured: view?.configured === true,
    writable: view?.writable !== false,
    ...typeof view?.source === 'string' && view.source !== '' ? { source: view.source } : {},
  };
}
