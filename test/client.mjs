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
import { createSlotsStub } from './slots-stub.mjs';

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
//
// The slots stub models the shell's SlotCore (test/slots-stub.mjs): a seat must
// be DECLARED by the entry that OWNS it before `register()` is legal for it.
// That rule is what took the GUI down — v0.7.1 claimed `tool.call.toolview`
// with a bare `register()`, the seat's owner (ui-tool's
// `conversation.chat.node` entry) had not applied yet, and the throw escaped
// `apply()` as a failed loader entry: HARNESS "Failed to load plugins".
//
// So the boot below starts with NOTHING declared — the worst case the client
// graph can hand us — and asserts that the panel waits for each seat instead of
// racing it.

const effects = [];
const tabTypes = [];
const slots = createSlotsStub();
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
  slots,
};
assert.doesNotThrow(() => module.apply(ctx), 'apply() must not require any seat to be declared yet');

assert.deepEqual(effects, [
  'molbio panel: tab type',
  'molbio panel: tab body',
  'molbio panel: tab title',
  'molbio panel: papers tab type',
  'molbio panel: papers tab body',
  'molbio panel: papers tab title',
  'molbio panel: molbio_plasmid_map card',
  'molbio panel: molbio_plasmid_map_file card',
]);
assert.equal(tabTypes.length, 2, 'the package contributes two page tab types');
assert.deepEqual(
  tabTypes.map((type) => [type.id, type.kind, type.title()]),
  [['dsh-molbio-tools', 'molbio-panel', 'Molbio'], ['dsh-molbio-tools/papers', 'molbio-papers', 'Papers']],
);
for (const type of tabTypes) {
  assert.equal(type.patterns, undefined, 'a page type declares no resource patterns');
  assert.equal(type.priority, undefined, 'the default priority band is extension (third-party)');
  assert.equal(type.guide.length, 1, 'each type offers one guide capsule');
}
assert.equal(tabTypes[0].guide[0].title(), 'Molbio');
assert.equal(tabTypes[1].guide[0].title(), 'Papers');
assert.deepEqual(tabTypes.map((type) => type.guide[0].order), [40, 41], 'the guide entries have a stable order');
assert.equal(slots.registrations.length, 0, 'nothing registers before its seat exists');
assert.deepEqual(
  slots.injectedSeats,
  ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'tool.call.toolview'],
  'each seat is claimed by waiting for its declaration, not by registering blindly',
);
// The shell's guard, reproduced on the stub: this is the exact exception a bare
// register raised inside apply() — and therefore the failed loader entry.
assert.throws(
  () => slots.register({ name: 'tool.call.toolview', key: 'molbio_plasmid_map' }, () => null),
  /slot "tool\.call\.toolview" is not declared \(a parent entry's children table must declare it\)/,
);

// The right sidebar declares its seats; the transcript seat belongs to ui-tool
// and stays undeclared until that package's entry lands.
slots.declare('sidebar.right.pane.tab');
slots.declare('sidebar.right.pane.tab.title');
assert.deepEqual(
  slots.pendingSeats,
  ['tool.call.toolview'],
  'the transcript card is still waiting for the seat ui-tool declares',
);
assert.equal(slots.registrations.length, 4, 'both tab bodies and titles land as soon as their seat exists');
slots.declare('tool.call.toolview');

// Body + title register in the keyed seats under each type's id, and the two
// map tools claim their own `tool.call.toolview` key (an unclaimed key falls
// back to the generic tool row, so claiming ours is additive).
assert.deepEqual(
  slots.registrations.map((entry) => [entry.registration.name, entry.registration.key]),
  [
    ['sidebar.right.pane.tab', 'dsh-molbio-tools'],
    ['sidebar.right.pane.tab', 'dsh-molbio-tools/papers'],
    ['sidebar.right.pane.tab.title', 'dsh-molbio-tools'],
    ['sidebar.right.pane.tab.title', 'dsh-molbio-tools/papers'],
    ['tool.call.toolview', 'molbio_plasmid_map'],
    ['tool.call.toolview', 'molbio_plasmid_map_file'],
  ],
);
const claim = (name, key) => slots.registrations.find(
  (entry) => entry.registration.name === name && entry.registration.key === key,
);
assert.equal(typeof claim('sidebar.right.pane.tab', 'dsh-molbio-tools').component, 'function', 'the plasmid body is a component');
assert.equal(typeof claim('sidebar.right.pane.tab', 'dsh-molbio-tools/papers').component, 'function', 'the papers body is a component');
assert.equal(typeof claim('tool.call.toolview', 'molbio_plasmid_map').component, 'function', 'the map card is a component');
for (const key of ['dsh-molbio-tools', 'dsh-molbio-tools/papers']) {
  const face = claim('sidebar.right.pane.tab', key).registration.inject('session-1', {});
  assert.equal(typeof face.remote.workspaceFiles.list, 'function', 'the inject factory hands the body the workspace Remote');
  // `sessionId` and `useSessions` come from the slot runtime, not from this
  // factory: the framework turns every root hook source into a `use<Name>` prop.
  assert.equal(Object.keys(face).join(','), 'remote', 'the body injects nothing the framework already provides');
}
// The map card needs no inject factory at all: its block carries the meta the
// tool declared, so it stays a pure function of the call.
assert.equal(claim('tool.call.toolview', 'molbio_plasmid_map').registration.inject, undefined, 'the map card declares no injection');

// A re-declaration of the seat (the shell's declaration-epoch rule) re-runs the
// wait: the previous entries are disposed first, so claims never accumulate.
slots.declare('tool.call.toolview');
assert.equal(slots.registrations.length, 6, 're-declaring the seat re-installs both cards instead of duplicating them');

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

// ── 4. the literature panel's data path ─────────────────────────────────────

// readWorkspaceText: ok / missing / error are three distinct answers — an
// absent papers.json is an EMPTY LIBRARY, a broken one is an ERROR, and the
// panel must not show "0 papers" for either of the latter two.
const library = {
  papers: [
    {
      id: 'pmid:12345',
      title: 'KRAS G12D inhibition in pancreatic models',
      authors: 'Smith J, Doe A, Roe B',
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
      url: 'https://example.org/review',
      tags: ['crispr'],
      added_at: '2026-09-05',
    },
    { id: 'title:No metadata', title: 'No metadata' },
  ],
};
const remoteStub = (answer) => ({
  workspaceFiles: {
    async read() { return answer; },
  },
});
const okRead = await panelCore.readWorkspaceText(remoteStub({ ok: true, value: { text: JSON.stringify(library) } }), 's1', 'papers.json');
assert.equal(okRead.kind, 'text');
const missingRead = await panelCore.readWorkspaceText(
  remoteStub({ ok: false, error: { code: 'workspace-file/not-found', message: '"papers.json" does not exist' } }),
  's1',
  'papers.json',
);
assert.equal(missingRead.kind, 'missing');
const failedRead = await panelCore.readWorkspaceText(
  remoteStub({ ok: false, error: { code: 'workspace-file/too-large', message: 'too big' } }),
  's1',
  'papers.json',
);
assert.equal(failedRead.kind, 'error');
assert.match(failedRead.message, /too big/);
const threwRead = await panelCore.readWorkspaceText({
  workspaceFiles: { async read() { throw new Error('socket closed'); } },
}, 's1', 'papers.json');
assert.equal(threwRead.kind, 'error');
assert.match(threwRead.message, /socket closed/);

const parsedLibrary = panelCore.parseLibrary(JSON.stringify(library));
assert.equal(parsedLibrary.papers.length, 3);
// The same document the tool would load (papers.mjs contract: {papers: [...]}).
const nodeLibrary = JSON.parse(JSON.stringify(library));
assert.deepEqual(parsedLibrary.papers.map((paper) => paper.id), nodeLibrary.papers.map((paper) => paper.id));
assert.throws(() => panelCore.parseLibrary('{'), /not valid JSON/);
assert.throws(() => panelCore.parseLibrary('{"items":[]}'), /must be an object with a "papers" array/);
assert.deepEqual(panelCore.parseLibrary('{"papers":[null,1,{"title":"x"}]}').papers, [{ title: 'x' }]);

const tags = panelCore.libraryTags(parsedLibrary.papers);
assert.deepEqual(tags.map((entry) => entry.tag), ['crispr', 'inhibitor', 'kras'], 'tags sort by count then name');
assert.deepEqual(tags.map((entry) => entry.count), [1, 1, 1]);

// Filtering: newest added_at first; query matches every text field.
assert.deepEqual(
  panelCore.filterPapers(parsedLibrary.papers).map((paper) => paper.title),
  ['CRISPR screening review', 'KRAS G12D inhibition in pancreatic models', 'No metadata'],
  'default order is newest-added first',
);
assert.deepEqual(panelCore.filterPapers(parsedLibrary.papers, { tag: 'kras' }).map((paper) => paper.pmid), ['12345']);
assert.deepEqual(panelCore.filterPapers(parsedLibrary.papers, { query: 'doe' }).map((paper) => paper.pmid), ['12345'], 'query matches authors');
assert.deepEqual(panelCore.filterPapers(parsedLibrary.papers, { query: 'example.org' }).map((paper) => paper.title), ['CRISPR screening review']);
assert.deepEqual(panelCore.filterPapers(parsedLibrary.papers, { query: 'KRAS', tag: 'crispr' }), [], 'tag and query compose as AND');
assert.equal(panelCore.filterPapers(parsedLibrary.papers, { query: '   ' }).length, 3, 'a blank query keeps everything');

// Detail fields: fixed order, empty values skipped.
assert.deepEqual(
  panelCore.paperFields(parsedLibrary.papers[0]),
  [
    { key: 'authors', label: 'Authors', value: 'Smith J, Doe A, Roe B' },
    { key: 'journal', label: 'Journal', value: 'Nature' },
    { key: 'year', label: 'Year', value: '2024' },
    { key: 'pmid', label: 'PMID', value: '12345' },
    { key: 'added_at', label: 'Added', value: '2026-09-01' },
  ],
);
assert.deepEqual(panelCore.paperFields(parsedLibrary.papers[2]), [], 'a bare paper has no detail rows');
assert.equal(panelCore.paperSummary(parsedLibrary.papers[0]), 'Smith J et al. · Nature · 2024');
assert.equal(panelCore.paperSummary(parsedLibrary.papers[1]), 'Lee K · 2023');
assert.equal(panelCore.paperSummary(parsedLibrary.papers[2]), '');
// Links: an explicit url wins, else the PubMed page for the PMID, else none.
assert.equal(panelCore.paperLink(parsedLibrary.papers[0]), 'https://pubmed.ncbi.nlm.nih.gov/12345/');
assert.equal(panelCore.paperLink(parsedLibrary.papers[1]), 'https://example.org/review');
assert.equal(panelCore.paperLink(parsedLibrary.papers[2]), undefined);
assert.equal(panelCore.LIBRARY_FILE, 'papers.json');
// The panel's file path matches the tool's default (papers.mjs DEFAULT_LIBRARY_FILE).
const { DEFAULT_LIBRARY_FILE } = await import('../papers.mjs');
assert.equal(panelCore.LIBRARY_FILE, DEFAULT_LIBRARY_FILE);

console.log('client bundle format checks passed');
console.log('panel data path checks passed');
