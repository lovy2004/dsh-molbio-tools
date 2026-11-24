/**
 * dsh-molbio-tools/build/client-entry.mjs
 *
 * The browser half of the package: a "Molbio" tab in the right sidebar that
 * reads workspace sequence files through the host's `workspaceFiles` Remote and
 * draws them IN THE BROWSER. Nothing here goes through a tool call, and the
 * parsing/rendering is the same code the Node plugin runs — the bundle imports
 * the root `.mjs` modules (see build/browser-api.mjs).
 *
 * Registered pieces (all through public seats):
 * - a page tab type in `ctx.sidebarRightTabs` (`kind: 'molbio-panel'`, no
 *   `patterns`, so it is a page opened by kind and appears on the guide page);
 * - its body in the keyed `sidebar.right.pane.tab` seat;
 * - its chip title in `sidebar.right.pane.tab.title`.
 *
 * Seats are claimed with `ctx.slots.inject`, never a bare `ctx.slots.register`:
 * a seat exists only after the entry that OWNS it declares it in its `children`
 * table, and a register() that races that declaration throws out of `apply()` —
 * a failed loader entry, which is the whole Web GUI refusing to boot (see the
 * note above `apply`).
 *
 * The body receives the slot framework's `sessionId`/`actions` injection plus
 * the `useSessions` selector hook the runtime synthesises from the root hook
 * sources (every root hook becomes a `use<Name>` prop for session-scope slots),
 * so the workspace root comes from `useSessions` through
 * `selectSessionDirectory` (panel-core.mjs): the session's `workingDirectory`
 * projection first, the summary's projection values next, `cwd` last — the
 * order DSH 0.2.3's own tab bodies use. This package's own `inject` factory only
 * has to hand over the Remote face.
 *
 * No JSX and no CSS files on purpose: the bundler lowers plain ESM only, and
 * inline styles keep the artifact a single self-contained file — styles injected
 * inside the factory would also have to be torn down by hand on unload.
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import {
  LIBRARY_FILE,
  NCBI_KEY_REF,
  childPath,
  classifyEntry,
  credentialInfo,
  figureCardSummary,
  figureCardView,
  isMolbioDetailSubject,
  remoteFailure,
  decodeWorkspaceBytes,
  filterPapers,
  isOpenable,
  libraryTags,
  logoSvg,
  mapCardSummary,
  mapCardView,
  paperFields,
  paperLink,
  paperSummary,
  parseAlignmentFile,
  parseLibrary,
  parsePlasmidFile,
  parseStructureFile,
  plasmidSvg,
  readWorkspaceText,
  selectSessionDirectory,
  sequenceText,
  sortEntries,
  structureImage,
  DEFAULT_STRUCTURE_VIEW,
  STRUCTURE_ELEMENT_COLORS,
  STRUCTURE_REPRESENTATIONS,
} from './panel-core.mjs';

/** This implementation's identity, and the key its body/title register under. */
const PANEL_ID = 'dsh-molbio-tools';
/** Type discriminator the tab is opened by. */
const PANEL_KIND = 'molbio-panel';
/** The literature tab is a second page type of the same package. */
const PAPERS_ID = 'dsh-molbio-tools/papers';
const PAPERS_KIND = 'molbio-papers';

/**
 * Read one file's raw bytes through the workspace Remote.
 *
 * The FIRST argument is the SessionId `lookup` (`workspaceFileScopeId`), not a
 * scope object: the host declares it with a strict string codec and resolves it
 * to the Session's workspace root on its own — exactly how
 * `ui-sidebar-documentpreview` calls `readBytes(file.sessionId, …)`. Passing
 * `{ sessionId }` here (the shape this panel used until 0.27.1) is rejected by
 * the gateway's argument codec, so EVERY listing and read failed and the panel
 * showed an empty workspace no matter which extensions the files had.
 */
async function readBytes(remote, sessionId, path, signal) {
  const result = await remote.workspaceFiles.readBytes(sessionId, path, { offset: 0, length: 8 * 1024 * 1024 }, signal);
  if (result === null || typeof result !== 'object' || !result.ok) {
    const failure = result !== null && typeof result === 'object' ? result.error : undefined;
    throw new Error(failure?.message ?? `the workspace read of ${path} failed`);
  }
  return decodeWorkspaceBytes(result.value.data);
}

/** List one directory, newest-first ordering rules applied by the caller. */
async function listDirectory(remote, sessionId, path, signal) {
  const result = await remote.workspaceFiles.list(sessionId, path, signal);
  if (result === null || typeof result !== 'object' || !result.ok) {
    const failure = result !== null && typeof result === 'object' ? result.error : undefined;
    throw new Error(failure?.message ?? `the workspace listing of ${path} failed`);
  }
  return sortEntries(result.value.entries ?? []);
}

// ── styles (inline; the artifact stays a single file) ───────────────────────

const styles = {
  root: { display: 'flex', height: '100%', minHeight: '320px', font: '13px/1.5 system-ui, sans-serif', color: 'var(--dsh-text, #1a1a1a)' },
  side: { display: 'flex', flexDirection: 'column', width: '230px', flex: '0 0 230px', borderRight: '1px solid var(--dsh-border, #e3e6ea)', minHeight: 0 },
  search: { margin: '8px 10px 4px', padding: '4px 6px', font: 'inherit', border: '1px solid var(--dsh-border, #e3e6ea)', borderRadius: '4px', background: 'transparent', color: 'inherit' },
  list: { flex: '1 1 auto', overflowY: 'auto', padding: '4px 0 8px' },
  tagRow: { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '4px 10px 6px' },
  tagChip: (active) => ({
    fontSize: '11px',
    padding: '1px 7px',
    borderRadius: '9px',
    cursor: 'pointer',
    border: '1px solid var(--dsh-border, #e3e6ea)',
    background: active ? 'var(--dsh-selected, #eaf2ff)' : 'transparent',
    fontWeight: active ? 600 : 400,
  }),
  listItem: (active) => ({
    padding: '5px 12px',
    cursor: 'pointer',
    background: active ? 'var(--dsh-selected, #eaf2ff)' : 'transparent',
  }),
  listTitle: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listSub: { fontSize: '11px', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listHead: { padding: '4px 12px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.55 },
  main: { flex: '1 1 auto', overflow: 'auto', padding: '12px 16px' },
  detailTitle: { fontSize: '15px', fontWeight: 600, marginBottom: '10px', lineHeight: 1.35 },
  link: { color: 'var(--dsh-link, #2f6fd0)', textDecoration: 'none' },
  fieldKey: { textAlign: 'left', padding: '3px 10px 3px 0', opacity: 0.6, fontWeight: 500, verticalAlign: 'top', whiteSpace: 'nowrap' },
  card: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px', border: '1px solid var(--dsh-border, #e3e6ea)', borderRadius: '6px', background: 'var(--dsh-surface, #ffffff)' },
  cardHead: { fontSize: '12px', fontWeight: 600, opacity: 0.8 },
  cardSvg: { maxWidth: '520px', lineHeight: 0 },
  cardNote: { fontSize: '12px', opacity: 0.6 },
  cardPath: { fontSize: '11px', opacity: 0.45, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' },
  cardButton: { alignSelf: 'flex-start', fontSize: '11px', padding: '2px 8px', cursor: 'pointer', border: '1px solid var(--dsh-border, #e3e6ea)', borderRadius: '4px', background: 'transparent', color: 'inherit' },
  note: { marginTop: '12px', padding: '8px 10px', background: 'var(--dsh-soft, #f6f7f9)', borderRadius: '4px', whiteSpace: 'pre-wrap' },
  idLine: { marginTop: '12px', fontSize: '11px', opacity: 0.45, fontFamily: 'ui-monospace, monospace' },
  meta: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '10px', fontSize: '12px', opacity: 0.8 },
  error: { color: 'var(--dsh-danger, #c0392b)', padding: '10px 12px', whiteSpace: 'pre-wrap' },
  muted: { opacity: 0.6, padding: '10px 12px' },
  svg: { maxWidth: '100%', height: 'auto' },
  svgScroll: {
    overflow: 'auto',
    maxHeight: '68vh',
    padding: '8px',
    border: '1px solid var(--dsh-border, #e3e6ea)',
    borderRadius: '6px',
    background: '#ffffff',
  },
  sequence: {
    margin: 0,
    padding: '10px',
    maxHeight: '68vh',
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: '12px',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    background: 'var(--dsh-soft, #f6f7f9)',
    borderRadius: '6px',
  },
  canvas: { maxWidth: '100%', height: 'auto', display: 'block', border: '1px solid var(--dsh-border, #e3e6ea)', borderRadius: '6px', cursor: 'grab', touchAction: 'none', background: '#f7f9fb' },
  button: (active) => ({
    fontSize: '11px',
    padding: '2px 8px',
    cursor: 'pointer',
    border: '1px solid var(--dsh-border, #e3e6ea)',
    borderRadius: '4px',
    background: active ? 'var(--dsh-selected, #eaf2ff)' : 'transparent',
    fontWeight: active ? 600 : 400,
    color: 'inherit',
  }),
  legend: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px', fontSize: '11px', opacity: 0.75 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
  legendDot: { width: '9px', height: '9px', borderRadius: '50%', display: 'inline-block' },
  table: { borderCollapse: 'collapse', marginTop: '12px', fontSize: '12px', width: '100%' },
  th: { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsh-border, #e3e6ea)', opacity: 0.7, fontWeight: 600 },
  td: { padding: '3px 8px', borderBottom: '1px solid var(--dsh-border-soft, #f0f2f5)' },
};

/** The panel body: a file list on the left, the rendered record on the right. */
function MolbioPanel({ sessionId, remote, useSessions }) {
  const cwd = useSessions((state) => selectSessionDirectory(state, sessionId));
  // The listing never blocks on the store: `'.'` is the Session's workspace
  // root as the HOST resolves it, so a session whose `cwd` is missing from the
  // list snapshot (or arrives after first render) still lists its files. Reads
  // use the same base as the listing so an absent `cwd` cannot mix the two.
  const root = cwd ?? '.';
  const base = cwd ?? '';
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [record, setRecord] = useState(null);
  const [status, setStatus] = useState({ kind: 'loading' });
  const [view, setView] = useState({ ...DEFAULT_STRUCTURE_VIEW });
  // Multi-sequence alignments are drawn at their NATURAL pixel width and the
  // pane scrolls; zoom scales that width. Fitting a 2 000-column logo into the
  // pane is what made long alignments unreadable in the first place.
  const [logoZoom, setLogoZoom] = useState(1);
  const svgNode = useRef(null);
  const svgNatural = useRef({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const svgHost = useRef(null);
  const canvasHost = useRef(null);
  const drag = useRef(null);

  // Directory listing, re-read when the session's workspace root changes.
  useEffect(() => {
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    listDirectory(remote, sessionId, root, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setEntries(rows);
        setStatus({ kind: 'ready' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus({ kind: 'error', message: String(error?.message ?? error) });
      });
    return () => controller.abort();
  }, [root, remote, sessionId]);

  // The selected file, parsed with the plugin's own parsers.
  useEffect(() => {
    if (selected === null) return undefined;
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    readBytes(remote, sessionId, childPath(base, selected.name), controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        const kind = classifyEntry(selected);
        const parsed = kind === 'plasmid'
          ? { kind, ...parsePlasmidFile(selected.name, bytes) }
          : kind === 'alignment'
            ? { kind, ...parseAlignmentFile(bytes) }
            : { kind, ...parseStructureFile(selected.name, bytes) };
        setRecord(parsed);
        // A new structure starts from the same deterministic camera; the
        // previous file's yaw/pitch would be meaningless on a different molecule.
        if (parsed.kind === 'structure') setView({ ...DEFAULT_STRUCTURE_VIEW });
        if (parsed.kind === 'alignment') setLogoZoom(1);
        setStatus({ kind: 'ready' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setRecord(null);
          setStatus({ kind: 'error', message: String(error?.message ?? error) });
        }
      });
    return () => controller.abort();
  }, [selected, cwd, remote, sessionId]);

  // The SVG is generated here (client-side) and attached as real DOM, so it
  // stays interactive and inherits the page's font stack. It lives in its own
  // child container so React's reconciliation of `svgHost` never fights the
  // nodes appended here.
  useEffect(() => {
    const host = svgHost.current;
    if (host === null) return;
    host.replaceChildren();
    svgNode.current = null;
    // A single-sequence FASTA is printed as text (no logo, no SVG host), and a
    // structure owns the canvas instead.
    if (record === null || status.kind !== 'ready' || record.kind === 'structure'
      || (record.kind === 'alignment' && (record.single === true || record.protein === true))) return;
    // The renderer refuses what it cannot draw (renderPlasmidMap caps a map at
    // 200 features). Letting that throw out of the effect leaves the pane empty
    // with no explanation, so it becomes the pane's error state instead.
    let markup;
    try {
      markup = record.kind === 'plasmid' ? plasmidSvg(record) : logoSvg(record);
    } catch (error) {
      setStatus({ kind: 'error', message: String(error?.message ?? error) });
      return;
    }
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    if (parsed.querySelector('parsererror') !== null) {
      setStatus({ kind: 'error', message: 'the generated SVG could not be parsed' });
      return;
    }
    const svg = parsed.documentElement;
    if (record.kind === 'alignment') {
      // Natural size + a scrolling pane: the zoom effect below scales this.
      svgNatural.current = {
        width: Number(svg.getAttribute('width')) || 0,
        height: Number(svg.getAttribute('height')) || 0,
      };
      svg.setAttribute('style', 'display:block');
    } else {
      svgNatural.current = { width: 0, height: 0 };
      svg.setAttribute('style', 'max-width:100%;height:auto');
    }
    svgNode.current = svg;
    host.append(document.importNode(svg, true));
  }, [record, status.kind]);

  // Scale the appended alignment SVG in place: regenerating the markup on every
  // zoom step would re-run the alignment's composition for no reason.
  useEffect(() => {
    const svg = svgNode.current;
    const natural = svgNatural.current;
    if (svg === null || natural.width === 0) return;
    if (record === null || record.kind !== 'alignment' || record.single === true) return;
    svg.setAttribute('width', String(Math.max(1, Math.round(natural.width * logoZoom))));
    svg.setAttribute('height', String(Math.max(1, Math.round(natural.height * logoZoom))));
  }, [logoZoom, record, status.kind]);

  // Structures are rasterized into an RGB buffer and painted into a canvas.
  // The renderer is deterministic and shared with the Node tests; only the
  // canvas plumbing lives here. During a drag the frame drops to 1x
  // supersampling and returns to 2x when the pointer is released.
  useEffect(() => {
    if (record === null || record.kind !== 'structure' || status.kind !== 'ready') return;
    const canvas = canvasHost.current;
    if (canvas === null || typeof canvas.getContext !== 'function') return;
    const context = canvas.getContext('2d');
    if (context === null || typeof context.createImageData !== 'function') return;
    const width = Number.isInteger(canvas.width) ? canvas.width : 640;
    const height = Number.isInteger(canvas.height) ? canvas.height : 480;
    let image;
    try {
      image = structureImage(record, {
        width,
        height,
        yaw: view.yaw,
        pitch: view.pitch,
        zoom: view.zoom,
        representation: view.representation,
        // Large assemblies stay at interaction quality even when settled;
        // 2× sampling is reserved for the small structures it visibly helps.
        supersample: dragging || record.atoms.length > 4000 ? 1 : 2,
      });
    } catch (error) {
      setStatus({ kind: 'error', message: String(error?.message ?? error) });
      return;
    }
    const imageData = context.createImageData(width, height);
    for (let source = 0, target = 0; source < image.rgb.length; source += 3, target += 4) {
      imageData.data[target] = image.rgb[source];
      imageData.data[target + 1] = image.rgb[source + 1];
      imageData.data[target + 2] = image.rgb[source + 2];
      imageData.data[target + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
  }, [record, status.kind, view, dragging]);

  const startDrag = (event) => {
    if (typeof event?.currentTarget?.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer without capture support is still draggable.
      }
    }
    drag.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
    setDragging(true);
  };

  const moveDrag = (event) => {
    const start = drag.current;
    if (start === null) return;
    const yaw = start.yaw + (event.clientX - start.x) * 0.01;
    const pitch = Math.max(-1.4, Math.min(1.4, start.pitch - (event.clientY - start.y) * 0.01));
    setView((current) => ({ ...current, yaw, pitch }));
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const zoomView = (event) => {
    // preventDefault keeps the sidebar from scrolling while the wheel zooms.
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setView((current) => ({
      ...current,
      zoom: Math.max(0.35, Math.min(5, current.zoom * Math.exp(-Number(event.deltaY ?? 0) * 0.001))),
    }));
  };

  const resetView = () => setView({ ...DEFAULT_STRUCTURE_VIEW });

  const openable = useMemo(() => entries.filter(isOpenable), [entries]);

  // The header names the directory being listed. Without it a wrong/empty
  // workspace is indistinguishable from "the panel is broken", which is how a
  // missing `cwd` stayed invisible through a restart.
  const head = h('div', { style: styles.listHead },
    h('div', null, 'Sequence & structure files'),
    h('div', { style: styles.listSub, title: root }, cwd ?? 'session workspace'),
    h('div', { style: styles.listSub }, openable.length === 0 ? 'no openable files' : `${openable.length} file(s)`));
  const list = h(
    'div',
    { style: styles.list },
    head,
    ...(openable.length === 0
      ? [h('div', { key: 'none', style: styles.muted }, 'No .dna / .gb / .gbk / .fasta / .pdb / .cif / .sdf files in this workspace')]
      : openable.map((entry) => {
        const kind = classifyEntry(entry);
        return h(
          'div',
          {
            key: entry.name,
            style: styles.listItem(selected?.name === entry.name),
            title: `${entry.name} (${kind})`,
            onClick: () => setSelected(entry),
          },
          entry.name,
        );
      })),
  );

  const body = [];
  if (status.kind === 'error') body.push(h('div', { key: 'err', style: styles.error }, status.message));
  if (status.kind === 'loading') body.push(h('div', { key: 'load', style: styles.muted }, 'Reading…'));
  if (status.kind === 'ready' && record === null) {
    body.push(h('div', { key: 'hint', style: styles.muted }, 'Pick a file to draw it here.'));
  }
  if (status.kind === 'ready' && record !== null && record.kind === 'plasmid') {
    body.push(h('div', { key: 'meta', style: styles.meta },
      h('span', null, record.name),
      h('span', null, `${record.length} bp`),
      h('span', null, record.topology),
      h('span', null, `${record.features.length} feature(s)`)));
    body.push(h('div', { key: 'svg', ref: svgHost, style: styles.svg }));
    if (record.features.length > 0) {
      // The slice cannot bite: renderPlasmidMap refuses more than 200 features,
      // so a record that reaches here has at most that many. It stays as the
      // table's own bound (the map's cap is a renderer rule, not a display one).
      body.push(h('table', { key: 'table', style: styles.table },
        h('thead', null, h('tr', null,
          h('th', { style: styles.th }, 'Feature'),
          h('th', { style: styles.th }, 'Type'),
          h('th', { style: styles.th }, 'Start'),
          h('th', { style: styles.th }, 'End'),
          h('th', { style: styles.th }, 'Strand'))),
        h('tbody', null, ...record.features.slice(0, 200).map((feature, index) => h('tr', { key: `${feature.label}-${index}` },
          h('td', { style: styles.td }, String(feature.label ?? '')),
          h('td', { style: styles.td }, String(feature.type ?? '')),
          h('td', { style: styles.td }, String(feature.start)),
          h('td', { style: styles.td }, String(feature.end)),
          h('td', { style: styles.td }, feature.strand === -1 ? '−' : '+'))))));
    }
  }
  if (status.kind === 'ready' && record !== null && record.kind === 'alignment') {
    if (record.protein === true) {
      // Protein FASTA: the aligner and the logo are nucleotide-only. Saying so
      // beats the old behaviour, which aligned amino acids as if they were DNA
      // ambiguity codes and drew a logo with most letters dropped.
      body.push(h('div', { key: 'meta', style: styles.meta },
        h('span', null, `${record.rows.length} sequence(s)`),
        h('span', null, 'not nucleotide')));
      body.push(h('div', { key: 'notice', style: styles.note },
        'This FASTA is not a nucleotide (IUPAC DNA) file. The sequence logo aligns nucleotide sequences only, '
        + 'so these sequences are shown as plain text and are NOT aligned.'));
      body.push(h('pre', { key: 'sequence', style: styles.sequence }, sequenceText(record)));
    } else if (record.single === true) {
      // One sequence is DATA, not an alignment: print it (wrapped) instead of
      // drawing a one-glyph-per-column logo that shrinks to noise on a long
      // sequence. No zoom controls are needed for text.
      body.push(h('div', { key: 'meta', style: styles.meta },
        h('span', null, '1 sequence'),
        h('span', null, `${record.rows[0]?.length ?? 0} residues`)));
      body.push(h('pre', { key: 'sequence', style: styles.sequence }, sequenceText(record)));
    } else {
      body.push(h('div', { key: 'meta', style: styles.meta },
        h('span', null, `${record.rows.length} sequences`),
        h('span', null, `${record.rows[0]?.length ?? 0} aligned columns`)));
      body.push(h('div', { key: 'zoom', style: styles.meta },
        h('button', {
          key: 'out',
          style: styles.button(false),
          title: 'Zoom out',
          onClick: () => setLogoZoom((value) => Math.max(0.1, value / 1.25)),
        }, '−'),
        h('span', { key: 'level', style: { minWidth: '48px', textAlign: 'center' } }, `${Math.round(logoZoom * 100)}%`),
        h('button', {
          key: 'in',
          style: styles.button(false),
          title: 'Zoom in',
          onClick: () => setLogoZoom((value) => Math.min(8, value * 1.25)),
        }, '+'),
        h('button', { key: 'reset', style: styles.button(false), title: 'Actual size', onClick: () => setLogoZoom(1) }, 'Reset')));
      body.push(h('div', { key: 'svg-scroll', style: styles.svgScroll },
        h('div', { key: 'svg', ref: svgHost, style: { lineHeight: 0 } })));
    }
  }
  if (status.kind === 'ready' && record !== null && record.kind === 'structure') {
    body.push(h('div', { key: 'meta', style: styles.meta },
      h('span', null, record.title === '' ? record.name : record.title),
      h('span', null, record.format.toUpperCase()),
      h('span', null, `${record.atoms.length} atoms`),
      h('span', null, `${record.chain_count} chain(s)`),
      h('span', null, `${record.residue_count} residue(s)`)));
    body.push(h('div', { key: 'controls', style: styles.meta },
      ...STRUCTURE_REPRESENTATIONS.map((representation) => h('button', {
        key: representation,
        style: styles.button(view.representation === representation),
        onClick: () => setView((current) => ({ ...current, representation })),
      }, representation === 'ball-and-stick' ? 'Ball & stick' : 'Space filling')),
      h('button', { key: 'reset', style: styles.button(false), onClick: resetView }, 'Reset view')));
    body.push(h('canvas', {
      key: 'canvas',
      ref: canvasHost,
      width: 640,
      height: 480,
      style: styles.canvas,
      onPointerDown: startDrag,
      onPointerMove: moveDrag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onWheel: zoomView,
      onDoubleClick: resetView,
      'aria-label': '3D structure preview; drag to rotate, wheel to zoom',
    }));
    body.push(h('div', { key: 'legend', style: styles.legend },
      ...['C', 'N', 'O', 'S', 'P'].map((element) => h('span', { key: element, style: styles.legendItem },
        h('span', { style: { ...styles.legendDot, background: STRUCTURE_ELEMENT_COLORS[element] } }),
        element))));
    body.push(h('div', { key: 'note', style: styles.note }, 'Software-rendered 3D model. Drag to rotate, wheel to zoom. Ball-and-stick / space-filling; not for measurements.'));
  }

  return h('div', { style: styles.root }, list, h('div', { style: styles.main }, ...body));
}

/** The chip text; the registry captures it at open time. */
function panelTitle() {
  return 'Molbio';
}

/** The literature tab's chip text. */
function papersTitle() {
  return 'Papers';
}

/** The tool names whose transcript card this package draws (plasmid maps). */
const MAP_TOOL_KEYS = ['molbio_plasmid_map', 'molbio_plasmid_map_file'];
/** Figure tools: a drawn logo / gRNA map plus (for gRNA) the ranked list. */
const FIGURE_TOOL_KEYS = ['molbio_sequence_logo', 'molbio_grna_design'];

/**
 * The transcript card for the map tools (`tool.call.toolview`, keyed by tool
 * name). It replaces the generic tool row for `molbio_plasmid_map` and
 * `molbio_plasmid_map_file`, drawing the map the call produced in the
 * conversation instead of asking the reader to open a file.
 *
 * The card is a pure function of the block its owner hands it: `block.meta` is
 * the projection the tool declared (`mapCardMeta` in index.mjs) and
 * `block.content` the text the model saw. Everything is read defensively, so a
 * call from an older version, another tool, a running call, or a failed run
 * degrades to a notice instead of breaking the transcript.
 */
function MolbioMapCard({ block, inspect }) {
  const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
  const view = mapCardView(settled ? block.meta : undefined);
  const host = useRef(null);
  const svg = view.kind === 'map' ? view.svg : '';
  // The markup can pass `mapCardView`'s boundary check and still not be
  // parseable — it is a string that travelled through the session log. Failing to
  // parse used to leave the header claiming "N feature(s)" above an empty body,
  // with nothing to explain it.
  const [drawError, setDrawError] = useState(null);

  // The markup is parsed and inserted as real DOM, exactly as in the panels:
  // the SVG stays selectable and inherits the page's font stack.
  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    node.replaceChildren();
    if (svg === '') return;
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror') !== null) {
      setDrawError('the map markup could not be parsed as SVG');
      return;
    }
    setDrawError(null);
    const element = parsed.documentElement;
    element.setAttribute('style', 'width:100%;height:auto;max-width:520px');
    node.append(document.importNode(element, true));
  }, [svg]);

  const head = settled
    ? mapCardSummary(view)
    : 'Drawing the map…';
  const content = [h('div', { key: 'head', style: styles.cardHead }, head)];
  if (view.kind === 'map') {
    // The host stays mounted whatever happens, so the ref is still valid when
    // the markup changes; the notice sits above the (empty) drawing area.
    if (drawError !== null) content.push(h('div', { key: 'drawerr', style: styles.cardNote }, drawError));
    content.push(h('div', { key: 'svg', ref: host, style: styles.cardSvg }));
  } else {
    content.push(h('div', { key: 'note', style: styles.cardNote }, view.message));
  }
  if (view.svgPath !== '') content.push(h('div', { key: 'path', style: styles.cardPath }, view.svgPath));
  if (settled && block.isError === true) {
    const text = (Array.isArray(block.content) ? block.content : [])
      .map((item) => (item !== null && typeof item === 'object' && item.type === 'text' ? String(item.text ?? '') : ''))
      .join('\n')
      .trim();
    content.push(h('div', { key: 'err', style: styles.error }, text === '' ? 'The call failed.' : text));
    if (typeof inspect === 'function') {
      content.push(h('button', { key: 'inspect', style: styles.cardButton, onClick: () => inspect() }, 'Inspect'));
    }
  }
  return h('div', { style: styles.card }, ...content);
}

/**
 * The transcript card for the sequence-logo and gRNA tools. The logo card draws
 * the logo; the gRNA card draws the map when `map_path` was requested AND lists
 * the top-ranked guides (a gRNA call without a map still gets the table). Like
 * the map card it is a pure function of the block, and everything it reads is
 * validated and bounded by `figureCardView`.
 */
function MolbioFigureCard({ block, inspect }) {
  const settled = block !== null && typeof block === 'object' && block.kind === 'tool-result';
  const view = figureCardView(settled ? block.meta : undefined);
  const host = useRef(null);
  const svg = view.kind === 'figure' ? view.svg : '';
  const [drawError, setDrawError] = useState(null);

  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    node.replaceChildren();
    if (svg === '') return;
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror') !== null) {
      setDrawError('the figure markup could not be parsed as SVG');
      return;
    }
    setDrawError(null);
    const element = parsed.documentElement;
    element.setAttribute('style', 'width:100%;height:auto;max-width:640px');
    node.append(document.importNode(element, true));
  }, [svg]);

  const content = [h('div', { key: 'head', style: styles.cardHead }, settled ? figureCardSummary(view) : 'Drawing the figure…')];
  if (view.kind === 'figure') {
    if (drawError !== null) content.push(h('div', { key: 'drawerr', style: styles.cardNote }, drawError));
    content.push(h('div', { key: 'svg', ref: host, style: styles.cardSvg }));
  } else {
    content.push(h('div', { key: 'note', style: styles.cardNote }, view.message));
  }
  if (view.guides.length > 0) {
    const head = ['#', 'Guide', 'PAM', 'Position', 'Score', 'Off-targets'];
    const rows = view.guides.map((guide) => h('tr', { key: guide.rank },
      h('td', { style: styles.td }, String(guide.rank)),
      h('td', { style: styles.td }, guide.sequence),
      h('td', { style: styles.td }, guide.pam === '' ? '—' : guide.pam),
      h('td', { style: styles.td }, `${guide.strand === 'reverse' ? '−' : '+'}${guide.start}-${guide.end}`),
      h('td', { style: styles.td }, String(guide.score)),
      h('td', { style: styles.td }, String(guide.offTargets)),
    ));
    content.push(h('table', { key: 'guides', style: styles.table },
      h('thead', null, h('tr', null, ...head.map((label) => h('th', { key: label, style: styles.th }, label)))),
      h('tbody', null, ...rows)));
  }
  if (view.svgPath !== '') content.push(h('div', { key: 'path', style: styles.cardPath }, view.svgPath));
  if (view.csvPath !== '') content.push(h('div', { key: 'csv', style: styles.cardPath }, view.csvPath));
  if (settled && block.isError === true) {
    const text = (Array.isArray(block.content) ? block.content : [])
      .map((item) => (item !== null && typeof item === 'object' && item.type === 'text' ? String(item.text ?? '') : ''))
      .join('\n')
      .trim();
    content.push(h('div', { key: 'err', style: styles.error }, text === '' ? 'The call failed.' : text));
    if (typeof inspect === 'function') {
      content.push(h('button', { key: 'inspect', style: styles.cardButton, onClick: () => inspect() }, 'Inspect'));
    }
  }
  return h('div', { style: styles.card }, ...content);
}

/**
 * The literature panel: the workspace `papers.json` the molbio_paper_* tools
 * maintain, rendered as a searchable reading list with a detail pane.
 *
 * Read-only by design: writing would need the dedupe/merge semantics of
 * molbio_paper_add|update, which are multi-call tools whose concurrency
 * contract is "not safe" — a panel writing the same file behind them would have
 * to reimplement that contract to avoid lost updates. The panel points at the
 * tools instead (see EMPTY_HINT).
 */
function PapersPanel({ sessionId, remote, useSessions }) {
  // The library path is WORKSPACE-RELATIVE, matching how the tools resolve it
  // (papers.mjs `workspaceFilePath` joins `workspaceRoot`, the sandbox root,
  // not the session cwd). Building it from `cwd` read the wrong file whenever
  // those two differ. `useSessions` stays in the signature because the slot
  // runtime provides it (and the contract pins that); this panel needs no path
  // from the store — a useless `cwd` is what the property is for.
  const libraryPath = LIBRARY_FILE;
  const [papers, setPapers] = useState([]);
  const [status, setStatus] = useState({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const keyState = useNcbiKeyState();
  const keyView = ncbiKeyView(keyState);

  useEffect(() => {
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    readWorkspaceText(remote, sessionId, libraryPath, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === 'missing') {
          setPapers([]);
          setStatus({ kind: 'empty' });
          return;
        }
        if (result.kind === 'error') {
          setStatus({ kind: 'error', message: result.message });
          return;
        }
        try {
          setPapers(parseLibrary(result.text).papers);
          setStatus({ kind: 'ready' });
        } catch (error) {
          setStatus({ kind: 'error', message: String(error?.message ?? error) });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus({ kind: 'error', message: String(error?.message ?? error) });
      });
    return () => controller.abort();
  }, [libraryPath, remote, sessionId]);

  const tags = useMemo(() => libraryTags(papers), [papers]);
  const visible = useMemo(() => filterPapers(papers, { query, tag }), [papers, query, tag]);
  const selected = visible.find((paper) => paper.id === selectedId) ?? visible[0];

  const search = h('input', {
    type: 'search',
    value: query,
    placeholder: 'Search title, author, journal, note…',
    onChange: (event) => setQuery(event.target.value),
    style: styles.search,
  });

  const tagRow = tags.length === 0 ? null : h('div', { style: styles.tagRow },
    h('span', {
      style: styles.tagChip(tag === ''),
      onClick: () => setTag(''),
    }, 'all'),
    ...tags.map((entry) => h('span', {
      key: entry.tag,
      style: styles.tagChip(tag === entry.tag),
      title: `${entry.count} paper(s)`,
      onClick: () => setTag(tag === entry.tag ? '' : entry.tag),
    }, `${entry.tag} (${entry.count})`)));

  // The list only speaks once the library actually resolved: while loading, or
  // after a failed read/parse, claiming "no papers" would state something the
  // panel does not know.
  const listReady = status.kind === 'ready' || status.kind === 'empty';
  const list = h('div', { style: styles.list },
    h('div', { style: styles.listHead }, listReady ? `Papers (${visible.length}${visible.length === papers.length ? '' : ` / ${papers.length}`})` : 'Papers'),
    ...(!listReady
      ? []
      : visible.length === 0
        ? [h('div', { key: 'none', style: styles.muted }, papers.length === 0 ? 'No papers in the library yet' : 'No paper matches this filter')]
        : visible.map((paper) => h('div', {
          key: paper.id ?? paper.title,
          style: styles.listItem(selected?.id === paper.id),
          title: paper.title,
          onClick: () => setSelectedId(paper.id),
        },
        h('div', { style: styles.listTitle }, String(paper.title ?? '(untitled)')),
        h('div', { style: styles.listSub }, paperSummary(paper))))));

  const detail = [];
  if (status.kind === 'loading') detail.push(h('div', { key: 'load', style: styles.muted }, 'Reading papers.json…'));
  if (status.kind === 'error') detail.push(h('div', { key: 'err', style: styles.error }, status.message));
  if (status.kind === 'empty') {
    detail.push(h('div', { key: 'hint', style: styles.muted },
      `No ${LIBRARY_FILE} in this workspace. Add papers with molbio_paper_add (or molbio_pubmed_search first); the file appears here once it exists.`));
  }
  if (status.kind === 'ready' && selected !== undefined) {
    const link = paperLink(selected);
    detail.push(h('div', { key: 'title', style: styles.detailTitle },
      link === undefined ? String(selected.title) : h('a', { href: link, target: '_blank', rel: 'noreferrer', style: styles.link }, String(selected.title))));
    detail.push(h('table', { key: 'fields', style: styles.table },
      h('tbody', null, ...paperFields(selected).map((field) => h('tr', { key: field.key },
        h('th', { style: styles.fieldKey }, field.label),
        h('td', { style: styles.td }, field.value))))));
    if (Array.isArray(selected.tags) && selected.tags.length > 0) {
      detail.push(h('div', { key: 'tags', style: styles.tagRow }, ...selected.tags.map((entry) => h('span', { key: entry, style: styles.tagChip(false) }, entry))));
    }
    if (typeof selected.note === 'string' && selected.note !== '') {
      detail.push(h('div', { key: 'note', style: styles.note }, selected.note));
    }
    detail.push(h('div', { key: 'id', style: styles.idLine }, `id: ${selected.id ?? '(none)'}`));
  }
  if (status.kind === 'ready' && selected === undefined) {
    detail.push(h('div', { key: 'pick', style: styles.muted }, 'Pick a paper to read its details.'));
  }

  return h('div', { style: styles.root },
    h('div', { style: styles.side },
      h('div', {
        key: 'ncbi-key',
        'data-molbio-key-badge': keyView.tone,
        title: keyState.message === '' ? keyView.label : keyState.message,
        style: keyStyles.badge(keyView.tone),
      },
      h('span', { style: keyStyles.badgeDot(keyView.tone) }),
      h('span', null, keyView.label)),
      search,
      tagRow,
      list),
    h('div', { style: styles.main }, ...detail));
}

/** The state of the PubMed key, read from the host's credential store. */
async function readNcbiKey(remote) {
  if (remote?.credentials === undefined || typeof remote.credentials.describe !== 'function') {
    return { phase: 'error', configured: false, writable: false, message: 'This deployment exposes no credentials Remote (the settings controller is not mounted).' };
  }
  let response;
  try {
    response = await remote.credentials.describe([NCBI_KEY_REF]);
  } catch (error) {
    response = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
  }
  const failure = remoteFailure(response);
  if (failure !== '') return { phase: 'error', configured: false, writable: false, message: failure };
  return { phase: 'ready', ...credentialInfo(response, NCBI_KEY_REF), message: '' };
}

/**
 * The last known state of the PubMed key, shared by every surface that shows it.
 *
 * The detail section reads the credential store directly because `apply` gates
 * it behind `ctx.inject(['remote.credentials'])`. The papers tab body is
 * registered unconditionally — a deployment without the credentials namespace
 * still gets the tab — so it cannot read that namespace itself. This
 * module-level snapshot is written by the gated reader and by the detail
 * section's own reads, and the host's `credentials/reference-updated` event
 * refreshes it, so the badge appears (and disappears) the moment a key is saved
 * or removed anywhere, without reopening the tab.
 */
const ncbiKeyStore = {
  // 'unavailable' until the gated reader publishes a real answer: a deployment
  // with no credentials namespace never gets one, and the badge must not sit on
  // "checking" forever there.
  state: { phase: 'unavailable', configured: false, writable: false, message: '' },
  listeners: new Set(),
  reload: undefined,
};

/** Publish a key snapshot to every mounted surface. */
function publishNcbiKey(next) {
  ncbiKeyStore.state = next;
  for (const listener of [...ncbiKeyStore.listeners]) listener(next);
}

/** Subscribe a surface to snapshot changes; returns the unsubscribe function. */
function subscribeNcbiKey(listener) {
  ncbiKeyStore.listeners.add(listener);
  return () => { ncbiKeyStore.listeners.delete(listener); };
}

/** Tone and label for a PubMed-key snapshot (the badge is a plain div). */
function ncbiKeyView(state) {
  const tone = state.phase === 'ready'
    ? (state.configured ? 'on' : 'off')
    : state.phase === 'pending' ? 'pending' : 'error';
  const label = state.phase === 'ready'
    ? (state.configured
      ? `PubMed API key configured${state.source === undefined ? '' : ` (source: ${state.source})`}`
      : 'PubMed API key not configured in the credential store — environment keys still apply')
    : state.phase === 'pending'
      ? 'Checking the PubMed API key…'
      : 'PubMed API key status unavailable';
  return { tone, label };
}

/**
 * The live PubMed-key snapshot for a panel surface.
 *
 * The detail section's status line only exists while the Plugins page is open;
 * the papers tab shows this instead, so a configured key is visible where the
 * literature work actually happens. It never shows the value — only whether the
 * store reports one configured, and where it came from.
 */
function useNcbiKeyState() {
  const [state, setState] = useState(ncbiKeyStore.state);
  useEffect(() => {
    const unsubscribe = subscribeNcbiKey(setState);
    // Catch a publish that landed between render and subscribe, and re-read on
    // mount: the tab can be opened long after the gate's first read, and a key
    // may have been added through Settings in the meantime.
    setState(ncbiKeyStore.state);
    if (typeof ncbiKeyStore.reload === 'function') ncbiKeyStore.reload();
    return unsubscribe;
  }, []);
  return state;
}

const keyStyles = {
  section: { borderTop: '1px solid rgba(127, 127, 127, 0.28)', marginTop: 16, paddingTop: 12, display: 'grid', gap: 8 },
  title: { margin: 0, fontSize: 14 },
  note: { margin: 0, fontSize: 12, opacity: 0.75, lineHeight: 1.5 },
  status: { margin: 0, fontSize: 12 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: '1 1 240px', minWidth: 200, padding: '4px 8px' },
  message: { margin: 0, fontSize: 12 },
  badge: (tone) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    margin: '8px 10px 0',
    padding: '3px 8px',
    borderRadius: '10px',
    fontSize: '11px',
    lineHeight: 1.4,
    border: `1px solid ${tone === 'on' ? 'rgba(46, 125, 50, 0.45)' : tone === 'error' ? 'rgba(192, 57, 43, 0.45)' : 'var(--dsh-border, #e3e6ea)'}`,
    background: tone === 'on' ? 'rgba(46, 125, 50, 0.10)' : 'transparent',
    color: 'inherit',
  }),
  badgeDot: (tone) => ({
    width: '7px',
    height: '7px',
    flex: '0 0 7px',
    borderRadius: '50%',
    background: tone === 'on' ? '#2e7d32' : tone === 'error' ? '#c0392b' : tone === 'pending' ? '#b58900' : '#9aa4ad',
  }),
};

/**
 * The Plugins → installed plugin → detail section that stores the NCBI key.
 *
 * It renders only for this package's own subject (bundle page, or one of the
 * row pages the bundle declares) and returns null everywhere else, which is the
 * contract `plugins.detail.section` asks a contribution to honour. The value is
 * write-only from here: `credentials.describe` answers whether a key is
 * configured and where it came from, never the key itself.
 */
function NcbiKeySection({ subject, remote }) {
  const [draft, setDraft] = useState('');
  const [state, setState] = useState({ phase: 'loading', configured: false, writable: true, message: '' });
  const subjectToken = isMolbioDetailSubject(subject)
    ? `${subject.kind}:${subject.pkg.name}:${subject.row?.rowId ?? ''}`
    : '';
  useEffect(() => {
    if (subjectToken === '') return undefined;
    let live = true;
    // Publishing the read into the shared snapshot is what keeps the papers
    // tab's badge honest: this section can be unmounted and remounted, and the
    // badge must not go stale in between.
    const load = () => readNcbiKey(remote).then((next) => {
      if (!live) return;
      setState(next);
      publishNcbiKey(next);
    });
    load();
    // Another surface may rotate or clear the same reference (Settings, the
    // file watcher); follow the host event instead of showing a stale badge.
    const off = typeof remote?.$on === 'function'
      ? remote.$on('credentials/reference-updated', (ref) => { if (ref === NCBI_KEY_REF) load(); })
      : undefined;
    return () => {
      live = false;
      if (typeof off === 'function') off();
    };
  }, [remote, subjectToken]);
  if (!isMolbioDetailSubject(subject)) return null;
  const busy = state.phase === 'saving';
  const save = async () => {
    const value = draft.trim();
    if (value === '') return;
    if (remote?.credentials === undefined || typeof remote.credentials.set !== 'function') {
      setState((previous) => ({ ...previous, phase: 'error', message: 'This deployment exposes no credentials Remote (the settings controller is not mounted).' }));
      return;
    }
    setState((previous) => ({ ...previous, phase: 'saving', message: '' }));
    let response;
    try {
      response = await remote.credentials.set(NCBI_KEY_REF, value);
    } catch (error) {
      response = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    const failure = remoteFailure(response);
    setDraft('');
    const next = await readNcbiKey(remote);
    const nextState = failure !== ''
      ? { ...next, phase: 'error', message: failure }
      : next.phase === 'error'
        ? next
        : next.configured === true
          ? { ...next, message: 'Saved. The next PubMed call uses this key.' }
          : { ...next, phase: 'error', message: 'The host accepted the write but still reports no key configured. Restart the profile and try again.' };
    setState(nextState);
    publishNcbiKey(nextState);
  };
  const remove = async () => {
    if (remote?.credentials === undefined || typeof remote.credentials.unset !== 'function') {
      setState((previous) => ({ ...previous, phase: 'error', message: 'This deployment exposes no credentials Remote (the settings controller is not mounted).' }));
      return;
    }
    setState((previous) => ({ ...previous, phase: 'saving', message: '' }));
    let response;
    try {
      response = await remote.credentials.unset(NCBI_KEY_REF);
    } catch (error) {
      response = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    const failure = remoteFailure(response);
    const next = await readNcbiKey(remote);
    const nextState = failure !== ''
      ? { ...next, phase: 'error', message: failure }
      : next.phase === 'error'
        ? next
        : next.configured === false
          ? { ...next, message: 'Removed. PubMed search falls back to web search.' }
          : { ...next, phase: 'error', message: 'The host still reports a key configured after Remove.' };
    setState(nextState);
    publishNcbiKey(nextState);
  };
  const status = state.phase === 'loading'
    ? 'Checking the credential store…'
    : state.phase === 'error'
      ? 'Unavailable'
      : state.configured
        ? `Configured${state.source === undefined ? '' : ` (source: ${state.source})`}`
        : 'Not configured';
  return h('section', { 'data-molbio-ncbi-key': '', style: keyStyles.section },
    h('h4', { style: keyStyles.title }, 'PubMed API key'),
    h('p', { style: keyStyles.note }, 
      'Stored in the harness credential store. molbio_pubmed_search and molbio_pubmed_abstract use it for the official PubMed E-utilities API; without it they fall back to web search.'),
    h('div', { 'data-molbio-key-status': state.phase, style: { ...keyStyles.badge(ncbiKeyView(state).tone), margin: 0 } },
      h('span', { style: keyStyles.badgeDot(ncbiKeyView(state).tone) }),
      h('span', null, status)),
    h('div', { style: keyStyles.row },
      h('input', {
        type: 'password',
        value: draft,
        placeholder: 'NCBI API key (36 characters)',
        autoComplete: 'off',
        spellCheck: false,
        'aria-label': 'NCBI API key',
        style: keyStyles.input,
        onChange: (event) => setDraft(event.target.value),
      }),
      h('button', { type: 'button', disabled: busy || state.writable === false || draft.trim() === '', onClick: save },
        busy ? 'Saving…' : 'Save'),
      h('button', { type: 'button', disabled: busy || state.writable === false || state.configured !== true, onClick: remove }, 'Remove')),
    state.message === '' ? null : h('p', { 'data-molbio-key-message': '', role: 'status', style: keyStyles.message }, state.message),
    h('p', { style: keyStyles.note },
      'Create a key under NCBI → Account Settings → API Key Management. Prefer this over an environment variable: the store is not inherited by shell commands.'));
}

/** Required browser services. */
// `remote.workspaceFiles` is a namespace sub-service, not a plain property:
// every shipped consumer (ui-sidebar-files, ui-sidebar-documentpreview,
// ui-reference, ui-open-in-app) injects it beside `remote`, and this package
// used to declare only `remote`. Waiting for the namespace is what makes
// `ctx.remote.workspaceFiles` usable the moment `apply()` runs and the panels
// render; without it the lookup is a race the panel cannot report.
const inject = ['slots', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'];

/**
 * Claim seats through `ctx.slots.inject`, never a bare `ctx.slots.register` —
 * the shape every shipped package uses (see ui-sidebar-documentpreview, which
 * wraps this exact effect/inject/register triple).
 *
 * A seat only EXISTS once the entry that owns it declares it in its `children`
 * table: `sidebar.right.pane.tab` is declared by the right sidebar's
 * `rightbar.session` entry, and `tool.call.toolview` is a CHILD of ui-tool's
 * `conversation.chat.node` entry. A `register()` that runs before that owner
 * throws the shell's SlotCore guard
 *
 *   slot "<seat>" is not declared (a parent entry's children table must declare it)
 *
 * out of THIS package's `apply()`, and a throwing client entry is a failed
 * LOADER entry — the HARNESS "Failed to load plugins" banner, i.e. no boot at
 * all, not merely a missing tab. Nothing orders our client entry against
 * ui-tool or ui-sidebar-right in the boot graph, so waiting is not a nicety
 * here; `inject` runs the callback synchronously once the seat is declared (and
 * again after every re-declaration) and disposes its contributions with this
 * fiber. Every shipped package claims these same seats this way.
 *
 * Client plugin body: register the tab type, its body, and its chip title.
 * @param ctx - client root context carrying the registries and the Remote carrier.
 */
function apply(ctx) {
  const remote = ctx.remote;
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PANEL_ID,
    kind: PANEL_KIND,
    title: panelTitle,
    guide: [{
      order: 40,
      title: () => 'Molbio',
      description: () => 'Draw a plasmid map or a sequence logo from workspace files',
    }],
  }), 'molbio panel: tab type');
  // The body's own injection carries the Remote face; `sessionId` and the
  // framework's `useSessions` hook arrive from the slot runtime itself (every
  // root hook source becomes a `use<Name>` prop), so neither is re-declared.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PANEL_ID,
    inject: () => ({ remote }),
  }, MolbioPanel)), 'molbio panel: tab body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: PANEL_ID,
  }, panelTitle)), 'molbio panel: tab title');
  // The literature tab: a second page type from the same package. Each guide
  // entry opens its own tab, so the two panels coexist in one session.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PAPERS_ID,
    kind: PAPERS_KIND,
    title: papersTitle,
    guide: [{
      order: 41,
      title: () => 'Papers',
      description: () => 'Read the workspace papers.json library',
    }],
  }), 'molbio panel: papers tab type');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PAPERS_ID,
    inject: () => ({ remote }),
  }, PapersPanel)), 'molbio panel: papers tab body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: PAPERS_ID,
  }, papersTitle)), 'molbio panel: papers tab title');
  // Transcript cards: the map tools draw their map in the conversation. The
  // seat is keyed by tool name and an unclaimed key falls back to the generic
  // tool row, so this is additive for our own tools only. Both keys are
  // claimed through their own waits, so a re-declaration of the seat re-runs
  // both and one key can never be lost by the other's failure.
  for (const toolName of MAP_TOOL_KEYS) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: toolName,
    }, MolbioMapCard)), `molbio panel: ${toolName} card`);
  }
  // Figure cards: the sequence-logo and gRNA tools declare a `molbio-figure`
  // projection; the same component draws a logo or a gRNA map and, for gRNA,
  // lists the top-ranked guides even when no map was requested.
  for (const toolName of FIGURE_TOOL_KEYS) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: toolName,
    }, MolbioFigureCard)), `molbio panel: ${toolName} card`);
  }
  // Plugins -> the installed plugin's detail page: the one place a user can
  // store the NCBI key without editing a YAML file or exporting a variable.
  //
  // `remote.credentials` is a FIBER INJECTION, not merely a property on the
  // Remote carrier: the shipped settings pages declare it in `inject` for the
  // same reason. Without the declaration `ctx.remote.credentials` is undefined,
  // which is exactly how the first build of this section made Save a no-op.
  // The gate keeps the panel working in deployments that expose no credentials
  // namespace: the section simply never registers there.
  ctx.effect(() => {
    const gate = ctx.inject(['remote.credentials'], (keyCtx) => {
      // Keep the shared badge snapshot current: read once, then follow the host
      // event a Save/Remove (here or in Settings) emits for this reference.
      const load = () => readNcbiKey(keyCtx.remote).then(publishNcbiKey);
      keyCtx.effect(() => {
        ncbiKeyStore.reload = load;
        load();
        const off = typeof keyCtx.remote.$on === 'function'
          ? keyCtx.remote.$on('credentials/reference-updated', (ref) => { if (ref === NCBI_KEY_REF) load(); })
          : undefined;
        return () => {
          ncbiKeyStore.reload = undefined;
          if (typeof off === 'function') off();
        };
      }, 'molbio panel: NCBI key status');
      keyCtx.effect(() => keyCtx.slots.inject('plugins.detail.section', () => keyCtx.slots.register({
        name: 'plugins.detail.section',
        id: 'molbio-ncbi-key',
        order: 100,
      }, (props) => h(NcbiKeySection, { ...props, remote: keyCtx.remote }))), 'molbio panel: NCBI key section');
    });
    return () => { gate.dispose(); };
  }, 'molbio panel: NCBI key section gate');
}

export { apply, inject };
