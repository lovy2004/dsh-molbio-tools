/**
 * dsh-molbio-tools/lib.mjs
 *
 * Pure molecular-biology computation library. No runtime dependencies:
 * every function is deterministic, synchronous, and accepts/returns lossless
 * JSON data. Intended to be bundled beside the plugin entry (index.mjs) so the
 * whole package can travel with an agent preset directory.
 */

// ── IUPAC DNA alphabet ──────────────────────────────────────────────────────

export const DNA_BASES = new Set(['A', 'C', 'G', 'T']);

const IUPAC_EXPAND = {
  A: ['A'], C: ['C'], G: ['G'], T: ['T'],
  R: ['A', 'G'], Y: ['C', 'T'], S: ['C', 'G'], W: ['A', 'T'],
  K: ['G', 'T'], M: ['A', 'C'],
  B: ['C', 'G', 'T'], D: ['A', 'G', 'T'], H: ['A', 'C', 'T'],
  V: ['A', 'C', 'G'], N: ['A', 'C', 'G', 'T'],
};

// Self-inverse IUPAC complement; U is accepted in input and treated as T.
const COMPLEMENT = {
  A: 'T', T: 'A', G: 'C', C: 'G', U: 'A',
  R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
  B: 'V', V: 'B', D: 'H', H: 'D', N: 'N',
};

export class MolbioInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MolbioInputError';
  }
}

/**
 * Normalize a raw sequence: uppercase, strip whitespace and digits (FASTA
 * residue numbers), reject characters outside the IUPAC DNA/RNA alphabet.
 * @param {string} raw - the raw input.
 * @param {string} label - used in error messages ("sequence", "primer1").
 * @returns {string} the normalized sequence.
 */
export function normalizeSequence(raw, label = 'sequence') {
  if (typeof raw !== 'string') throw new MolbioInputError(`${label} must be a string`);
  const cleaned = raw.toUpperCase().replace(/[\s\d]/g, '');
  if (cleaned.length === 0) throw new MolbioInputError(`${label} contains no bases after stripping whitespace and digits`);
  const limit = 1_000_000;
  if (cleaned.length > limit) throw new MolbioInputError(`${label} is too long (${cleaned.length} bases; limit ${limit})`);
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (!Object.hasOwn(COMPLEMENT, char)) {
      throw new MolbioInputError(`${label} contains invalid character ${JSON.stringify(char)} at position ${i + 1}; expected IUPAC DNA/RNA bases (A C G T U R Y S W K M B D H V N)`);
    }
  }
  return cleaned;
}

/** Complement (U treated as T). */
export function complement(seq) {
  let out = '';
  for (const char of seq) out += COMPLEMENT[char];
  return out;
}

/** Reverse complement (U treated as T). */
export function reverseComplement(seq) {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]];
  return out;
}

/** GC percent over unambiguous bases, plus counts. */
export function baseCounts(seq) {
  let gc = 0, at = 0, n = 0;
  for (const char of seq) {
    if (char === 'G' || char === 'C') gc++;
    else if (char === 'A' || char === 'T' || char === 'U') at++;
    else n++;
  }
  return { gc, at, n };
}

function percent(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 10000) / 100;
}

// ── translation ─────────────────────────────────────────────────────────────

export const CODON_TABLE = {}; // built from strings below

(function buildCodonTable() {
  const bases = ['T', 'C', 'A', 'G'];
  const standard = [
    'FFLLSSSSYY**CC*W', 'LLLLPPPPHHQQRRRR', 'IIIMTTTTNNKKSSRR', 'VVVVAAAADDEEGGGG',
  ];
  const rows = { standard };
  rows.bacterial = ['FFLLSSSSYY**CCWW', 'LLLLPPPPHHQQRRRR', 'IIIMTTTTNNKKSSRR', 'VVVVAAAADDEEGGGG'];
  rows.mitochondrial_vertebrate = ['FFLLSSSSYY**CCWW', 'LLLLPPPPHHQQRRRR', 'IIMMTTTTNNKKSSRR', 'VVVVAAAADDEEGGGG'];
  for (const [code, table] of Object.entries(rows)) {
    const map = {};
    for (let first = 0; first < 4; first++) {
      for (let second = 0; second < 4; second++) {
        for (let third = 0; third < 4; third++) {
          map[bases[first] + bases[second] + bases[third]] = table[first][second * 4 + third];
        }
      }
    }
    CODON_TABLE[code] = map;
  }
})();

export const GENETIC_CODES = Object.keys(CODON_TABLE);

function toDna(seq) {
  return seq.replaceAll('U', 'T');
}

function orfsInFrame(seq, minOrfAa) {
  const starts = ['ATG'];
  const orfs = [];
  let index = 0;
  while (index + 3 <= seq.length) {
    const codon = seq.slice(index, index + 3);
    if (!starts.includes(codon)) {
      index += 3;
      continue;
    }
    let cursor = index;
    let protein = '';
    let end = -1;
    while (cursor + 3 <= seq.length) {
      const aa = CODON_TABLE.standard[seq.slice(cursor, cursor + 3)];
      if (aa === '*') {
        end = cursor;
        break;
      }
      protein += aa;
      cursor += 3;
    }
    if (end === -1) {
      index += 3; // run off the end without a stop; move on
      continue;
    }
    if (protein.length >= minOrfAa) {
      orfs.push({
        start: index,
        end: end + 2, // inclusive, 0-based
        length_aa: protein.length,
        sequence: protein,
      });
    }
    index = end + 3; // restart after the stop codon
  }
  return orfs;
}

/**
 * Translate a DNA/RNA sequence in one or more frames.
 * @returns {Array<{frame: string, protein: string, length: number, stops: number, first_stop: number|null}>}
 */
export function translateFrames(seq, frames, code, minOrfAa = 0) {
  const dna = toDna(seq);
  const selected = frames === 'all' ? [1, 2, 3, -1, -2, -3] : [frames];
  const results = [];
  for (const frame of selected) {
    const template = frame < 0 ? reverseComplement(dna) : dna;
    const offset = Math.abs(frame) - 1;
    let protein = '';
    let stops = 0;
    let firstStop = null;
    for (let i = offset; i + 3 <= template.length; i += 3) {
      const aa = CODON_TABLE[code][template.slice(i, i + 3)];
      if (aa === '*') {
        stops++;
        if (firstStop === null) firstStop = i; // 0-based on the frame's template
      }
      protein += aa;
    }
    results.push({
      frame: String(frame),
      protein,
      length: protein.length,
      stops,
      first_stop: firstStop,
    });
  }
  const orfs = [];
  if (minOrfAa > 0) {
    const positive = selected.filter((f) => f > 0).map((f) => ({ f, seq: dna.slice(Math.abs(f) - 1) }));
    for (const { f, seq } of positive) {
      for (const orf of orfsInFrame(seq, minOrfAa)) {
        orfs.push({
          frame: String(f),
          start: orf.start + (Math.abs(f) - 1),
          end: orf.end + (Math.abs(f) - 1),
          length_aa: orf.length_aa,
          sequence: orf.sequence,
        });
      }
    }
    const negative = selected.filter((f) => f < 0).map((f) => ({ f, seq: reverseComplement(dna).slice(Math.abs(f) - 1) }));
    for (const { f, seq } of negative) {
      for (const orf of orfsInFrame(seq, minOrfAa)) {
        const length = dna.length;
        orfs.push({
          frame: String(f),
          start: length - 1 - (orf.end + (Math.abs(f) - 1)),
          end: length - 1 - (orf.start + (Math.abs(f) - 1)),
          length_aa: orf.length_aa,
          sequence: orf.sequence,
        });
      }
    }
    orfs.sort((a, b) => b.length_aa - a.length_aa || a.start - b.start);
  }
  return { results, orfs };
}

// ── restriction enzymes ─────────────────────────────────────────────────────

/**
 * Common restriction enzymes, recognition site in IUPAC code, `^` marks the
 * phosphodiester cut. Only unambiguous sequence bases match pattern letters;
 * a pattern letter that is an ambiguity code expands to its base set.
 */
export const ENZYMES = {
  AgeI: 'A^CCGGT',
  ApaI: 'GGGCC^C',
  AscI: 'GG^CGCGCC',
  AvrII: 'C^CTAGG',
  BamHI: 'G^GATCC',
  BclI: 'T^GATCA',
  BglII: 'A^GATCT',
  BstBI: 'TT^CGAA',
  BstEII: 'G^GTNACC',
  BstXI: 'CCANNNNN^NTGG',
  Bsu36I: 'CC^TNAGG',
  ClaI: 'AT^CGAT',
  DraI: 'TTT^AAA',
  EagI: 'C^GGCCG',
  EcoNI: 'CCTNN^NNNAGG',
  EcoRI: 'G^AATTC',
  EcoRV: 'GAT^ATC',
  FseI: 'GGCCGG^CC',
  HindIII: 'A^AGCTT',
  HpaI: 'GTT^AAC',
  KpnI: 'GGTAC^C',
  MfeI: 'C^AATTG',
  MluI: 'A^CGCGT',
  NcoI: 'C^CATGG',
  NdeI: 'CA^TATG',
  NheI: 'G^CTAGC',
  NotI: 'GC^GGCCGC',
  NruI: 'TCG^CGA',
  NsiI: 'ATGCA^T',
  PacI: 'TTAAT^TAA',
  PmeI: 'GTTT^AAAC',
  PmlI: 'CAC^GTG',
  PshAI: 'GACNN^NNGTC',
  PspOMI: 'G^GGCCC',
  PstI: 'CTGCA^G',
  PvuII: 'CAG^CTG',
  RsrII: 'CG^GWCCG',
  SacI: 'GAGCT^C',
  SacII: 'CCGC^GG',
  SalI: 'G^TCGAC',
  SbfI: 'CCTGCA^GG',
  ScaI: 'AGT^ACT',
  SexAI: 'A^CCWGGT',
  SfiI: 'GGCCNNNN^NGGCC',
  SgrAI: 'CR^CCGGYG',
  SmaI: 'CCC^GGG',
  SpeI: 'A^CTAGT',
  SphI: 'GCATG^C',
  StuI: 'AGG^CCT',
  XbaI: 'T^CTAGA',
  XhoI: 'C^TCGAG',
  XmaI: 'C^CCGGG',
  XmnI: 'GAANN^NNTTC',
  // additional common enzymes
  AatII: 'GACGT^C',
  Acc65I: 'G^GTACC',
  AflII: 'C^TTAAG',
  AleI: 'CACNN^NNGTG',
  AseI: 'AT^TAAT',
  BglI: 'GCCNNNN^NGGC',
  BmtI: 'GCTAG^C',
  BsaAI: 'YAC^GTR',
  BspEI: 'T^CCGGA',
  BsrGI: 'T^GTACA',
  BssHII: 'G^CGCGC',
  BstAPI: 'GCANNNN^NTGC',
  BstYI: 'R^GATCY',
  BstZ17I: 'GTA^TAC',
  BtgI: 'C^CRYGG',
  DraIII: 'CACNNN^GTG',
  FspI: 'TGC^GCA',
  HincII: 'GTY^RAC',
  KasI: 'G^GCGCC',
  MscI: 'TGG^CCA',
  NaeI: 'GCC^GGC',
  NarI: 'GG^CGCC',
  NgoMIV: 'G^CCGGC',
  PaeR7I: 'C^TCGAG',
  PciI: 'A^CATGT',
  PluTI: 'GGCGC^C',
  PpuMI: 'RG^GWCCY',
  PsiI: 'TTA^TAA',
  PvuI: 'CGAT^CG',
  SfoI: 'GGC^GCC',
  SnaBI: 'TAC^GTA',
  SrfI: 'GCCC^GGGC',
  SspI: 'AAT^ATT',
  TspMI: 'C^CCGGG',
  XcmI: 'CCANNNNN^NNNNTGG',
  ZraI: 'GAC^GTC',
  // type IIS enzymes: { site, cut (top-strand cut offset from site start), bottom }
  // e.g. BsaI GGTCTC(1/5) cuts 1 base after the site on top, 5 on the bottom.
  BsaI: { site: 'GGTCTC', cut: 7, bottom: 5 },
  BsmBI: { site: 'CGTCTC', cut: 7, bottom: 5 },
  Esp3I: { site: 'CGTCTC', cut: 7, bottom: 5 },
  BbsI: { site: 'GAAGAC', cut: 8, bottom: 6 },
  BspQI: { site: 'GCTCTTC', cut: 8, bottom: 4 },
  SapI: { site: 'GCTCTTC', cut: 8, bottom: 4 },
  LguI: { site: 'GCTCTTC', cut: 8, bottom: 4 },
  PaqCI: { site: 'CACCTGC', cut: 11, bottom: 8 },
  AarI: { site: 'CACCTGC', cut: 11, bottom: 8 },
  BfuAI: { site: 'ACCTGC', cut: 10, bottom: 8 },
  BveI: { site: 'ACCTGC', cut: 10, bottom: 8 },
  BtgZI: { site: 'GCGATG', cut: 16, bottom: 14 },
  BsmFI: { site: 'GGGAC', cut: 15, bottom: 14 },
  FokI: { site: 'GGATG', cut: 14, bottom:13 },
};

export const ENZYME_NAMES = Object.keys(ENZYMES).sort();

/**
 * Recognition pattern + top-strand cut for one enzyme.
 * Ordinary enzymes: string 'G^AATTC' (cut marked inside the site).
 * Type IIS enzymes: { site, cut, bottom } with the cut offset possibly beyond
 * the site end; the display uses the standard (top/bottom) notation.
 */
export function enzymePattern(name) {
  const entry = ENZYMES[name];
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') {
    const cut = entry.indexOf('^');
    return { pattern: entry.replace('^', ''), cutOffset: cut, display: entry, iis: false };
  }
  const overhang = entry.cut - entry.site.length;
  return {
    pattern: entry.site,
    cutOffset: entry.cut,
    display: `${entry.site}(${overhang}/${entry.bottom})`,
    iis: true,
    bottom: entry.bottom,
  };
}

/** True when the enzyme is a type IIS enzyme (cut outside the recognition site). */
export function isIisEnzyme(name) {
  return typeof ENZYMES[name] === 'object';
}

/**
 * Every recognition event of one enzyme on `seq`, both strand orientations
 * (v13). Forward = the recognition pattern appears on the top strand (the
 * enzyme cuts downstream of the site); reverse = its reverse complement
 * appears on the top strand (the enzyme binds the bottom strand and cuts
 * upstream of the site in top-strand coordinates). Palindromic patterns are
 * scanned once. Unlike digest(), which reports only the top-strand cut of
 * forward matches, this is the enzyme's complete cut set — a type IIS enzyme
 * such as BsaI also cuts at reverse-complemented recognition sites.
 * @returns {Array<{start, orientation, cut_position}>} 0-based positions.
 */
export function enzymeCuts(seq, name) {
  const resolved = enzymePattern(name);
  if (resolved === undefined) throw new MolbioInputError(`unknown enzyme ${JSON.stringify(name)}; available: ${ENZYME_NAMES.join(', ')}`);
  const { pattern, cutOffset } = resolved;
  const out = [];
  for (const match of findAllMatches(seq, pattern)) {
    out.push({
      start: match.start,
      orientation: 'forward',
      cut_position: Math.min(seq.length, Math.max(0, match.start + cutOffset)),
    });
  }
  const rcPattern = reverseComplement(pattern);
  if (rcPattern !== pattern) {
    for (const match of findAllMatches(seq, rcPattern)) {
      out.push({
        start: match.start,
        orientation: 'reverse',
        cut_position: Math.min(seq.length, Math.max(0, match.start + pattern.length - cutOffset)),
      });
    }
  }
  out.sort((a, b) => a.cut_position - b.cut_position || a.start - b.start || (a.orientation === 'forward' ? -1 : 1));
  return out;
}

/** Fragment sizes from 0-based top-strand cut positions (digest semantics). */
function fragmentSizes(length, positions, circular) {
  if (positions.length === 0) return [length];
  if (circular) {
    if (positions.length === 1) return [length];
    const fragments = [];
    for (let i = 0; i < positions.length; i++) {
      const a = positions[i];
      const b = positions[(i + 1) % positions.length];
      fragments.push(i === positions.length - 1 ? length - a + b : b - a);
    }
    return fragments.sort((a, b) => b - a);
  }
  const fragments = [positions[0]];
  for (let i = 1; i < positions.length; i++) fragments.push(positions[i] - positions[i - 1]);
  fragments.push(length - positions[positions.length - 1]);
  return fragments.filter((f) => f > 0).sort((a, b) => b - a);
}

/**
 * Structured catalog entry for one enzyme (v13): recognition site, cut
 * geometry (standard (N/N) notation for type IIS), overhang length, and —
 * when a sequence is given — the complete cut set (both orientations) with
 * fragment sizes.
 */
export function enzymeCatalog(name, sequence, circular) {
  const resolved = enzymePattern(name);
  if (resolved === undefined) throw new MolbioInputError(`unknown enzyme ${JSON.stringify(name)}; available: ${ENZYME_NAMES.join(', ')}`);
  const entry = {
    name,
    site: resolved.display,
    recognition: resolved.pattern,
    iis: resolved.iis,
    cut_offset: resolved.cutOffset,
    palindromic: reverseComplement(resolved.pattern) === resolved.pattern,
  };
  if (resolved.iis) {
    entry.bottom_cut = resolved.bottom;
    entry.overhang_length = resolved.pattern.length + resolved.bottom - resolved.cutOffset;
  }
  if (sequence !== undefined) {
    const cuts = enzymeCuts(sequence, name);
    entry.cuts = cuts.length;
    entry.cut_events = cuts.map((cut) => ({
      start: cut.start + 1,
      orientation: cut.orientation,
      cut_position: cut.cut_position + 1,
    }));
    entry.fragments = fragmentSizes(sequence.length, cuts.map((cut) => cut.cut_position), circular === true);
  }
  return entry;
}

function matchAt(seq, pattern, start) {
  for (let i = 0; i < pattern.length; i++) {
    const base = seq[start + i];
    if (!DNA_BASES.has(base)) return false; // ambiguous bases in the target never match
    const allowed = IUPAC_EXPAND[pattern[i]];
    if (!allowed.includes(base)) return false;
  }
  return true;
}

function findAllMatches(seq, pattern) {
  const found = [];
  const last = seq.length - pattern.length;
  for (let start = 0; start <= last; start++) {
    if (matchAt(seq, pattern, start)) {
      found.push({ start, end: start + pattern.length - 1, sequence: seq.slice(start, start + pattern.length) });
    }
  }
  return found;
}

/**
 * Digest one sequence with one or more enzymes.
 * @returns {Array<{name, site, matches, cut_positions, fragments}>}
 */
export function digest(seq, enzymeNames, circular) {
  const out = [];
  for (const name of enzymeNames) {
    const resolved = enzymePattern(name);
    if (resolved === undefined) throw new MolbioInputError(`unknown enzyme ${JSON.stringify(name)}; available: ${ENZYME_NAMES.join(', ')}`);
    const { pattern, cutOffset, display } = resolved;
    const matches = findAllMatches(seq, pattern);
    const cutPositions = matches.map((m) => Math.min(seq.length, Math.max(0, m.start + cutOffset)));
    let fragments;
    if (circular) {
      if (matches.length === 0) {
        fragments = [seq.length];
      } else if (matches.length === 1) {
        fragments = [seq.length];
      } else {
        fragments = [];
        for (let i = 0; i < cutPositions.length; i++) {
          const a = cutPositions[i];
          const b = cutPositions[(i + 1) % cutPositions.length];
          const span = (i === cutPositions.length - 1 ? seq.length - a + b : b - a);
          fragments.push(span);
        }
      }
    } else {
      if (matches.length === 0) {
        fragments = [seq.length];
      } else {
        fragments = [cutPositions[0]];
        for (let i = 1; i < cutPositions.length; i++) fragments.push(cutPositions[i] - cutPositions[i - 1]);
        fragments.push(seq.length - cutPositions[cutPositions.length - 1]);
        fragments = fragments.filter((f) => f > 0);
      }
    }
    out.push({
      name,
      site: display,
      matches,
      cut_positions: cutPositions,
      fragments: fragments.sort((a, b) => b - a),
    });
  }
  return out;
}

// ── primer thermodynamics (SantaLucia 1998 nearest-neighbour) ──────────────

// Enthalpy kcal/mol, entropy cal/mol·K, 1 M NaCl, 37 °C.
const NN_DH = {
  AA: -7.9, AT: -7.2, TA: -7.2, CA: -8.5, GT: -8.4, CT: -7.8, GA: -8.2,
  CG: -10.6, GC: -9.8, GG: -8.0,
};
const NN_DS = {
  AA: -22.2, AT: -20.4, TA: -21.3, CA: -22.7, GT: -22.4, CT: -21.0, GA: -22.2,
  CG: -27.2, GC: -24.4, GG: -19.9,
};
const INIT_DH = 0.2;   // initiation, kcal/mol
const INIT_DS = -5.7;  // initiation, cal/mol·K
const TERM_AT_DH = 2.2;    // per terminal A/T pair, kcal/mol
const TERM_AT_DS = 6.9;    // per terminal A/T pair, cal/mol·K
const R = 1.9872; // cal/mol·K

// Complete 4×4 nearest-neighbour tables: the 10 canonical dimers plus their
// reverse-complement equivalents (NN(XY) ≡ NN(rc(YX)), e.g. AC = GT).
const NN_DH_FULL = {};
const NN_DS_FULL = {};
for (const pair of Object.keys(NN_DH)) {
  NN_DH_FULL[pair] = NN_DH[pair];
  NN_DS_FULL[pair] = NN_DS[pair];
  const rc = COMPLEMENT[pair[1]] + COMPLEMENT[pair[0]];
  NN_DH_FULL[rc] = NN_DH[pair];
  NN_DS_FULL[rc] = NN_DS[pair];
}

/**
 * Salt-adjusted nearest-neighbour melting temperature of one primer.
 * von Ahsen et al. (2001) magnesium equivalence, SantaLucia (1998) salt
 * correction on the duplex entropy. An ESTIMATE for primer design: it assumes
 * a non-self-complementary duplex and standard conditions.
 */
export function primerTm(seq, { naMm = 50, mgMm = 0, dntpMm = 0.8, primerNm = 500 } = {}) {
  const length = seq.length;
  if (length < 4) throw new MolbioInputError(`primer must be at least 4 bases for a NN Tm estimate (got ${length})`);
  const na = Math.max(0, naMm);
  const mg = Math.max(0, mgMm);
  const dntp = Math.max(0, dntpMm);
  const naEquivalent = na + 120 * Math.sqrt(Math.max(0, mg - dntp));
  let dh = INIT_DH;
  let ds = INIT_DS;
  for (let i = 0; i + 1 < length; i++) {
    const pair = seq[i] + seq[i + 1];
    dh += NN_DH_FULL[pair] ?? 0;
    ds += NN_DS_FULL[pair] ?? 0;
  }
  for (const end of [seq[0], seq[length - 1]]) {
    if (end === 'A' || end === 'T') {
      dh += TERM_AT_DH;
      ds += TERM_AT_DS;
    }
  }
  const saltCorrectedDs = ds + 0.368 * (length - 1) * Math.log(Math.max(naEquivalent, 1e-6) / 1000);
  const ct = Math.max(primerNm, 0.01) * 1e-9;
  // Both numerator (ΔH < 0) and denominator (ΔS_salt < 0, R·ln(Ct/4) < 0 for
  // sub-molar primer) are negative for any physical duplex, yielding Tm > 0.
  // A non-negative denominator means the parameters left the physical regime.
  const denominator = saltCorrectedDs + R * Math.log(ct / 4);
  if (denominator >= 0) throw new MolbioInputError('thermodynamic parameters are outside the physical regime (non-negative denominator); the salt-corrected Tm is undefined for this input');
  const tm = (dh * 1000) / denominator - 273.15;
  if (!Number.isFinite(tm) || tm <= 0 || tm > 200) throw new MolbioInputError('Tm computation did not converge for this input');
  return {
    tm_celsius: Math.round(tm * 100) / 100,
    na_equivalent_mm: Math.round(naEquivalent * 100) / 100,
  };
}

// ── primer structure checks ─────────────────────────────────────────────────

export function findRuns(seq, minLength = 4) {
  const runs = [];
  let i = 0;
  while (i < seq.length) {
    const base = seq[i];
    let j = i + 1;
    while (j < seq.length && seq[j] === base) j++;
    const count = j - i;
    if (count >= minLength) runs.push({ base, count, start: i + 1 });
    i = j;
  }
  return runs;
}

export function findRepeats(seq, minUnit = 2, maxUnit = 5, minCount = 3) {
  const repeats = [];
  for (let unit = minUnit; unit <= maxUnit; unit++) {
    for (let start = 0; start + unit * minCount <= seq.length; start++) {
      const motif = seq.slice(start, start + unit);
      let count = 1;
      let cursor = start + unit;
      while (cursor + unit <= seq.length && seq.slice(cursor, cursor + unit) === motif) {
        count++;
        cursor += unit;
      }
      if (count >= minCount && count * unit >= 6) {
        repeats.push({ motif, count, start: start + 1 });
        start = cursor - unit - 1; // skip the repeat run; loop increment moves on
      }
    }
  }
  return repeats;
}

/** Count complementary pairs when two equal-length strings are aligned. */
function complementaryPairs(a, b) {
  let n = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!DNA_BASES.has(x) || !DNA_BASES.has(y)) continue;
    if (COMPLEMENT[x] === y) n++;
  }
  return n;
}

function maxConsecutivePairs(a, b) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i];
    const y = b[i];
    if (DNA_BASES.has(x) && DNA_BASES.has(y) && COMPLEMENT[x] === y) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Alignment-based self-complementarity. Pairs near the 3' end are weighted
 * double because 3' complementarity drives extension artifacts.
 */
export function selfComplementarity(seq) {
  const rc = reverseComplement(seq);
  const length = seq.length;
  const threePrimeZone = Math.min(5, length);
  let bestScore = 0;
  let bestConsecutive = 0;
  let threePrimePairs = 0;
  for (let offset = 1; offset < length; offset++) {
    const a = seq.slice(offset);
    const b = rc.slice(0, length - offset);
    let score = 0;
    let consecutive = 0;
    for (let i = 0; i < a.length; i++) {
      if (DNA_BASES.has(a[i]) && DNA_BASES.has(b[i]) && COMPLEMENT[a[i]] === b[i]) {
        consecutive++;
        const fromThreePrime = length - 1 - (offset + i);
        score += fromThreePrime < threePrimeZone ? 2 : 1;
      } else {
        consecutive = 0;
      }
      if (consecutive > bestConsecutive) bestConsecutive = consecutive;
    }
    if (score > bestScore) bestScore = score;
  }
  // Classic 3'-end self-complementarity: last 6 bases vs reverse complement of the whole primer tail.
  const tail = seq.slice(-6);
  for (let i = 0; i < tail.length; i++) {
    if (DNA_BASES.has(tail[i]) && DNA_BASES.has(rc[i]) && COMPLEMENT[tail[i]] === rc[i]) threePrimePairs++;
  }
  return { bestScore, bestConsecutive, threePrimePairs };
}

/**
 * Scan for hairpin stems (≥3 bp) with loops of 3–10 bases.
 * @returns top hairpins sorted by score.
 */
export function findHairpins(seq, limit = 3) {
  const rc = reverseComplement(seq);
  const found = [];
  for (let loop = 3; loop <= 10; loop++) {
    for (let stem = 3; stem <= 6; stem++) {
      const span = 2 * stem + loop;
      if (span > seq.length) continue;
      for (let start = 0; start + span <= seq.length; start++) {
        const arm1 = seq.slice(start, start + stem);
        const arm2 = seq.slice(start + stem + loop, start + span);
        const expected = rc.slice(seq.length - (start + span), seq.length - (start + stem + loop));
        const pairs = complementaryPairs(arm1, expected);
        if (pairs < stem) continue;
        let gc = 0;
        for (const base of arm1) if (base === 'G' || base === 'C') gc++;
        const score = pairs * 2 + gc + (loop <= 5 ? 1 : 0);
        found.push({ start: start + 1, stem, loop, pairs, score });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, limit);
}

/**
 * Inter-primer (dimer) potential: best complementary alignment between primer1
 * and the reverse complement of primer2, with 3'-end pairs weighted double.
 */
export function dimerPotential(p1, p2) {
  const rc2 = reverseComplement(p2);
  const length = p1.length;
  let bestScore = 0;
  let bestConsecutive = 0;
  let threePrimePairs = 0;
  // slide p1 over rc2 (p2's 3' end at offset 0), and rc2 over p1 (p1's 3' end at offset 0)
  for (const [a, b, tailOf] of [
    [p1, rc2, 'p2'],
    [rc2, p1, 'p1'],
  ]) {
    const tail = tailOf === 'p2' ? p2.slice(-6) : p1.slice(-6);
    let count = 0;
    for (let i = 0; i < tail.length && i < a.length; i++) {
      if (DNA_BASES.has(tail[i]) && DNA_BASES.has(a[i]) && COMPLEMENT[tail[i]] === a[i]) count++;
    }
    threePrimePairs = Math.max(threePrimePairs, count);
    for (let offset = 0; offset < length; offset++) {
      let score = 0;
      let consecutive = 0;
      const span = Math.min(a.length - offset, b.length);
      for (let i = 0; i < span; i++) {
        if (DNA_BASES.has(a[offset + i]) && DNA_BASES.has(b[i]) && COMPLEMENT[a[offset + i]] === b[i]) {
          consecutive++;
          const nearA3 = offset + i >= a.length - 5;
          const nearB3 = i <= 4; // b[0] is the 3' end of the second primer
          score += nearA3 || nearB3 ? 2 : 1;
        } else {
          consecutive = 0;
        }
        if (consecutive > bestConsecutive) bestConsecutive = consecutive;
      }
      if (score > bestScore) bestScore = score;
    }
  }
  return { score: bestScore, maxConsecutive: bestConsecutive, threePrimePairs };
}

// ── Primer3-style thermodynamic structure checks ────────────────────────────
//
// These mirror the models the Primer3 manual documents for its structural
// filters (https://primer3.org/manual.html): self-complementarity is a local
// alignment scored +1 match / -1 mismatch / -0.25 gap; hairpins and primer
// dimers are reported as the melting temperature of the most stable
// structure computed with the same SantaLucia nearest-neighbour parameters as
// primerTm (default thresholds 47 °C); end stability is the ΔG(37 °C) of the
// last five 3' bases. All values are design estimates.

const THERMO_CELSIUS = 310.15; // 37 °C in K

/** Uncorrected NN duplex thermodynamics of one canonical sequence. */
function duplexThermo(seq) {
  let dh = INIT_DH;
  let ds = INIT_DS;
  for (let i = 0; i + 1 < seq.length; i++) {
    const pair = seq[i] + seq[i + 1];
    dh += NN_DH_FULL[pair] ?? 0;
    ds += NN_DS_FULL[pair] ?? 0;
  }
  for (const end of [seq[0], seq[seq.length - 1]]) {
    if (end === 'A' || end === 'T') {
      dh += TERM_AT_DH;
      ds += TERM_AT_DS;
    }
  }
  return { dh, ds };
}

/** ΔG at 37 °C in kcal/mol from NN enthalpy (kcal/mol) and entropy (cal/mol·K). */
function deltaG37(dh, ds) {
  return dh - (THERMO_CELSIUS * ds) / 1000;
}

/** NN Tm (°C) of a bimolecular duplex at molar concentration `ct` (formula as in primerTm). */
function duplexTmFromThermo({ dh, ds }, ctMolar) {
  const denominator = ds + R * Math.log(Math.max(ctMolar, 1e-12) / 4);
  if (denominator >= 0) return 0; // outside the physical regime — treat as no duplex
  const tm = (dh * 1000) / denominator - 273.15;
  return Number.isFinite(tm) && tm > 0 ? tm : 0;
}

/** Linear-gap local alignment score of two strings (match +1, mismatch -1, gap -0.25). */
function localAlignScore(a, b) {
  const n = a.length;
  const m = b.length;
  const MATCH = 1.0;
  const MISMATCH = -1.0;
  const GAP = -0.25;
  let prev = new Float64Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1);
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + (a[i - 1] === b[j - 1] ? MATCH : MISMATCH);
      const up = prev[j] + GAP;
      const left = cur[j - 1] + GAP;
      cur[j] = Math.max(0, diag, up, left);
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best;
}

/** Linear-gap global alignment score of two strings (match +1, mismatch -1, gap -0.25). */
function globalAlignScore(a, b) {
  const n = a.length;
  const m = b.length;
  const MATCH = 1.0;
  const MISMATCH = -1.0;
  const GAP = -0.25;
  let prev = new Float64Array(m + 1);
  for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + GAP;
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1);
    cur[0] = prev[0] + GAP;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.max(
        prev[j - 1] + (a[i - 1] === b[j - 1] ? MATCH : MISMATCH),
        prev[j] + GAP,
        cur[j - 1] + GAP,
      );
    }
    prev = cur;
  }
  return prev[m];
}

/**
 * Primer3-style ANY self-complementarity: local alignment score between the
 * primer and its own reverse complement. In the anti-parallel register a
 * plain identity seq[i] === RC[j] means seq[i] pairs complementarily with
 * seq[n-1-j] — so standard identity scoring on (seq, RC) measures
 * self-complementary duplexes. Threshold in Primer3: 8.0.
 */
export function selfAnyScore(seq) {
  return localAlignScore(seq, reverseComplement(seq));
}

/**
 * Primer3-style 3'-anchored (END) self-complementarity: the best GLOBAL
 * alignment score in which the primer's 3'-terminal base is paired
 * complementarily with a base of a second anti-parallel copy of the primer.
 * The second copy is walked 3'→5' (anti-parallel register) and stored as
 * complements so that plain sequence identity marks a pair. Threshold in
 * Primer3: 3.0.
 */
export function selfEndScore(seq) {
  const n = seq.length;
  if (n < 2) return 0;
  let best = -Infinity;
  for (let j = 0; j < n; j++) {
    if (COMPLEMENT[seq[n - 1]] !== seq[j]) continue; // the terminal base pairs copy position j
    // anti-parallel copy of seq (3'→5') with position j removed, complemented
    let right = '';
    for (let m = n - 1; m >= 0; m--) {
      if (m === j) continue;
      right += complement(seq[m]);
    }
    const score = globalAlignScore(seq.slice(0, n - 1), right) + 1.0;
    if (score > best) best = score;
  }
  return best === -Infinity ? 0 : best;
}

/**
 * Hairpin stability as a folding Tm: enumerate stems (3-8 bp, perfectly
 * complementary arms) with loops of 3-10 bases, compute the stem duplex NN
 * thermodynamics, fold a loop entropy penalty (≈ 3.4 kcal/mol initiation +
 * 0.4 kcal/mol per extra loop base, folded into ΔS) and convert with the same
 * duplex-Tm formula as primerTm at concentration `ctMolar`. Returns the top
 * hairpins sorted by Tm (highest first).
 */
export function hairpinThermo(seq, ctMolar = 5e-7) {
  const rc = reverseComplement(seq);
  const found = [];
  for (let loop = 3; loop <= 10; loop++) {
    for (let stem = 3; stem <= 8; stem++) {
      const span = 2 * stem + loop;
      if (span > seq.length) continue;
      for (let start = 0; start + span <= seq.length; start++) {
        const arm1 = seq.slice(start, start + stem);
        const arm2 = seq.slice(start + stem + loop, start + span);
        if (reverseComplement(arm1) !== arm2) continue;
        const { dh, ds } = duplexThermo(arm1);
        // loop entropy penalty as a ΔG(37°C) folded into ΔS
        const loopDg = 3.4 + 0.4 * Math.max(0, loop - 3);
        const dsLoop = ds + (loopDg * 1000) / THERMO_CELSIUS;
        const tm = duplexTmFromThermo({ dh, ds: dsLoop }, ctMolar);
        found.push({
          start: start + 1,
          stem,
          loop,
          tm: Math.round(tm * 100) / 100,
          dg37_kcal: Math.round(deltaG37(dh, dsLoop) * 100) / 100,
        });
      }
    }
  }
  found.sort((a, b) => b.tm - a.tm);
  return found;
}

/**
 * Primer3-style primer-dimer analysis: the melting temperature of the most
 * stable duplex between two primers, computed with the NN parameters over the
 * longest perfectly complementary stretch of every relative alignment. In the
 * anti-parallel duplex geometry p1[i] must EQUAL RC(p2)[i], so runs of
 * identity between p1 and RC(p2) are the complementary duplexes. Returns
 * { any_tm, end_tm } where `end_tm` only counts duplexes that include one of
 * the primers' 3' ends (the extension-relevant case). Thresholds in Primer3:
 * 47 °C for both.
 */
export function dimerThermo(p1, p2, ctMolar = 5e-7) {
  const rc2 = reverseComplement(p2);
  let anyTm = 0;
  let endTm = 0;
  // a[i] === b[i] marks a complementary pair (see above). `p1ThreeAtEnd` is
  // true when a's last base is p1's 3' end; `p2ThreeAtStart` is true when
  // b's first base is RC(p2)[0] (the complement of p2's 3' end).
  const consider = (a, b, p1ThreeAtEnd, p2ThreeAtStart) => {
    const span = Math.min(a.length, b.length);
    let i = 0;
    while (i < span) {
      if (a[i] !== b[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < span && a[j] === b[j]) j++;
      if (j - i >= 3) {
        const { dh, ds } = duplexThermo(a.slice(i, j));
        const tm = duplexTmFromThermo({ dh, ds }, ctMolar);
        if (tm > anyTm) anyTm = tm;
        const includesP1Three = p1ThreeAtEnd && j === a.length;
        const includesP2Three = p2ThreeAtStart && i === 0;
        if ((includesP1Three || includesP2Three) && tm > endTm) endTm = tm;
      }
      i = j;
    }
  };
  for (let offset = 0; offset < p1.length; offset++) {
    consider(p1.slice(offset), rc2, true, true);
  }
  for (let offset = 0; offset < rc2.length; offset++) {
    consider(p1, rc2.slice(offset), true, offset === 0);
  }
  return { any_tm: Math.round(anyTm * 100) / 100, end_tm: Math.round(endTm * 100) / 100 };
}

/**
 * Primer3-style 3'-end stability: ΔG(37 °C) in kcal/mol of the duplex formed
 * by the last five 3' bases (NN parameters, terminal corrections included).
 * More negative = more stable 3' end. Primer3's default limit is 9.0 kcal/mol.
 */
export function endStability5(seq) {
  const tail = seq.slice(-5);
  const { dh, ds } = duplexThermo(tail);
  return Math.round(deltaG37(dh, ds) * 100) / 100;
}

/** Number of G/C bases among the last five 3' bases (Primer3 PRIMER_MAX_END_GC). */
export function endGcCount5(seq) {
  const tail = seq.slice(-5);
  let count = 0;
  for (const base of tail) {
    if (base === 'G' || base === 'C') count++;
  }
  return count;
}

// ── qPCR ────────────────────────────────────────────────────────────────────

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function analyzeQpcr({ targetTreated, targetControl, referenceTreated, referenceControl, efficiency = 2.0 }) {
  const all = [targetTreated, targetControl, referenceTreated, referenceControl];
  for (const values of all) {
    if (!Array.isArray(values) || values.length === 0) throw new MolbioInputError('all Ct lists must be non-empty arrays of numbers');
    for (const v of values) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new MolbioInputError(`Ct values must be positive finite numbers, got ${JSON.stringify(v)}`);
      }
    }
  }
  const tt = mean(targetTreated);
  const tc = mean(targetControl);
  const rt = mean(referenceTreated);
  const rc = mean(referenceControl);
  const deltaTreated = tt - rt;
  const deltaControl = tc - rc;
  const ddct = deltaTreated - deltaControl;
  const fold = efficiency ** -ddct;
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    target_treated_mean: round(tt), target_treated_sd: round(sd(targetTreated)),
    target_control_mean: round(tc), target_control_sd: round(sd(targetControl)),
    reference_treated_mean: round(rt), reference_treated_sd: round(sd(referenceTreated)),
    reference_control_mean: round(rc), reference_control_sd: round(sd(referenceControl)),
    delta_ct_treated: round(deltaTreated),
    delta_ct_control: round(deltaControl),
    delta_delta_ct: round(ddct),
    fold_change: round(fold),
  };
}

// ── lab math ────────────────────────────────────────────────────────────────

export function labMath(operation, inputs) {
  const num = (key, label) => {
    const value = inputs[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new MolbioInputError(`${label} must be a finite number`);
    return value;
  };
  if (operation === 'dilution') {
    const given = ['c1', 'v1', 'c2', 'v2'].filter((key) => inputs[key] !== undefined && inputs[key] !== null);
    if (given.length !== 3) throw new MolbioInputError('dilution needs exactly 3 of {c1, v1, c2, v2} to solve the fourth');
    const c1 = inputs.c1 !== undefined && inputs.c1 !== null ? num('c1', 'c1') : null;
    const v1 = inputs.v1 !== undefined && inputs.v1 !== null ? num('v1', 'v1') : null;
    const c2 = inputs.c2 !== undefined && inputs.c2 !== null ? num('c2', 'c2') : null;
    const v2 = inputs.v2 !== undefined && inputs.v2 !== null ? num('v2', 'v2') : null;
    let result, unit, detail;
    if (c1 === null) {
      result = (c2 * v2) / v1; unit = 'concentration units'; detail = `c1 = c2·v2/v1 = ${c2}·${v2}/${v1}`;
    } else if (v1 === null) {
      result = (c2 * v2) / c1; unit = 'volume units'; detail = `v1 = c2·v2/c1 = ${c2}·${v2}/${c1}`;
    } else if (c2 === null) {
      result = (c1 * v1) / v2; unit = 'concentration units'; detail = `c2 = c1·v1/v2 = ${c1}·${v1}/${v2}`;
    } else {
      result = (c1 * v1) / c2; unit = 'volume units'; detail = `v2 = c1·v1/c2 = ${c1}·${v1}/${c2}`;
    }
    if (!Number.isFinite(result)) throw new MolbioInputError('dilution produced a non-finite result; check the three given values');
    return { result: Math.round(result * 100000) / 100000, unit, detail };
  }
  if (operation === 'molarity') {
    const massMg = num('mass_mg', 'mass_mg');
    const mw = num('mw_g_per_mol', 'mw_g_per_mol');
    const volumeMl = num('volume_ml', 'volume_ml');
    if (mw <= 0 || volumeMl <= 0) throw new MolbioInputError('mw_g_per_mol and volume_ml must be positive');
    const molarity = (massMg / mw / volumeMl) * 1000; // mM
    return { result: Math.round(molarity * 10000) / 10000, unit: 'mM', detail: `mM = mass(mg)·1000 / (MW·volume(mL))` };
  }
  if (operation === 'copy_number') {
    const massNg = num('mass_ng', 'mass_ng');
    const lengthBp = num('length_bp', 'length_bp');
    if (lengthBp <= 0) throw new MolbioInputError('length_bp must be positive');
    const avogadro = 6.02214076e23;
    const copies = (massNg * 1e-9 * avogadro) / (lengthBp * 660);
    return { result: Math.round(copies * 100) / 100, unit: 'copies', detail: `copies = mass(g)·N_A / (bp·660)` };
  }
  throw new MolbioInputError(`unknown operation ${JSON.stringify(operation)}`);
}
