/**
 * dsh-molbio-tools/snapgene.mjs
 *
 * SnapGene .dna binary file parser. The modern format is a sequence of
 * packets — [1 byte type][4 bytes big-endian length][data] — starting with a
 * cookie packet (type 0x09), then the DNA packet (type 0x00: flags + sequence
 * bytes), then optional XML packets: 0x0A features, 0x05 primers, 0x06 notes,
 * 0x08 additional sequence properties. Older packed binary features are not
 * supported. Zero dependencies: includes a minimal XML scanner.
 */

import { MolbioInputError } from './lib.mjs';

// ── minimal XML scanner ─────────────────────────────────────────────────────

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
    return named[entity] ?? match;
  });
}

/** Parse a well-formed XML document into a plain node tree. Tolerant of whitespace. */
export function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      if (end === -1) break;
      stack[stack.length - 1].text += text.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (text[i + 1] === '/') {
      const end = text.indexOf('>', i);
      if (end === -1) break;
      const tag = text.slice(i + 2, end).trim();
      if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop();
      i = end + 1;
      continue;
    }
    const end = text.indexOf('>', i);
    if (end === -1) break;
    let inner = text.slice(i + 1, end);
    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1).trimEnd();
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(inner);
    if (nameMatch === null) {
      i = end + 1;
      continue;
    }
    const node = { tag: nameMatch[1], attrs: {}, children: [], text: '' };
    const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = attrRe.exec(inner)) !== null) node.attrs[match[1]] = decodeEntities(match[2]);
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = end + 1;
  }
  return root;
}

function attrOf(node, name) {
  return Object.hasOwn(node.attrs, name) ? node.attrs[name] : undefined;
}

function childrenOf(node, tag) {
  return node.children.filter((child) => child.tag === tag);
}

/** Strip SnapGene's embedded HTML (values wrap text in <html><body>…) and decode leftovers. */
export function stripHtml(value) {
  return decodeEntities(String(value)
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// ── packet walking ──────────────────────────────────────────────────────────

const PACKET_COOKIE = 0x09;
const PACKET_DNA = 0x00;
const PACKET_FEATURES = 0x0a;
const PACKET_PRIMERS = 0x05;
const PACKET_NOTES = 0x06;

/**
 * Parse one SnapGene .dna file.
 * @param {Uint8Array} bytes - the raw file content.
 * @returns {object} { name, length, topology, features, sequence, description?, accession?, primers? }
 */
export function parseSnapGeneBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new MolbioInputError('snapgene bytes must be a Uint8Array');
  if (bytes.length < 24) throw new MolbioInputError('file is too small to be a SnapGene .dna record');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let off = 0;
  if (bytes[off] !== PACKET_COOKIE) throw new MolbioInputError('not a SnapGene .dna file (missing cookie packet)');
  const cookieLength = view.getUint32(off + 1);
  off += 1 + 4 + cookieLength;
  if (off + 6 > bytes.length) throw new MolbioInputError('truncated SnapGene file (no DNA packet)');
  if (bytes[off] !== PACKET_DNA) throw new MolbioInputError('unexpected SnapGene layout (missing DNA packet)');

  const dnaLength = view.getUint32(off + 1);
  const flags = bytes[off + 5];
  const seqBytes = bytes.slice(off + 6, off + 6 + dnaLength - 1);
  const sequence = decodeSequence(seqBytes);
  off += 1 + 4 + dnaLength;

  let featuresXml;
  let primersXml;
  let notesXml;
  while (off + 5 <= bytes.length) {
    const type = bytes[off];
    const length = view.getUint32(off + 1);
    if (off + 5 + length > bytes.length) break; // truncated tail; keep what we have
    const data = bytes.slice(off + 5, off + 5 + length);
    if (type === PACKET_FEATURES) featuresXml = new TextDecoder().decode(data).replace(/^\uFEFF/, '');
    else if (type === PACKET_PRIMERS) primersXml = new TextDecoder().decode(data).replace(/^\uFEFF/, '');
    else if (type === PACKET_NOTES) notesXml = new TextDecoder().decode(data).replace(/^\uFEFF/, '');
    off += 5 + length;
  }

  const features = featuresXml !== undefined ? parseFeaturesXml(featuresXml) : [];
  const primers = primersXml !== undefined ? parsePrimersXml(primersXml) : [];
  const notes = notesXml !== undefined ? parseNotesXml(notesXml) : {};
  const name = notes.customMapLabel ?? notes.accession ?? 'snapgene';

  return {
    name,
    length: sequence.length,
    topology: (flags & 0x01) !== 0 ? 'circular' : 'linear',
    features,
    sequence,
    ...notes.description !== undefined ? { description: notes.description } : {},
    ...notes.accession !== undefined ? { accession: notes.accession } : {},
    ...primers.length > 0 ? { primers } : {},
  };
}

/**
 * Decode the DNA packet's sequence bytes. Modern files store ASCII bases;
 * legacy files store one byte per base (0=A, 1=C, 2=G, 3=T; high bit =
 * lowercase). The encoding is auto-detected.
 */
function decodeSequence(seqBytes) {
  if (seqBytes.length === 0) return '';
  const ascii = [...seqBytes].every((byte) => byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122);
  if (ascii) return String.fromCharCode(...seqBytes).toUpperCase();
  let out = '';
  for (const byte of seqBytes) {
    const base = 'ACGT'[byte & 0x7f];
    if (base === undefined) {
      out += 'N';
      continue;
    }
    out += (byte & 0x80) !== 0 ? base.toLowerCase() : base;
  }
  return out.toUpperCase();
}

/** Parse the 0x0A features packet (XML). */
export function parseFeaturesXml(xml) {
  const doc = parseXml(xml);
  const root = childrenOf(doc, 'Features')[0];
  if (root === undefined) throw new MolbioInputError('SnapGene features packet is not in the expected XML format');
  const features = [];
  for (const element of childrenOf(root, 'Feature')) {
    const name = stripHtml(attrOf(element, 'name') ?? '');
    const type = attrOf(element, 'type') ?? 'misc_feature';
    const directionality = Number(attrOf(element, 'directionality') ?? 0);
    let start = Infinity;
    let end = 0;
    for (const segment of childrenOf(element, 'Segment')) {
      const range = attrOf(segment, 'range') ?? '';
      for (const part of range.split(':')) {
        const match = /^(\d+)-(\d+)$/.exec(part) ?? /^(\d+)$/.exec(part);
        if (match === null) continue;
        const a = Number(match[1]);
        const b = match[2] === undefined ? a : Number(match[2]);
        start = Math.min(start, a);
        end = Math.max(end, b);
      }
    }
    if (!Number.isFinite(start)) continue;
    const qualifiers = {};
    for (const q of childrenOf(element, 'Q')) {
      const key = attrOf(q, 'name');
      const v = childrenOf(q, 'V')[0];
      if (key === undefined || v === undefined) continue;
      const value = attrOf(v, 'text') ?? attrOf(v, 'int');
      if (value !== undefined) qualifiers[key] = stripHtml(value);
    }
    features.push({
      type,
      start,
      end,
      strand: directionality === 1 ? 1 : directionality === 2 ? -1 : 1,
      label: name !== '' ? name : qualifiers.product ?? qualifiers.gene ?? type,
      ...qualifiers.gene !== undefined ? { gene: qualifiers.gene } : {},
      ...qualifiers.product !== undefined ? { product: qualifiers.product } : {},
      ...qualifiers.note !== undefined ? { note: qualifiers.note } : {},
    });
  }
  return features;
}

/** Parse the 0x05 primers packet (XML). */
export function parsePrimersXml(xml) {
  const doc = parseXml(xml);
  const root = childrenOf(doc, 'Primers')[0];
  if (root === undefined) return [];
  const primers = [];
  for (const element of childrenOf(root, 'Primer')) {
    const name = stripHtml(attrOf(element, 'name') ?? '');
    const binding = childrenOf(element, 'BindingSite')[0];
    const sequence = childrenOf(element, 'Sequence')[0];
    const primer = { name };
    const location = binding !== undefined ? attrOf(binding, 'location') : undefined;
    if (location !== undefined) primer.location = location;
    const boundStrand = binding !== undefined ? attrOf(binding, 'boundStrand') : undefined;
    if (boundStrand !== undefined) primer.bound_strand = boundStrand;
    if (sequence !== undefined && sequence.text.trim() !== '') primer.sequence = sequence.text.trim().toUpperCase();
    primers.push(primer);
  }
  return primers;
}

/** Parse the 0x06 notes packet (XML): map label, description, accession, organism. */
export function parseNotesXml(xml) {
  const doc = parseXml(xml);
  const root = childrenOf(doc, 'Notes')[0];
  if (root === undefined) return {};
  const read = (tag) => {
    const element = childrenOf(root, tag)[0];
    return element === undefined ? undefined : stripHtml(element.text);
  };
  const notes = {};
  for (const [key, tag] of [['customMapLabel', 'CustomMapLabel'], ['description', 'Description'], ['accession', 'AccessionNumber'], ['organism', 'Organism']]) {
    const value = read(tag);
    if (value !== undefined && value !== '') notes[key] = value;
  }
  return notes;
}
