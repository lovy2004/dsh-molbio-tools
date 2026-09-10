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
 * The body receives the slot framework's `sessionId`/`actions` injection plus
 * the `useSessions` selector hook the runtime synthesises from the root hook
 * sources (every root hook becomes a `use<Name>` prop for session-scope slots),
 * so the workspace root is `useSessions((state) => state.byId[sessionId]?.cwd)`.
 * This package's own `inject` factory only has to hand over the Remote face.
 *
 * No JSX and no CSS files on purpose: the bundler lowers plain ESM only, and
 * inline styles keep the artifact a single self-contained file — styles injected
 * inside the factory would also have to be torn down by hand on unload.
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import {
  childPath,
  classifyEntry,
  decodeBase64Bytes,
  logoSvg,
  parseAlignmentFile,
  parsePlasmidFile,
  plasmidSvg,
  sortEntries,
} from './panel-core.mjs';

/** This implementation's identity, and the key its body/title register under. */
const PANEL_ID = 'dsh-molbio-tools';
/** Type discriminator the tab is opened by. */
const PANEL_KIND = 'molbio-panel';

/** Read one file's raw bytes through the workspace Remote. */
async function readBytes(remote, sessionId, path, signal) {
  const scope = { sessionId };
  const result = typeof remote.workspaceFiles.readAll === 'function'
    ? await remote.workspaceFiles.readAll(scope, path, signal)
    : await remote.workspaceFiles.readBytes(scope, path, { offset: 0, length: 8 * 1024 * 1024 }, signal);
  if (result === null || typeof result !== 'object' || !result.ok) {
    const failure = result !== null && typeof result === 'object' ? result.error : undefined;
    throw new Error(failure?.message ?? `the workspace read of ${path} failed`);
  }
  return decodeBase64Bytes(result.value.data);
}

/** List one directory, newest-first ordering rules applied by the caller. */
async function listDirectory(remote, sessionId, path, signal) {
  const result = await remote.workspaceFiles.list({ sessionId }, path, signal);
  if (result === null || typeof result !== 'object' || !result.ok) {
    const failure = result !== null && typeof result === 'object' ? result.error : undefined;
    throw new Error(failure?.message ?? `the workspace listing of ${path} failed`);
  }
  return sortEntries(result.value.entries ?? []);
}

// ── styles (inline; the artifact stays a single file) ───────────────────────

const styles = {
  root: { display: 'flex', height: '100%', minHeight: '320px', font: '13px/1.5 system-ui, sans-serif', color: 'var(--dsh-text, #1a1a1a)' },
  list: { width: '210px', flex: '0 0 210px', overflowY: 'auto', borderRight: '1px solid var(--dsh-border, #e3e6ea)', padding: '8px 0' },
  listItem: (active) => ({
    padding: '5px 12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    background: active ? 'var(--dsh-selected, #eaf2ff)' : 'transparent',
    fontWeight: active ? 600 : 400,
  }),
  listHead: { padding: '4px 12px 8px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.55 },
  main: { flex: '1 1 auto', overflow: 'auto', padding: '12px 16px' },
  meta: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '10px', fontSize: '12px', opacity: 0.8 },
  error: { color: 'var(--dsh-danger, #c0392b)', padding: '10px 12px', whiteSpace: 'pre-wrap' },
  muted: { opacity: 0.6, padding: '10px 12px' },
  svg: { maxWidth: '100%', height: 'auto' },
  table: { borderCollapse: 'collapse', marginTop: '12px', fontSize: '12px', width: '100%' },
  th: { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsh-border, #e3e6ea)', opacity: 0.7, fontWeight: 600 },
  td: { padding: '3px 8px', borderBottom: '1px solid var(--dsh-border-soft, #f0f2f5)' },
};

/** The panel body: a file list on the left, the rendered record on the right. */
function MolbioPanel({ sessionId, remote, useSessions }) {
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [record, setRecord] = useState(null);
  const [status, setStatus] = useState({ kind: cwd === undefined ? 'waiting' : 'loading' });
  const svgHost = useRef(null);

  // Directory listing, re-read when the session's workspace root changes.
  useEffect(() => {
    if (cwd === undefined) return undefined;
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    listDirectory(remote, sessionId, cwd, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setEntries(rows);
        setStatus({ kind: 'ready' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus({ kind: 'error', message: String(error?.message ?? error) });
      });
    return () => controller.abort();
  }, [cwd, remote, sessionId]);

  // The selected file, parsed with the plugin's own parsers.
  useEffect(() => {
    if (selected === null || cwd === undefined) return undefined;
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    readBytes(remote, sessionId, childPath(cwd, selected.name), controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        const kind = classifyEntry(selected);
        const parsed = kind === 'plasmid'
          ? { kind, ...parsePlasmidFile(selected.name, bytes) }
          : { kind, ...parseAlignmentFile(bytes) };
        setRecord(parsed);
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
    if (record === null || status.kind !== 'ready') return;
    const markup = record.kind === 'plasmid' ? plasmidSvg(record) : logoSvg(record);
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    if (parsed.querySelector('parsererror') !== null) {
      setStatus({ kind: 'error', message: 'the generated SVG could not be parsed' });
      return;
    }
    const svg = parsed.documentElement;
    svg.setAttribute('style', 'max-width:100%;height:auto');
    host.append(document.importNode(svg, true));
  }, [record, status.kind]);

  const openable = useMemo(() => entries.filter((entry) => classifyEntry(entry) !== 'directory'), [entries]);

  const head = h('div', { style: styles.listHead }, 'Sequence files');
  const list = h(
    'div',
    { style: styles.list },
    head,
    ...(openable.length === 0
      ? [h('div', { key: 'none', style: styles.muted }, 'No .dna / .gb / .gbk / .fasta files in this workspace')]
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
  if (status.kind === 'waiting') body.push(h('div', { key: 'wait', style: styles.muted }, 'Waiting for the session workspace…'));
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
    body.push(h('div', { key: 'meta', style: styles.meta },
      h('span', null, `${record.rows.length} sequences`),
      h('span', null, `${record.rows[0]?.length ?? 0} aligned columns`)));
    body.push(h('div', { key: 'svg', ref: svgHost, style: styles.svg }));
  }

  return h('div', { style: styles.root }, list, h('div', { style: styles.main }, ...body));
}

/** The chip text; the registry captures it at open time. */
function panelTitle() {
  return 'Molbio';
}

/** Required browser services. */
const inject = ['slots', 'sidebarRightTabs', 'remote'];

/**
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
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PANEL_ID,
    inject: () => ({ remote }),
  }, MolbioPanel), 'molbio panel: tab body');
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: PANEL_ID,
  }, panelTitle), 'molbio panel: tab title');
}

export { apply, inject };
