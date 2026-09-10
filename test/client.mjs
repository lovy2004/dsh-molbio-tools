/**
 * dsh-molbio-tools/test/client.mjs
 *
 * Verify the browser half WITHOUT a browser, in two layers:
 *
 * 1. Format: the built `lib/client.js` must execute as the loader executes it —
 *    register exactly one factory via `window.__ModuleLoader__.load`, touch no
 *    other global while registering, and materialize to a module carrying
 *    `apply`/`inject`. The factory is then run against a stub `require` that
 *    answers the platform externals, which is enough to prove the bundle's
 *    internal module table, externals and export wiring are all intact.
 * 2. Behaviour: `build/panel-core.mjs` — the whole data path behind the panel —
 *    is driven against the real pUC118 fixture in Node, asserting the same
 *    values the Node tools produce for the same file (the panel and the tools
 *    share these sources, so a drift here is a real bug).
 *
 * Nothing here renders React: the panel's components are exercised through the
 * services they receive, which is the part that can actually be wrong.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const bundleText = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const panelCore = await import('../build/panel-core.mjs');
const { parseGenBank } = await import('../genbank.mjs');

// ── 1. the bundle's registration format ─────────────────────────────────────

const registrations = [];
let globalsTouched = [];
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
  },
};
// A recording proxy for `window`: registering must not touch anything else.
const windowProxy = new Proxy(sandbox.window, {
  set(target, property, value) {
    globalsTouched.push(String(property));
    target[property] = value;
    return true;
  },
  get(target, property) {
    if (typeof property === 'string' && !(property in target)) globalsTouched.push(`read:${property}`);
    return target[property];
  },
});
const context = createContext({ window: windowProxy, console, Symbol, Object, Error, JSON, Math });
runInContext(bundleText, context, { filename: 'client.js' });

assert.equal(registrations.length, 1, 'the bundle registers exactly one module factory');
const registration = registrations[0];
assert.equal(registration.id, 'dsh-molbio-tools', 'the registered id is the exact package name');
assert.equal(typeof registration.factory, 'function', 'the registration carries a factory');
assert.deepEqual(
  globalsTouched.filter((entry) => !entry.startsWith('read:')),
  [],
  `registering the bundle must assign no global (saw ${globalsTouched.join(', ')})`,
);

// ── materialize the factory with stubbed externals ──────────────────────────

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => undefined,
  useMemo: (factory) => factory(),
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
};
const reactCalls = [];
const module = registration.factory((specifier) => {
  reactCalls.push(specifier);
  if (specifier === 'react') return reactStub;
  throw new Error(`client bundle required the unexpected external ${JSON.stringify(specifier)}`);
});

assert.deepEqual(reactCalls, ['react'], 'the bundle requires react and nothing else from the host');
assert.equal(typeof module.apply, 'function', 'the materialized module exports apply');
// The bundle ran inside a `vm` realm, so its arrays carry that realm's
// prototype: compare contents, not identities.
assert.deepEqual([...module.inject], ['slots', 'sidebarRightTabs', 'remote'], 'the declared browser services');

// ── 2. apply() against stub services ────────────────────────────────────────

const effects = [];
const tabTypes = [];
const slotRegistrations = [];
const ctx = {
  remote: {
    workspaceFiles: {
      async list() { return { ok: true, value: { entries: [], truncated: false } }; },
      async readAll() { return { ok: true, value: { data: '' } }; },
    },
  },
  get(service) {
    if (service === 'useSessions') return (selector) => selector({ byId: {}, current: undefined });
    return undefined;
  },
  effect(factory, label) {
    effects.push(label);
    return factory();
  },
  sidebarRightTabs: { register(definition) { tabTypes.push(definition); return () => undefined; } },
  slots: { register(registration, component) { slotRegistrations.push({ registration, component }); return () => undefined; } },
};
module.apply(ctx);

assert.deepEqual(effects, ['molbio panel: tab type', 'molbio panel: tab body', 'molbio panel: tab title']);
assert.equal(tabTypes.length, 1);
assert.equal(tabTypes[0].id, 'dsh-molbio-tools');
assert.equal(tabTypes[0].kind, 'molbio-panel');
assert.equal(tabTypes[0].title(), 'Molbio');
assert.equal(tabTypes[0].patterns, undefined, 'a page type declares no resource patterns');
assert.equal(tabTypes[0].priority, undefined, 'the default priority band is extension (third-party)');
assert.equal(tabTypes[0].guide.length, 1);
assert.equal(tabTypes[0].guide[0].title(), 'Molbio');
// Body + title register in the keyed seats under the type's id.
assert.deepEqual(
  slotRegistrations.map((entry) => [entry.registration.name, entry.registration.key]),
  [['sidebar.right.pane.tab', 'dsh-molbio-tools'], ['sidebar.right.pane.tab.title', 'dsh-molbio-tools']],
);
assert.equal(typeof slotRegistrations[0].component, 'function', 'the body is a component');
const face = slotRegistrations[0].registration.inject('session-1', {});
assert.equal(typeof face.remote.workspaceFiles.list, 'function', 'the inject factory hands the body the workspace Remote');
// `sessionId` and `useSessions` come from the slot runtime, not from this
// factory: the framework turns every root hook source into a `use<Name>` prop.
assert.equal(Object.keys(face).join(','), 'remote', 'the body injects nothing the framework already provides');

// ── 3. the panel's data path, against the real fixture ──────────────────────

assert.equal(panelCore.extensionOf('pUC118.dna'), 'dna');
assert.equal(panelCore.extensionOf('no-extension'), '');
assert.equal(panelCore.extensionOf('PLASMID.GB'), 'gb');
assert.deepEqual(
  ['p.dna', 'p.gb', 'p.gbk', 'p.genbank', 'a.fasta', 'a.fa', 'notes.md', 'x.bin'].map((name) => panelCore.classifyEntry({ name, type: 'file' })),
  ['plasmid', 'plasmid', 'plasmid', 'plasmid', 'alignment', 'alignment', 'other', 'other'],
);
assert.equal(panelCore.classifyEntry({ name: 'sub', type: 'directory' }), 'directory');
assert.equal(panelCore.classifyEntry({ name: 'weird.dna', type: 'symlink' }), 'other', 'non-regular entries are not offered');

const sorted = panelCore.sortEntries([
  { name: 'notes.md', type: 'file' },
  { name: 'z.dna', type: 'file' },
  { name: 'a.fasta', type: 'file' },
  { name: 'a.dna', type: 'file' },
]);
assert.deepEqual(sorted.map((entry) => entry.name), ['a.dna', 'z.dna', 'a.fasta', 'notes.md']);

assert.equal(panelCore.childPath('D:\\work', 'a.dna'), 'D:\\work/a.dna');
assert.equal(panelCore.childPath('', 'a.dna'), 'a.dna');

// base64 → bytes (the workspace transport spelling)
const bytes = panelCore.decodeBase64Bytes(Buffer.from('hello').toString('base64'));
assert.ok(bytes instanceof Uint8Array);
assert.equal(new TextDecoder().decode(bytes), 'hello');
assert.throws(() => panelCore.decodeBase64Bytes(undefined), /base64/);

// parsing a real SnapGene file, entirely in "browser" terms
const dnaBytes = new Uint8Array(await readFile(new URL('./fixtures/pUC118.dna', import.meta.url)));
const record = panelCore.parsePlasmidFile('pUC118.dna', dnaBytes);
assert.equal(record.kind, 'plasmid');
assert.equal(record.name, 'pUC118');
assert.equal(record.length, 3162);
assert.equal(record.circular, true);
assert.ok(record.features.length >= 10, `expected >= 10 features, got ${record.features.length}`);
const ampR = record.features.find((feature) => feature.label === 'AmpR');
assert.deepEqual([ampR.type, ampR.start, ampR.end, ampR.strand], ['CDS', 2102, 2962, -1]);

// the SVG the panel injects is the plugin's own renderer output
const svg = panelCore.plasmidSvg(record);
assert.ok(svg.startsWith('<svg'), 'the panel draws a standalone SVG');
assert.ok(svg.endsWith('</svg>'));
assert.ok(svg.includes('pUC118'));
assert.ok(svg.includes('AmpR'));
assert.ok(!svg.includes('<script'), 'no script tag in generated markup');

// GenBank text path
const genbankText = [
  'LOCUS       pTEST                 100 bp    DNA     circular',
  'ACCESSION   TEST0001',
  'DEFINITION  panel fixture.',
  'FEATURES             Location/Qualifiers',
  '     CDS             1..60',
  '                     /gene="testA"',
  '                     /product="Test protein"',
  'ORIGIN',
  `        1 ${'acgtacgtac'.repeat(10)}`,
  '//',
].join('\n');
const fromText = panelCore.parsePlasmidFile('pTEST.gb', new TextEncoder().encode(genbankText));
assert.equal(fromText.name, 'pTEST');
assert.equal(fromText.length, 100);
assert.equal(fromText.features.length, 1);
assert.deepEqual([fromText.features[0].label, fromText.features[0].start, fromText.features[0].end], ['Test protein', 1, 60]);
// the same text through the Node parser gives the same record
const nodeParsed = parseGenBank(genbankText);
assert.equal(fromText.length, nodeParsed.length);
assert.deepEqual(fromText.features, nodeParsed.features);

// an unsupported extension is refused with a usable message
assert.throws(() => panelCore.parsePlasmidFile('notes.md', new Uint8Array()), /use \.dna, \.gb, \.gbk or \.genbank/);

// alignment path: two FASTA records are aligned and drawn as a logo
const fasta = new TextEncoder().encode('>a\nACGTACGT\n>b\nACGTTCGT\n');
const alignment = panelCore.parseAlignmentFile(fasta);
assert.deepEqual(alignment.ids, ['a', 'b']);
assert.equal(alignment.rows.length, 2);
assert.equal(alignment.rows[0], 'ACGTACGT');
const logoSvg = panelCore.logoSvg(alignment);
assert.ok(logoSvg.startsWith('<svg'));
assert.ok(logoSvg.includes('information content (bits)'));
assert.throws(() => panelCore.parseAlignmentFile(new TextEncoder().encode('>a\nACGT\n')), /at least 2 sequences/);
assert.throws(() => panelCore.parseAlignmentFile(new TextEncoder().encode('ACGT\n')), /must start with a ">" header/);

console.log('client bundle format checks passed');
console.log('panel data path checks passed');
