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
 * so the workspace root is `useSessions((state) => state.byId[sessionId]?.cwd)`.
 * This package's own `inject` factory only has to hand over the Remote face.
 *
 * No JSX and no CSS files on purpose: the bundler lowers plain ESM only, and
 * inline styles keep the artifact a single self-contained file — styles injected
 * inside the factory would also have to be torn down by hand on unload.
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import {
  LIBRARY_FILE,
  childPath,
  classifyEntry,
  decodeBase64Bytes,
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
  plasmidSvg,
  readWorkspaceText,
  sortEntries,
} from './panel-core.mjs';

/** This implementation's identity, and the key its body/title register under. */
const PANEL_ID = 'dsh-molbio-tools';
/** Type discriminator the tab is opened by. */
const PANEL_KIND = 'molbio-panel';
/** The literature tab is a second page type of the same package. */
const PAPERS_ID = 'dsh-molbio-tools/papers';
const PAPERS_KIND = 'molbio-papers';

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

  const openable = useMemo(() => entries.filter(isOpenable), [entries]);

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

/** The literature tab's chip text. */
function papersTitle() {
  return 'Papers';
}

/** The tool names whose transcript card this package draws. */
const MAP_TOOL_KEYS = ['molbio_plasmid_map', 'molbio_plasmid_map_file'];

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

  // The markup is parsed and inserted as real DOM, exactly as in the panels:
  // the SVG stays selectable and inherits the page's font stack.
  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    node.replaceChildren();
    if (svg === '') return;
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror') !== null) return;
    const element = parsed.documentElement;
    element.setAttribute('style', 'width:100%;height:auto;max-width:520px');
    node.append(document.importNode(element, true));
  }, [svg]);

  const head = settled
    ? mapCardSummary(view)
    : 'Drawing the map…';
  const content = [h('div', { key: 'head', style: styles.cardHead }, head)];
  if (view.kind === 'map') {
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
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
  const [papers, setPapers] = useState([]);
  const [status, setStatus] = useState({ kind: 'waiting' });
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (cwd === undefined) {
      setStatus({ kind: 'waiting' });
      return undefined;
    }
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    readWorkspaceText(remote, sessionId, childPath(cwd, LIBRARY_FILE), controller.signal)
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
  }, [cwd, remote, sessionId]);

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
  if (status.kind === 'waiting') detail.push(h('div', { key: 'wait', style: styles.muted }, 'Waiting for the session workspace…'));
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
      search,
      tagRow,
      list),
    h('div', { style: styles.main }, ...detail));
}

/** Required browser services. */
const inject = ['slots', 'sidebarRightTabs', 'remote'];

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
}

export { apply, inject };
