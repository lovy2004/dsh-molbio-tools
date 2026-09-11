/**
 * dsh-molbio-tools/test/map-card.mjs
 *
 * End-to-end check of the `tool.call.toolview` map card, across the boundary
 * that no other test crosses: the HOST half produces the projection, the CLIENT
 * half consumes it.
 *
 *   1. register the real plugin into a mock registry (as `smoke.mjs` does) and
 *      call `molbio_plasmid_map`;
 *   2. call the tool's `output.presentationMeta(args, value)` exactly as the
 *      tool layer does for a root call — this is the documented path that
 *      reaches the browser as the result block's `meta`;
 *   3. feed that projection to the card's reader (`mapCardView`) and assert it
 *      resolves to a drawable map;
 *   4. render the card component with that meta and assert the SVG actually
 *      lands in its host, plus the fallbacks: a non-map tool's block, a missing
 *      meta, an oversized map that dropped its markup, and a failed call.
 *
 * The point is the seam: a rename on either side, a meta that stops being
 * attached, or a card that stops accepting it, fails here rather than silently
 * degrading to the generic tool row in someone's conversation.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSlotsStub } from './slots-stub.mjs';

const require = createRequire(import.meta.url);
const panelCore = await import('../build/panel-core.mjs');

// ── host side: a mock registry, as the smoke test uses ──────────────────────

const dshTools = await import('file:///C:/Users/18771/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
const { assertSupportedJsonSchema } = dshTools;
const plugin = await import('../index.mjs');

process.env.MOLBIO_AUTO_VIEW = '0';

const registered = [];
const memFs = {
  files: new Map(),
  async resolve(path) {
    return { path };
  },
  async stat(target) {
    return this.files.has(target.path) ? { size: 1 } : undefined;
  },
  async readText(target) {
    if (!this.files.has(target.path)) throw new Error('ENOENT');
    return this.files.get(target.path).toString('utf8');
  },
  async readBytes(target) {
    if (!this.files.has(target.path)) throw new Error('ENOENT');
    return new TextEncoder().encode(this.files.get(target.path));
  },
  async writeText(target, content) {
    this.files.set(target.path, content);
    return { version: 1 };
  },
};
const registry = {
  register(definition) {
    assertSupportedJsonSchema(definition.output.schema);
    registered.push(definition);
  },
};
await plugin.apply({
  systemPrompt: { section: () => undefined },
  tools: registry,
  get: (service) => (service === 'fs' ? memFs : undefined),
  effect: (factory) => factory(),
});
const tool = registered.find((entry) => entry.name === 'molbio_plasmid_map');
assert.ok(tool !== undefined, 'molbio_plasmid_map registers');
assert.equal(typeof tool.output.presentationMeta, 'function', 'the map tool declares a presentationMeta projection');

const exec = { agent: { session: { header: { cwd: 'C:/tmp' } } } };
const args = {
  sequence: 'GAATTC' + 'ACGTACGTAC'.repeat(20),
  name: 'pCARD',
  features: [{ label: 'AmpR', type: 'CDS', start: 10, end: 60, strand: -1 }],
  enzymes: ['EcoRI'],
};
const value = await tool.execute(args, exec);
const meta = tool.output.presentationMeta(args, value);

// ── the projection's shape ──────────────────────────────────────────────────

assert.equal(meta.kind, 'molbio-map');
assert.equal(meta.name, 'pCARD');
assert.equal(meta.length, 206);
assert.equal(meta.circular, true);
assert.equal(meta.feature_count, 1);
assert.ok(meta.enzyme_count >= 1, 'the EcoRI cut is counted');
assert.equal(meta.svg_path, value.svg_path);
assert.ok(typeof meta.svg === 'string' && meta.svg.startsWith('<svg'), 'the card meta carries the markup');
assert.equal(meta.svg_bytes, meta.svg.length);
assert.equal(meta.svg_omitted, undefined);

// ── client side: the projection resolves to a drawable map ──────────────────

const view = panelCore.mapCardView(meta);
assert.equal(view.kind, 'map', 'the card resolves the projection to a map');
assert.equal(view.svg, meta.svg);
assert.equal(view.svgPath, value.svg_path);
assert.equal(panelCore.mapCardSummary(view), 'pCARD · 206 bp · circular · 1 feature(s) · 1 cut mark(s)');

// ── fallbacks: the card must never throw inside a transcript ────────────────

const foreign = panelCore.mapCardView({ kind: 'read', path: 'x' });
assert.equal(foreign.kind, 'notice');
assert.match(foreign.message, /no plasmid map/i);
assert.equal(panelCore.mapCardView(undefined).kind, 'notice', 'a missing meta is a notice, not a crash');
assert.equal(panelCore.mapCardView(null).kind, 'notice');
assert.equal(panelCore.mapCardView('nonsense').kind, 'notice');
assert.equal(panelCore.mapCardView([1, 2]).kind, 'notice');

// A map too large to carry: the file is still written, the markup is not sent.
const oversized = panelCore.mapCardView({ kind: 'molbio-map', name: 'pBIG', svg_omitted: true, svg_bytes: 900_000, svg_path: 'C:/tmp/pBIG.svg', length: 5_000_000, circular: true, feature_count: 3, enzyme_count: 0 });
assert.equal(oversized.kind, 'notice');
assert.match(oversized.message, /too large/i);
assert.equal(oversized.svgPath, 'C:/tmp/pBIG.svg', 'the notice still names the written file');
assert.equal(panelCore.mapCardSummary(oversized), 'pBIG · 5000000 bp · circular · 3 feature(s)', 'the header still summarises the map');
// Markup that is not the renderer's output is refused rather than injected.
assert.equal(panelCore.mapCardView({ kind: 'molbio-map', name: 'x', svg: '<div>hi</div>' }).kind, 'notice');
assert.equal(panelCore.mapCardView({ kind: 'molbio-map', name: 'x', svg: '<svg onload="x"></svg' }).kind, 'notice');

// ── the component: render it and assert the SVG lands in its host ───────────

const shimPath = new URL('../build/.react-shim.test.mjs', import.meta.url);
const entryPath = new URL('../build/.client-entry.test.mjs', import.meta.url);
await writeFile(shimPath, [
  'const hooks = () => globalThis.__molbioTestHooks;',
  'export const createElement = (...args) => hooks().createElement(...args);',
  'export const useEffect = (...args) => hooks().useEffect(...args);',
  'export const useMemo = (...args) => hooks().useMemo(...args);',
  'export const useRef = (...args) => hooks().useRef(...args);',
  'export const useState = (...args) => hooks().useState(...args);',
  '',
].join('\n'), 'utf8');
await writeFile(entryPath, (await readFile(new URL('../build/client-entry.mjs', import.meta.url), 'utf8')).replace("from 'react'", "from './.react-shim.test.mjs'"), 'utf8');

/** The same minimal hook host the panel render tests use. */
function mount(Component) {
  const slots = [];
  const pending = [];
  const cleanups = [];
  let index = 0;
  let props = {};
  let tree = null;
  const api = {
    createElement: (type, config, ...children) => {
      const flat = [];
      for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) flat.push(child);
      return { type, props: { ...(config ?? {}), children: flat.length === 1 ? flat[0] : flat } };
    },
    useState: (initial) => {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next) => {
        slots[slot] = typeof next === 'function' ? next(slots[slot]) : next;
      }];
    },
    useEffect: (callback, deps) => {
      const slot = index++;
      const previous = slots[slot];
      const changed = previous === undefined || deps === undefined || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]));
      if (!changed) return;
      slots[slot] = { deps };
      pending.push(callback);
    },
    useMemo: (factory, deps) => {
      const slot = index++;
      const previous = slots[slot];
      const changed = previous === undefined || deps === undefined || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]));
      if (changed) slots[slot] = { deps, value: factory() };
      return slots[slot].value;
    },
    useRef: (initial) => {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
  };
  const fakeNode = () => ({
    children: [],
    replaceChildren() {
      this.children = [];
    },
    append(child) {
      this.children.push(child);
    },
  });
  globalThis.document = { createElement: fakeNode, importNode: (node) => node };
  globalThis.DOMParser = class {
    parseFromString(markup, type) {
      assert.equal(type, 'image/svg+xml');
      const broken = /<parsererror/.test(markup);
      return {
        querySelector: (selector) => (selector === 'parsererror' && broken ? { tagName: 'parsererror' } : null),
        documentElement: { tagName: 'svg', setAttribute() {}, getAttribute: () => null, attributes: {} },
      };
    }
  };
  api.render = async () => {
    index = 0;
    pending.length = 0;
    tree = Component({ ...props });
    const attach = (node) => {
      if (Array.isArray(node)) {
        for (const child of node) attach(child);
        return;
      }
      if (node === null || typeof node !== 'object' || node.props === undefined) return;
      if (node.props.ref !== undefined && node.props.ref !== null) node.props.ref.current = fakeNode();
      attach(node.props.children);
    };
    attach(tree);
    for (const effect of pending.splice(0)) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    await Promise.resolve();
  };
  api.setProps = (next) => {
    props = next;
  };
  api.unmount = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  Object.defineProperty(api, 'tree', { get: () => tree });
  return api;
}

const registrations = [];
const module = await import(entryPath.href);
const slots = createSlotsStub(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'tool.call.toolview']);
module.apply({
  remote: {},
  effect: (factory) => factory(),
  sidebarRightTabs: { register: (definition) => registrations.push(definition) },
  slots,
});
const MapCard = slots.registrations.find(
  (entry) => entry.registration.name === 'tool.call.toolview' && entry.registration.key === 'molbio_plasmid_map',
).component;
assert.equal(typeof MapCard, 'function', 'the map card is registered for molbio_plasmid_map');

const settledBlock = { kind: 'tool-result', callId: 'c1', isError: false, meta, content: [{ type: 'text', text: 'saved' }], call: { name: 'molbio_plasmid_map', argsRaw: '{}' } };
globalThis.__molbioTestHooks = mount(MapCard);
const harness = globalThis.__molbioTestHooks;
harness.setProps({ block: settledBlock, inspect: undefined });
await harness.render();

const texts = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (node !== null && typeof node === 'object' && node.props !== undefined) texts(node.props.children, out);
  return out;
};
const rendered = texts(harness.tree).join('\n');
assert.ok(rendered.includes('pCARD · 206 bp'), 'the card header summarises the map');
assert.ok(rendered.includes(value.svg_path), 'the card shows where the map was written');
const svgSlots = (function find(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) find(child, out);
    return out;
  }
  if (node !== null && typeof node === 'object' && node.props !== undefined) {
    if (node.props.ref !== undefined && node.props.ref !== null) out.push(node);
    find(node.props.children, out);
  }
  return out;
})(harness.tree);
assert.equal(svgSlots.length, 1, 'the card mounts exactly one SVG host');
assert.equal(svgSlots[0].props.ref.current.children.length, 1, 'and appended the parsed SVG into it');
harness.unmount();

// A running call renders without a map and without throwing.
globalThis.__molbioTestHooks = mount(MapCard);
const running = globalThis.__molbioTestHooks;
running.setProps({ block: { callId: 'c1', name: 'molbio_plasmid_map', argsRaw: '{}', turn: 1, step: 1, time: 0, subCalls: [] } });
await running.render();
assert.ok(texts(running.tree).join('\n').includes('Drawing the map'), 'a running call shows progress');
running.unmount();

// A failed call shows the error text.
globalThis.__molbioTestHooks = mount(MapCard);
const failed = globalThis.__molbioTestHooks;
failed.setProps({
  block: { kind: 'tool-result', callId: 'c2', isError: true, meta: undefined, content: [{ type: 'text', text: 'feature span is invalid' }], call: { name: 'molbio_plasmid_map', argsRaw: '{}' } },
  inspect: () => undefined,
});
await failed.render();
const failedText = texts(failed.tree).join('\n');
assert.ok(failedText.includes('feature span is invalid'), 'a failed call shows the error text');
assert.ok(failedText.includes('Inspect'), 'and offers the inspect action');
failed.unmount();

await rm(shimPath, { force: true });
await rm(entryPath, { force: true });
console.log('map card checks passed (host projection -> card view -> rendered SVG)');
