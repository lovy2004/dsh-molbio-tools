/**
 * dsh-molbio-tools/test/panel-render.mjs
 *
 * Drive the REAL panel components through their state machine in Node.
 *
 * `test/client.mjs` proves the bundle's format and the data path, but it never
 * executes `MolbioPanel`/`PapersPanel` — so a hook-order mistake, a wrong prop,
 * or a branch that throws would only surface in the browser. There is no React
 * installed with the harness (React is seeded into the page by the shell) and
 * no DOM, so this file supplies the minimum a component needs:
 *
 *   - a tiny hook harness (`createElement`, `useState`, `useEffect`, `useMemo`,
 *     `useRef`) with React's actual semantics for the parts these components
 *     use: state persists across renders, effects run after a render and see
 *     that render's values, a setter schedules a re-render, `useMemo` is keyed;
 *   - stub services: the slot framework's `sessionId`/`useSessions`/`remote`;
 *   - a DOM stub for the SVG effect (`document.createElement` returning a node
 *     with `replaceChildren`/`append`, and `DOMParser` parsing the real markup
 *     my renderer produced).
 *
 * It then asserts what a user would see: the file list, the plasmid metadata
 * and feature table, the logo, the paper list/detail, the search + tag filter
 * narrowing the list, the empty-library hint, and the error state — plus that
 * each panel's effects are disposed on unmount.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const panelCore = await import('../build/panel-core.mjs');
const { parseGenBank } = await import('../genbank.mjs');
const { DEFAULT_LIBRARY_FILE } = await import('../papers.mjs');

// ── the hook harness ────────────────────────────────────────────────────────

/** One mounted component instance; hook slots live on it, so state persists. */
function mount(Component) {
  const slots = [];
  let index = 0;
  const pendingEffects = [];
  const cleanups = [];
  let props = {};
  let tree = null;

  const api = {
    createElement: (type, config, ...children) => {
      const flat = [];
      for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) flat.push(child);
      return { type, props: { ...(config ?? {}), children: flat.length === 1 ? flat[0] : flat } };
    },
  };
  const readSlot = (initial) => {
    const slot = index++;
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
    return slot;
  };
  api.useState = (initial) => {
    const slot = readSlot(initial);
    return [slots[slot], (next) => {
      slots[slot] = typeof next === 'function' ? next(slots[slot]) : next;
      api.schedule();
    }];
  };
  api.useEffect = (callback, deps) => {
    const slot = index++;
    const previous = slots[slot];
    const changed = previous === undefined || deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((value, position) => !Object.is(value, previous.deps[position]));
    if (!changed) return;
    slots[slot] = { deps };
    pendingEffects.push(callback);
  };
  api.useMemo = (factory, deps) => {
    const slot = index++;
    const previous = slots[slot];
    const changed = previous === undefined || deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((value, position) => !Object.is(value, previous.deps[position]));
    if (changed) slots[slot] = { deps, value: factory() };
    return slots[slot].value;
  };
  api.useRef = (initial) => {
    const slot = readSlot({ current: initial });
    return slots[slot];
  };

  let scheduled = false;
  api.schedule = () => {
    scheduled = true;
  };

  /** Run one render pass plus the effects it produced. */
  const render = async () => {
    index = 0;
    pendingEffects.length = 0;
    tree = Component({ ...props });
    // React attaches refs during the commit phase; { current: null } until then.
    attachRefs(tree);
    // Effects are scheduled after the render, like React's commit phase.
    for (const effect of pendingEffects.splice(0)) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    // Let the stubbed async reads settle, then re-render when state changed.
    scheduled = false;
    await flush();
    if (scheduled) await render();
  };
  api.render = render;
  api.setProps = (next) => {
    props = next;
  };
  api.unmount = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    pendingEffects.length = 0;
  };
  // `tree` is exposed through a getter so a caller always reads the latest pass.
  Object.defineProperty(api, 'tree', { get: () => tree });
  return api;
}

/** Drain microtasks: the panels' remote calls are promises. */
async function flush(rounds = 8) {
  for (let round = 0; round < rounds; round++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** Walk a rendered tree and point every element's `ref` at a stub node. */
function attachRefs(node) {
  if (Array.isArray(node)) {
    for (const child of node) attachRefs(child);
    return;
  }
  if (node === null || typeof node !== 'object' || node.props === undefined) return;
  if (node.props.ref !== undefined && node.props.ref !== null) node.props.ref.current = fakeNode();
  attachRefs(node.props.children);
}

// ── DOM / DOMParser stubs for the SVG effect ────────────────────────────────

function fakeNode() {
  return {
    children: [],
    replaceChildren() {
      this.children = [];
    },
    append(child) {
      this.children.push(child);
    },
  };
}
globalThis.document = {
  createElement: () => fakeNode(),
  importNode: (node) => node,
};

/**
 * Node has no DOMParser either. The panel only asks two things of it — did
 * parsing fail, and what is the root element — so the stub answers exactly
 * that, while parsing for real what it can: the markup must never contain a
 * `<parsererror>` (the panel treats that as a failure and shows an error).
 */
globalThis.DOMParser = class {
  parseFromString(markup, type) {
    assert.equal(type, 'image/svg+xml', 'the panel parses SVG');
    const broken = /<parsererror/.test(markup);
    return {
      querySelector: (selector) => (selector === 'parsererror' && broken ? { tagName: 'parsererror' } : null),
      documentElement: {
        tagName: markup.startsWith('<svg') ? 'svg' : 'unknown',
        attributes: { viewBox: /viewBox="([^"]+)"/.exec(markup)?.[1] ?? null },
        setAttribute() {},
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
      },
    };
  }
};

// ── tree helpers: find rendered text / elements like a user would ───────────

/** Collect every string in a rendered tree. */
function texts(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (node !== null && typeof node === 'object' && node.props !== undefined) {
    // A link carries its destination in an attribute, so a text-only walk
    // would silently miss exactly the thing worth asserting.
    if (node.type === 'a' && typeof node.props.href === 'string') out.push(node.props.href);
    texts(node.props.children, out);
  }
  return out;
}

/** Every element of one tag in the tree. */
function elements(node, tag, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, tag, out);
    return out;
  }
  if (node !== null && typeof node === 'object' && node.props !== undefined) {
    if (node.type === tag) out.push(node);
    elements(node.props.children, tag, out);
  }
  return out;
}

const markup = (tree) => texts(tree).join('\n');

// ── fixtures ────────────────────────────────────────────────────────────────

const CWD = 'D:\\work';
const SESSION = 'session-1';
const useSessions = (selector) => selector({ byId: { [SESSION]: { cwd: CWD } }, current: SESSION });

const puc118Bytes = new Uint8Array(await readFile(new URL('./fixtures/pUC118.dna', import.meta.url)));

/** A workspace Remote stub over a virtual file tree. */
function remote(tree) {
  return {
    workspaceFiles: {
      async list(_scope, path) {
        const entries = tree[path];
        if (entries === undefined) return { ok: true, value: { path, entries: [], truncated: false } };
        return { ok: true, value: { path, entries, truncated: false } };
      },
      // `readAll` carries bytes base64-encoded on the wire; the stub encodes
      // whatever fixture it was handed, so a test may pass a buffer or text and
      // still see the transport's real shape.
      async readAll(_scope, path) {
        const value = tree[path];
        if (value === undefined) return { ok: false, error: { code: 'workspace-file/not-found', message: `${path} does not exist` } };
        const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
        return { ok: true, value: { data: bytes.toString('base64') } };
      },
      async read(_scope, path) {
        const value = tree[path];
        if (value === undefined) return { ok: false, error: { code: 'workspace-file/not-found', message: `"${path}" does not exist` } };
        if (typeof value !== 'string') return { ok: false, error: { code: 'workspace-file/not-text', message: `${path} is not text` } };
        return { ok: true, value: { text: value } };
      },
    },
  };
}

// ── the panels, exactly as the bundle registers them ────────────────────────

const registrations = [];
const module = await (async () => {
  // The components import React, which the harness does not install (React is
  // seeded into the page by the shell). Rewrite that ONE import to a shim file
  // beside the source, so relative imports inside `client-entry.mjs` keep
  // resolving normally and the components under test are the real ones.
  const { writeFile, rm } = await import('node:fs/promises');
  const entryPath = new URL('../build/client-entry.mjs', import.meta.url);
  const shimPath = new URL('../build/.react-shim.test.mjs', import.meta.url);
  const entryShimPath = new URL('../build/.client-entry.test.mjs', import.meta.url);
  await writeFile(shimPath, [
    '// Generated by test/panel-render.mjs — a React surface backed by the test hooks.',
    'const hooks = () => globalThis.__molbioTestHooks;',
    'export const createElement = (...args) => hooks().createElement(...args);',
    'export const useEffect = (...args) => hooks().useEffect(...args);',
    'export const useMemo = (...args) => hooks().useMemo(...args);',
    'export const useRef = (...args) => hooks().useRef(...args);',
    'export const useState = (...args) => hooks().useState(...args);',
    '',
  ].join('\n'), 'utf8');
  const source = await readFile(entryPath, 'utf8');
  await writeFile(entryShimPath, source.replace("from 'react'", "from './.react-shim.test.mjs'"), 'utf8');
  try {
    return await import(entryShimPath.href);
  } finally {
    await rm(entryShimPath, { force: true });
    await rm(shimPath, { force: true });
  }
})();

const ctx = {
  remote: remote({}),
  effect(factory) {
    return factory();
  },
  sidebarRightTabs: { register: (definition) => registrations.push(definition) },
  slots: {
    register(registration, component) {
      registrations.push({ ...registration, component });
      return () => undefined;
    },
  },
};
module.apply(ctx);

const bodyFor = (key) => registrations.find((entry) => entry.name === 'sidebar.right.pane.tab' && entry.key === key).component;
const MolbioPanel = bodyFor('dsh-molbio-tools');
const PapersPanel = bodyFor('dsh-molbio-tools/papers');

// ── Molbio panel: file list → plasmid record → logo ─────────────────────────

{
  const files = remote({
    [CWD]: [
      { name: 'notes.md', type: 'file' },
      { name: 'pUC118.dna', type: 'file' },
      { name: 'reads.fasta', type: 'file' },
      { name: 'subdir', type: 'directory' },
    ],
    [`${CWD}/pUC118.dna`]: puc118Bytes,
    [`${CWD}/reads.fasta`]: '>a\nACGTACGT\n>b\nACGTTCGT\n',
  });
  globalThis.__molbioTestHooks = mount(MolbioPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: files, useSessions });
  await harness.render();

  let rendered = markup(harness.tree ?? null);
  // The list shows openable files, not directories, and not unrelated types.
  assert.ok(rendered.includes('pUC118.dna'), 'a .dna file is listed');
  assert.ok(rendered.includes('reads.fasta'), 'a .fasta file is listed');
  assert.ok(!rendered.includes('subdir'), 'directories are not offered');
  assert.ok(!rendered.includes('notes.md'), 'unopenable files are not offered');
  assert.ok(rendered.includes('Pick a file to draw it here.'), 'the empty state invites a selection');

  // Click the plasmid entry: the panel must load, parse and render the map.
  const rows = elements(harness.tree, 'div').filter((node) => node.props?.title?.startsWith('pUC118.dna'));
  assert.equal(rows.length, 1, 'the plasmid row is clickable');
  rows[0].props.onClick();
  await harness.render();

  rendered = markup(harness.tree);
  assert.ok(rendered.includes('pUC118'), 'the record name is shown');
  assert.ok(rendered.includes('3162 bp'), 'the length is shown');
  assert.ok(rendered.includes('circular'), 'the topology is shown');
  assert.ok(rendered.includes('AmpR'), 'the feature table lists features');
  assert.ok(rendered.includes('2102'), 'feature coordinates come from the parser');
  assert.ok(rendered.includes('−'), 'a reverse-strand feature shows the minus strand');
  // The SVG host received the renderer's output (real markup, parsed).
  const host = elements(harness.tree, 'div').find((node) => node.props?.ref !== undefined);
  assert.ok(host !== undefined, 'the SVG host is mounted');
  assert.equal(host.props.ref.current.children.length, 1, 'one SVG was appended');
  const svg = host.props.ref.current.children[0];
  assert.equal(svg.tagName, 'svg', 'the appended node is an SVG element');
  assert.ok(svg.getAttribute('viewBox') !== null, 'the SVG carries the renderer viewBox');

  // Click the alignment entry: the panel draws a logo instead.
  const fastaRow = elements(harness.tree, 'div').filter((node) => node.props?.title?.startsWith('reads.fasta'));
  fastaRow[0].props.onClick();
  await harness.render();
  rendered = markup(harness.tree);
  assert.ok(rendered.includes('2 sequences'), 'the logo header reports the sequence count');
  assert.ok(rendered.includes('8 aligned columns'), 'the logo header reports the columns');

  harness.unmount();
}

// ── Molbio panel: read failure is shown, not swallowed ─────────────────────

{
  const failing = {
    workspaceFiles: {
      async list() {
        return { ok: true, value: { path: CWD, entries: [{ name: 'broken.dna', type: 'file' }], truncated: false } };
      },
      async readAll() {
        return { ok: false, error: { code: 'workspace-file/too-large', message: 'exceeds the 33554432 byte full-file cap' } };
      },
    },
  };
  globalThis.__molbioTestHooks = mount(MolbioPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: failing, useSessions });
  await harness.render();
  elements(harness.tree, 'div').find((node) => node.props?.title?.startsWith('broken.dna')).props.onClick();
  await harness.render();
  const rendered = markup(harness.tree);
  assert.ok(rendered.includes('too-large') || rendered.includes('exceeds'), 'the Remote failure reaches the pane');
  harness.unmount();
}

// ── Molbio panel: a workspace listing failure is shown ─────────────────────

{
  const failing = {
    workspaceFiles: {
      async list() {
        return { ok: false, error: { code: 'workspace-file/not-directory', message: '"D:\\work" is a file' } };
      },
    },
  };
  globalThis.__molbioTestHooks = mount(MolbioPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: failing, useSessions });
  await harness.render();
  assert.ok(markup(harness.tree).includes('is a file'), 'a listing failure is displayed');
  harness.unmount();
}

// ── Papers panel: list, search, tag filter, detail, empty and error states ──

const library = {
  papers: [
    {
      id: 'pmid:12345',
      title: 'KRAS G12D inhibition in pancreatic models',
      authors: 'Smith J, Doe A',
      journal: 'Nature',
      year: '2024',
      pmid: '12345',
      tags: ['kras', 'inhibitor'],
      note: 'Read the in vivo arm.',
      added_at: '2026-09-01',
    },
    {
      id: 'title:CRISPR screening review:2023',
      title: 'CRISPR screening review',
      authors: 'Lee K',
      year: '2023',
      tags: ['crispr'],
      added_at: '2026-09-05',
    },
  ],
};

{
  const files = remote({ [`${CWD}/${DEFAULT_LIBRARY_FILE}`]: JSON.stringify(library) });
  globalThis.__molbioTestHooks = mount(PapersPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: files, useSessions });
  await harness.render();

  let rendered = markup(harness.tree);
  assert.ok(rendered.includes('Papers (2)'), 'the header counts the library');
  assert.ok(rendered.includes('KRAS G12D inhibition in pancreatic models'), 'paper titles are listed');
  assert.ok(rendered.includes('Smith J et al. · Nature · 2024'), 'the summary line is shown');
  assert.ok(rendered.includes('crispr (1)'), 'tag chips carry counts');
  // The newest-added paper (CRISPR, 2026-09-05) is selected by default, so the
  // detail pane shows ITS fields — the KRAS note belongs to the other paper.
  assert.ok(rendered.includes('id: title:CRISPR screening review:2023'), 'the detail pane shows the newest paper id');
  assert.ok(!rendered.includes('Read the in vivo arm.'), 'the other paper\'s note is not shown yet');
  assert.ok(!rendered.includes('https://pubmed.ncbi.nlm.nih.gov/12345/'), 'no link for the unselected paper');

  // Search narrows the list.
  const search = elements(harness.tree, 'input')[0];
  assert.ok(search !== undefined, 'the search box is rendered');
  search.props.onChange({ target: { value: 'smith' } });
  await harness.render();
  rendered = markup(harness.tree);
  assert.ok(rendered.includes('Papers (1 / 2)'), 'the header reports the filtered count');
  assert.ok(rendered.includes('KRAS G12D'), 'the matching paper stays');
  assert.ok(!rendered.includes('CRISPR screening review\ntitle'), 'the other paper is filtered out of the list');

  // Clearing the query and filtering by tag instead.
  elements(harness.tree, 'input')[0].props.onChange({ target: { value: '' } });
  await harness.render();
  const crisprChip = elements(harness.tree, 'span').find((node) => texts(node).join('') === 'crispr (1)');
  assert.ok(crisprChip !== undefined, 'the tag chip is clickable');
  crisprChip.props.onClick();
  await harness.render();
  rendered = markup(harness.tree);
  assert.ok(rendered.includes('Papers (1 / 2)'), 'the tag filter narrows the list');
  assert.ok(rendered.includes('CRISPR screening review'), 'the tagged paper is selected');

  // Selecting the other paper switches the detail pane.
  const chip = elements(harness.tree, 'span').find((node) => texts(node).join('') === 'all');
  chip.props.onClick();
  await harness.render();
  const krasRow = elements(harness.tree, 'div').find((node) => node.props?.title === 'KRAS G12D inhibition in pancreatic models');
  krasRow.props.onClick();
  await harness.render();
  rendered = markup(harness.tree);
  assert.ok(rendered.includes('https://pubmed.ncbi.nlm.nih.gov/12345/'), 'the PubMed link is derived from the PMID');
  assert.ok(rendered.includes('inhibitor'), 'the paper tags render in the detail pane');
  harness.unmount();
}

// An absent papers.json is an EMPTY library with a pointer at the tools.
{
  const files = remote({ [CWD]: [] });
  globalThis.__molbioTestHooks = mount(PapersPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: files, useSessions });
  await harness.render();
  const rendered = markup(harness.tree);
  assert.ok(rendered.includes('No papers.json in this workspace'), 'the empty state names the file');
  assert.ok(rendered.includes('molbio_paper_add'), 'the empty state points at the tool that fills it');
  harness.unmount();
}

// A corrupt library is an ERROR, never an empty list.
{
  const files = remote({ [`${CWD}/${DEFAULT_LIBRARY_FILE}`]: '{ this is not json' });
  globalThis.__molbioTestHooks = mount(PapersPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: files, useSessions });
  await harness.render();
  const rendered = markup(harness.tree);
  assert.ok(rendered.includes('not valid JSON'), 'a corrupt library is reported as an error');
  assert.ok(!rendered.includes('No papers in the library yet'), 'a corrupt library is not shown as empty');
  harness.unmount();
}

// ── effects are disposed on unmount ─────────────────────────────────────────

{
  let aborted = 0;
  const slow = {
    workspaceFiles: {
      async list(_scope, _path, signal) {
        signal?.addEventListener('abort', () => {
          aborted++;
        });
        return { ok: true, value: { path: CWD, entries: [], truncated: false } };
      },
    },
  };
  globalThis.__molbioTestHooks = mount(MolbioPanel);
  const harness = globalThis.__molbioTestHooks;
  harness.setProps({ sessionId: SESSION, remote: slow, useSessions });
  await harness.render();
  harness.unmount();
  assert.equal(aborted, 1, 'unmounting aborts the in-flight listing');
}

console.log('panel render checks passed (MolbioPanel + PapersPanel driven through their states)');
