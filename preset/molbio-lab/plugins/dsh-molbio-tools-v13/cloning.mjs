/**
 * dsh-molbio-tools/cloning.mjs
 *
 * In silico cloning: unique-cutter selection, restriction-ligation and Gibson
 * assembly simulation, cloning primer design (enzyme tails / homology arms),
 * and QuickChange-style mutagenesis primer design. Pure computation.
 */

import {
  DNA_BASES,
  ENZYMES as ENZYME_TABLE,
  ENZYME_NAMES,
  MolbioInputError,
  baseCounts,
  digest,
  enzymeCuts,
  enzymePattern,
  findRuns,
  isIisEnzyme,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfComplementarity,
  translateFrames,
} from './lib.mjs';

const PCR_TM_OPTS = { naMm: 50, mgMm: 1.5, dntpMm: 0.8, primerNm: 200 };

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Recommended 5' protection bases (published recommendations; approximate). */
const PROTECTION_BASES = {
  EcoRI: 'GATA', HindIII: 'AATA', BamHI: 'CGCG', XhoI: 'GCTG', XbaI: 'GCTC',
  NotI: 'CGCG', NcoI: 'GCCC', NdeI: 'GCCC', PstI: 'GCTG', SacI: 'CGAG',
  SalI: 'GTCG', SpeI: 'GACT', SphI: 'GCAT', KpnI: 'GGGT', SmaI: 'CCCC',
  XmaI: 'CCCC', BglII: 'GAGA', EcoRV: 'GATA', PvuII: 'GCAG', ClaI: 'CCAT',
  ApaI: 'GGGG', NheI: 'GCTA', BstBI: 'GTTG', MfeI: 'GACA', NsiI: 'GATG',
  PacI: 'GTTA', SbfI: 'GCCT', AscI: 'GGCC', FseI: 'GGCC', AgeI: 'GACC',
  AvrII: 'GCCT', BclI: 'GTGA', BstEII: 'GGGT', BstXI: 'GCCA', Bsu36I: 'GCCT',
  DraI: 'GTTT', EagI: 'GCCG', EcoNI: 'GCCT', HpaI: 'GGTT', MluI: 'GACG',
  NruI: 'GTCG', PmeI: 'GGTT', PmlI: 'GCAC', PshAI: 'GGAC', PspOMI: 'GGGG',
  RsrII: 'GCCG', SacII: 'GCCG', ScaI: 'GAGT', SexAI: 'GACC', SgrAI: 'GCCG',
  StuI: 'GAGG', XmnI: 'GGAA',
};

function enzymeSite(name) {
  const entry = ENZYME_TABLE[name];
  if (entry === undefined) throw new MolbioInputError(`unknown enzyme ${JSON.stringify(name)}`);
  return typeof entry === 'string' ? entry.replace('^', '') : entry.site;
}

// ── unique cutters ──────────────────────────────────────────────────────────

/**
 * Enzymes that cut the vector exactly once (optionally inside a region) and
 * never cut the insert; plus enzymes that cut a region twice (fragment
 * excision).
 */
export function uniqueCutters(vectorSeq, insertSeq, region, circular) {
  const summary = { enzymes_scanned: ENZYME_NAMES.length, insert_cutters: [], multi_cutters: [] };
  const ideal = [];
  const regionDouble = [];
  for (const name of ENZYME_NAMES) {
    const v = digest(vectorSeq, [name], circular)[0];
    const vCuts = v.cut_positions;
    const insertCuts = insertSeq === '' ? [] : digest(insertSeq, [name], false)[0].cut_positions;
    if (insertCuts.length > 0) {
      if (vCuts.length === 1) summary.insert_cutters.push(name);
      continue;
    }
    if (vCuts.length === 1) {
      const cutPosition = vCuts[0] + 1; // 1-based
      const inRegion = region === undefined || (cutPosition >= region.start && cutPosition <= region.end);
      ideal.push({ name, site: v.site, cut_position: cutPosition, in_region: inRegion });
      continue;
    }
    if (vCuts.length === 2 && region !== undefined) {
      const p1 = vCuts[0] + 1;
      const p2 = vCuts[1] + 1;
      if (p1 >= region.start && p2 <= region.end) {
        const excised = p2 - p1;
        regionDouble.push({
          name,
          site: v.site,
          cut_positions: [p1, p2],
          excised_fragment: excised,
          backbone_fragment: vectorSeq.length - excised,
        });
      }
      continue;
    }
    if (vCuts.length > 0) summary.multi_cutters.push(name);
  }
  return { ideal, region_double: regionDouble, summary };
}

// ── clone simulation ────────────────────────────────────────────────────────

/** Remap 1-based feature coordinates across an insertion/deletion. */
function remapFeatures(features, a, b, delta, insertStart, insertLen, insertLabel) {
  const kept = [];
  const dropped = [];
  for (const feature of features) {
    const { start: s, end: e } = feature;
    if (e < a) {
      kept.push({ ...feature });
    } else if (s > b) {
      kept.push({ ...feature, start: s + delta, end: e + delta });
    } else if (s >= a && e <= b) {
      dropped.push(feature);
    } else {
      const ns = s < a ? s : insertStart;
      const ne = e > b ? e + delta : insertStart + insertLen - 1;
      kept.push({ ...feature, start: ns, end: ne, spans_insertion: true });
    }
  }
  kept.push({
    type: 'misc_feature',
    label: insertLabel,
    start: insertStart,
    end: insertStart + insertLen - 1,
    strand: 1,
  });
  return { kept, dropped };
}

/** Compare digests of the final plasmid against the original vector. */
function digestComparison(finalSeq, vectorSeq, circular, enzymeNames, max = 5) {
  const changed = [];
  for (const name of enzymeNames) {
    const f = digest(finalSeq, [name], circular)[0];
    const v = digest(vectorSeq, [name], circular)[0];
    if (JSON.stringify(f.fragments) !== JSON.stringify(v.fragments)) {
      changed.push({
        name,
        final_fragments: f.fragments,
        vector_fragments: v.fragments,
      });
    }
  }
  changed.sort((x, y) => y.final_fragments.length - x.final_fragments.length);
  return changed.slice(0, max);
}

/** Simulate restriction-ligation cloning. */
export function simulateRestrictionClone(vectorSeq, vectorFeatures, insert, enzymes, circular, orientation = 'auto', addFlanks = false) {
  const notes = [];
  const cuts = [];
  for (const name of enzymes) {
    const d = digest(vectorSeq, [name], circular)[0];
    if (d.cut_positions.length !== 1) {
      throw new MolbioInputError(`${name} cuts the vector ${d.cut_positions.length} time(s); use molbio_unique_cutters to pick a single-cutting enzyme`);
    }
    cuts.push({ name, offset: d.cut_positions[0] });
  }
  cuts.sort((x, y) => x.offset - y.offset);
  if (cuts.some((cut) => isIisEnzyme(cut.name))) {
    notes.push('type IIS enzyme(s) in use: the simulation splices at the top-strand cut position; overhang sequences are NOT validated (Golden Gate overhangs are not modeled)');
  }

  // With add_flanks the tool adds the enzyme recognition sites to the bare
  // insert itself (5' site of the upstream enzyme, 3' site of the downstream).
  let rawInsert = insert;
  let insertWithFlanks;
  if (addFlanks) {
    const upstream = cuts[0].name;
    const downstream = cuts.length === 2 ? cuts[1].name : cuts[0].name;
    insertWithFlanks = enzymeSite(upstream) + insert + enzymeSite(downstream);
    rawInsert = insertWithFlanks;
    notes.push(`enzyme recognition sites were added to the bare insert by the tool (add_flanks): 5' ${enzymeSite(upstream)}, 3' ${enzymeSite(downstream)}`);
  }

  for (const { name } of cuts) {
    const d = digest(rawInsert, [name], false)[0];
    if (d.cut_positions.length === 0) throw new MolbioInputError(`${name} does not cut the insert — add its recognition site to the insert flanks (molbio_clone_primers can do this, or pass add_flanks: true)`);
  }

  let finalSeq;
  let cA;
  let cB;
  let insertFragment;
  let reverseAlt;
  let reverseComplemented = orientation === 'reverse';

  // Resolve insert orientation: the insert must read 5'→3' along the vector
  // coordinates (upstream enzyme first). With orientation=auto an inverted
  // insert is reverse-complemented automatically; 'forward'/'reverse' force.
  let workingInsert = orientation === 'reverse' ? reverseComplement(rawInsert) : rawInsert;

  if (cuts.length === 1) {
    const { name, offset: c } = cuts[0];
    let insertCutOffsets = digest(workingInsert, [name], false)[0].cut_positions;
    if (insertCutOffsets.length < 2) throw new MolbioInputError(`${name} must cut the insert twice (once on each flank) for a one-enzyme ligation`);
    if (insertCutOffsets.length > 2) {
      notes.push(`${name} also cuts INSIDE the insert ${insertCutOffsets.length - 2} time(s); those internal sites are cut and re-ligated, so the sequence is preserved`);
    }
    const i1 = Math.min(...insertCutOffsets);
    const i2 = Math.max(...insertCutOffsets);
    const flank5 = i1;
    const flank3 = Math.max(0, workingInsert.length - i2);
    if (flank5 > 0 || flank3 > 0) notes.push(`insert flanks outside the ${name} fragment are lost: 5' ${flank5} bp, 3' ${flank3} bp`);
    insertFragment = workingInsert.slice(i1, i2);
    finalSeq = vectorSeq.slice(0, c) + insertFragment + vectorSeq.slice(c);
    reverseAlt = vectorSeq.slice(0, c) + reverseComplement(insertFragment) + vectorSeq.slice(c);
    cA = c;
    cB = c;
    notes.push('single-enzyme ligation: the insert can ligate in either orientation; the assembled sequence assumes the orientation you provided, and the verification digest lists fragments for both orientations.');
  } else {
    const first = cuts[0];
    const second = cuts[1];
    const c1 = first.offset;
    const c2 = second.offset;
    let firstInsertCuts = digest(workingInsert, [first.name], false)[0].cut_positions;
    let secondInsertCuts = digest(workingInsert, [second.name], false)[0].cut_positions;
    let i1 = Math.min(...firstInsertCuts);
    let i2 = Math.max(...secondInsertCuts);
    if (i1 > i2) {
      if (orientation === 'auto') {
        workingInsert = reverseComplement(workingInsert);
        reverseComplemented = !reverseComplemented;
        firstInsertCuts = digest(workingInsert, [first.name], false)[0].cut_positions;
        secondInsertCuts = digest(workingInsert, [second.name], false)[0].cut_positions;
        i1 = Math.min(...firstInsertCuts);
        i2 = Math.max(...secondInsertCuts);
        notes.push('the insert was provided with the enzyme sites in the opposite order — it was reverse-complemented automatically (orientation=auto); pass orientation=forward to keep it as written.');
      } else {
        throw new MolbioInputError(`insert orientation looks inverted: write the insert 5'→3' with ${first.name} flanking the 5' end and ${second.name} flanking the 3' end (or pass orientation=reverse to reverse-complement it)`);
      }
    }
    if (firstInsertCuts.length > 1) notes.push(`${first.name} cuts INSIDE the insert ${firstInsertCuts.length - 1} time(s); those internal sites are cut and re-ligated, so the sequence is preserved`);
    if (secondInsertCuts.length > 1) notes.push(`${second.name} cuts INSIDE the insert ${secondInsertCuts.length - 1} time(s); those internal sites are cut and re-ligated, so the sequence is preserved`);
    const flank5 = i1;
    const flank3 = Math.max(0, workingInsert.length - i2);
    if (flank5 > 0 || flank3 > 0) notes.push(`insert flanks outside the ${first.name}…${second.name} fragment are lost: 5' ${flank5} bp, 3' ${flank3} bp`);
    insertFragment = workingInsert.slice(i1, i2);
    finalSeq = vectorSeq.slice(0, c1) + insertFragment + vectorSeq.slice(c2);
    cA = c1;
    cB = c2;
  }

  const delta = insertFragment.length - (cB - cA);
  const insertStart = cA + 1;
  const { kept, dropped } = remapFeatures(vectorFeatures, cA + 1, cB, delta, insertStart, insertFragment.length, 'Insert');

  // junction contexts (bases around the ligation seams)
  const junctions = [];
  const junctionAt = (pos0) => finalSeq.slice(Math.max(0, pos0 - 5), Math.min(finalSeq.length, pos0 + 5));
  junctions.push({ position: insertStart, sequence: junctionAt(insertStart - 1) });
  if (cuts.length === 2) junctions.push({ position: insertStart + insertFragment.length, sequence: junctionAt(insertStart + insertFragment.length - 1) });

  const verify = digestComparison(finalSeq, vectorSeq, circular, ENZYME_NAMES);
  const verifyOut = verify.map((entry) => ({
    ...entry,
    ...reverseAlt !== undefined ? { reverse_orientation_fragments: digest(reverseAlt, [entry.name], circular)[0].fragments } : {},
  }));

  return {
    method: 'restriction',
    enzymes: cuts.map((cut) => cut.name),
    insert_fragment_length: insertFragment.length,
    delta,
    final_sequence: finalSeq,
    reverse_orientation_sequence: reverseAlt,
    junctions,
    features: kept,
    dropped_features: dropped,
    verify: verifyOut,
    notes,
    insert_reverse_complemented: reverseComplemented,
    ...insertWithFlanks !== undefined ? { insert_with_flanks: insertWithFlanks } : {},
  };
}

/** Simulate Gibson assembly. */
export function simulateGibsonClone(vectorSeq, vectorFeatures, insert, region, overhang, circular) {
  const rs0 = region.start - 1;
  const re0 = region.end - 1;
  if (rs0 < 0 || re0 >= vectorSeq.length || rs0 > re0) {
    throw new MolbioInputError(`region ${region.start}-${region.end} is outside the vector (length ${vectorSeq.length})`);
  }
  const arm5 = vectorSeq.slice(Math.max(0, rs0 - overhang), rs0);
  const arm3 = vectorSeq.slice(re0 + 1, re0 + 1 + overhang);
  if (arm5.length < overhang || arm3.length < overhang) {
    throw new MolbioInputError(`the vector region is too close to an end for ${overhang} bp overhangs`);
  }
  const insertToOrder = arm5 + insert + arm3;
  const finalSeq = vectorSeq.slice(0, rs0) + insert + vectorSeq.slice(re0 + 1);
  const delta = insert.length - (region.end - region.start + 1);
  const insertStart = region.start;
  const { kept, dropped } = remapFeatures(vectorFeatures, region.start, region.end, delta, insertStart, insert.length, 'Insert');
  const verify = digestComparison(finalSeq, vectorSeq, circular, ENZYME_NAMES);
  return {
    method: 'gibson',
    overhang,
    insert_to_order: insertToOrder,
    insert_fragment_length: insert.length,
    delta,
    final_sequence: finalSeq,
    junctions: [{ position: insertStart, sequence: finalSeq.slice(Math.max(0, rs0 - 5), Math.min(finalSeq.length, rs0 + insert.length + 5)) }],
    features: kept,
    dropped_features: dropped,
    verify,
    notes: [],
  };
}

/** Dispatch between the two cloning methods. */
export function simulateClone({ vectorSeq, vectorFeatures, insert, method, enzymes, region, overhang = 20, circular = true, verifyEnzymes, orientation = 'auto', addFlanks = false }) {
  const result = method === 'gibson'
    ? simulateGibsonClone(vectorSeq, vectorFeatures, insert, region, overhang, circular)
    : simulateRestrictionClone(vectorSeq, vectorFeatures, insert, enzymes, circular, orientation, addFlanks);
  if (verifyEnzymes !== undefined && verifyEnzymes.length > 0) {
    result.verify = digestComparison(result.final_sequence, vectorSeq, circular, verifyEnzymes, verifyEnzymes.length);
  }
  return result;
}

// ── Golden Gate assembly (v13) ──────────────────────────────────────────────
//
// Geometry model (all sequences top-strand 5'→3', 0-based positions):
// a type IIS enzyme with recognition `site` (length L) cuts the binding strand
// `cut` bases from the site start (L + filler downstream of the site) and the
// complement strand `bottom` bases from the site end — the classic (N/N)
// notation. Every enzyme in the built-in table produces a 4 bp 5' overhang:
//  - forward site  [S][filler][x]gene[z][filler][rc(S)]  → the gene keeps a
//    top-strand 5' overhang x at its left end and a bottom-strand 5' overhang
//    rc(z) at its right end;
//  - the vector cassette (inward pair) keeps both sites with the backbone and
//    discards the stuffer between the cuts; the backbone's right end carries
//    the bottom overhang rc(y) and its left end the top overhang z'.
// Annealing therefore requires x_1 = y, x_{k+1} = z_k, and z_n = z', and the
// final top strand is backbone + y + gene_1 + z_1 + ... + z_{n-1} + gene_n.

const GG_BASES = ['A', 'C', 'G', 'T'];

/** All 256 4-mers, ordered by |GC − 2| then lexicographically (deterministic). */
function ggJunctionCandidates() {
  const pool = [];
  for (let i = 0; i < 256; i++) {
    let n = i;
    let seq = '';
    for (let p = 0; p < 4; p++) {
      seq += GG_BASES[n % 4];
      n = Math.floor(n / 4);
    }
    let gc = 0;
    for (const base of seq) if (base === 'G' || base === 'C') gc++;
    pool.push({ seq, score: Math.abs(gc - 2) });
  }
  pool.sort((a, b) => a.score - b.score || (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  return pool.map((entry) => entry.seq);
}

/** A junction is usable when it is non-palindromic and unique up to complement. */
function ggJunctionOk(seq, used) {
  if (seq === reverseComplement(seq)) return false;
  for (const other of used) {
    if (seq === other || seq === reverseComplement(other)) return false;
  }
  return true;
}

/**
 * Deterministic backtracking over the candidate pool for the interior
 * junctions; a combination is accepted only when the assembled plasmid does
 * not recreate an enzyme recognition site at a seam. The vector's own two
 * cassette sites remain in the backbone (standard destination-vector
 * behavior), so the assembled plasmid must show EXACTLY those 2 cuts.
 */
function ggSearchInteriors(fixed, genes, backboneTop, enzymeName, maxLeafChecks = 500) {
  const candidates = ggJunctionCandidates();
  const used = new Set(fixed);
  const chosen = [];
  let leafChecks = 0;
  let exhausted = false;
  const probe = () => {
    leafChecks++;
    const finalSeq = backboneTop + genes.reduce((acc, gene, index) => acc + (index === 0 ? fixed[0] : chosen[index - 1]) + gene, '');
    return enzymeCuts(finalSeq, enzymeName).length === 2;
  };
  const rec = (k) => {
    if (k === genes.length - 1) {
      if (probe()) return true;
      if (leafChecks >= maxLeafChecks) exhausted = true;
      return false;
    }
    for (const cand of candidates) {
      if (!ggJunctionOk(cand, used)) continue;
      used.add(cand);
      chosen.push(cand);
      if (rec(k + 1)) return true;
      chosen.pop();
      used.delete(cand);
      if (exhausted) return false;
    }
    return false;
  };
  if (!rec(0)) return null;
  return chosen;
}

/**
 * Golden Gate assembly simulation (v13). Inserts are BARE fragment sequences
 * in assembly order; the tool designs the junctions (or reads the vector
 * cassette's), builds the fragments to order with the IIS recognition sites
 * and filler bases on the flanks, assembles the final plasmid, and remaps
 * features. Pass replaceRegion {start, end} (1-based inclusive) to have the
 * tool ADD the cassette around that region of a bare vector and design both
 * vector junctions too; otherwise the vector must already carry exactly one
 * forward and one reverse-complemented recognition site (the inward cassette).
 */
export function simulateGoldenGate({ vectorSeq, vectorFeatures, inserts, enzyme = 'BsaI', circular = true, replaceRegion }) {
  const notes = [];
  const resolved = enzymePattern(enzyme);
  if (resolved === undefined || !resolved.iis) {
    throw new MolbioInputError(`${enzyme} is not a type IIS enzyme in the built-in table; Golden Gate needs an IIS enzyme (e.g. BsaI, BsmBI, Esp3I, BbsI, BspQI, SapI, PaqCI, BtgZI)`);
  }
  const { pattern: site, cutOffset: cut, bottom } = resolved;
  const siteLength = site.length;
  const filler = cut - siteLength;
  const overhangLength = siteLength + bottom - cut;
  if (overhangLength !== 4) {
    throw new MolbioInputError(`${enzyme} produces a ${overhangLength} bp overhang; this simulator supports the standard 4 bp 5' overhang class`);
  }
  if (!Array.isArray(inserts) || inserts.length < 1 || inserts.length > 24) {
    throw new MolbioInputError('inserts must be an array of 1-24 fragment sequences in assembly order');
  }
  const genes = inserts.map((raw, index) => {
    const gene = normalizeSequence(raw, `inserts[${index}]`);
    if (gene.length < 12) throw new MolbioInputError(`inserts[${index}] is too short for assembly (${gene.length} bp; need >= 12)`);
    for (const base of gene) {
      if (!DNA_BASES.has(base)) throw new MolbioInputError(`inserts[${index}] must be unambiguous ACGT for Golden Gate (found ${JSON.stringify(base)})`);
    }
    const internal = enzymeCuts(gene, enzyme);
    if (internal.length > 0) {
      throw new MolbioInputError(`${enzyme} cuts INSIDE inserts[${index}] ${internal.length} time(s) at bp ${internal.map((c) => c.cut_position + 1).join(', ')} — remove those sites or choose another enzyme`);
    }
    return gene;
  });

  let workingVector = vectorSeq;
  let workingFeatures = vectorFeatures;
  let y;
  let zPrime;
  let c1; // 0-based top cut at the forward cassette site (first base of the stuffer)
  let c2; // 0-based top cut at the reverse cassette site (first base of the right backbone piece)

  if (replaceRegion !== undefined) {
    const rs0 = replaceRegion.start - 1;
    const re0 = replaceRegion.end - 1;
    if (!Number.isInteger(replaceRegion.start) || !Number.isInteger(replaceRegion.end) || rs0 < 0 || re0 >= vectorSeq.length || rs0 > re0) {
      throw new MolbioInputError(`region ${replaceRegion.start}-${replaceRegion.end} is outside the vector (length ${vectorSeq.length})`);
    }
    const preExisting = enzymeCuts(vectorSeq, enzyme);
    if (preExisting.length > 0) {
      throw new MolbioInputError(`${enzyme} already cuts the bare vector ${preExisting.length} time(s) (bp ${preExisting.map((c) => c.cut_position + 1).join(', ')}) — remove those sites or pick another enzyme`);
    }
    // Design both vector junctions, then add the inward cassette around the region.
    const pool = ggJunctionCandidates();
    y = pool.find((cand) => ggJunctionOk(cand, new Set()));
    zPrime = pool.find((cand) => ggJunctionOk(cand, new Set([y])));
    const fillerBases = 'A'.repeat(filler);
    const cassette = site + fillerBases + y + vectorSeq.slice(rs0, re0 + 1) + zPrime + fillerBases + reverseComplement(site);
    workingVector = vectorSeq.slice(0, rs0) + cassette + vectorSeq.slice(re0 + 1);
    // The cassette insertion shifts every feature downstream of the region;
    // features inside the region move with the inserted prefix, and features
    // crossing a boundary are stretched over the cassette (remapFeatures
    // reports them as spanning the insertion). Feature coordinates are 1-based.
    const cassetteDelta = cassette.length - (re0 - rs0 + 1);
    const prefixShift = siteLength + filler + 4; // S + filler bases + the left junction
    const regionStart1 = rs0 + 1;
    const regionEnd1 = re0 + 1;
    workingFeatures = workingFeatures.map((feature) => {
      if (feature.end < regionStart1) return { ...feature };
      if (feature.start > regionEnd1) return { ...feature, start: feature.start + cassetteDelta, end: feature.end + cassetteDelta };
      if (feature.start >= regionStart1 && feature.end <= regionEnd1) return { ...feature, start: feature.start + prefixShift, end: feature.end + prefixShift };
      const newStart = feature.start >= regionStart1 ? feature.start + prefixShift : feature.start;
      return { ...feature, start: newStart, end: feature.end + cassetteDelta };
    });
    c1 = rs0 + cut;
    c2 = rs0 + cassette.length - siteLength - filler; // start of rc(site), minus filler = the reverse top cut
    notes.push(`no cassette found in the bare vector — the tool added the ${site} cassette around ${replaceRegion.start}-${replaceRegion.end} and designed both vector junctions (${y} / ${zPrime}); pass the vector WITH your own cassette to keep it instead.`);
  } else {
    const events = enzymeCuts(vectorSeq, enzyme);
    const fwd = events.filter((event) => event.orientation === 'forward');
    const rev = events.filter((event) => event.orientation === 'reverse');
    if (fwd.length !== 1 || rev.length !== 1) {
      throw new MolbioInputError(`the vector must carry exactly one forward ${site} site (found ${fwd.length}) and one reverse-complemented ${reverseComplement(site)} site (found ${rev.length}); found cuts at bp ${events.map((e) => e.cut_position + 1).join(', ')}. Pass replace_region to let the tool add the cassette to a bare vector instead.`);
    }
    c1 = fwd[0].cut_position;
    c2 = rev[0].cut_position;
    y = vectorSeq.slice(c1, c1 + 4);
    zPrime = vectorSeq.slice(c2 - 4, c2);
    if (y.length < 4 || zPrime.length < 4) throw new MolbioInputError('the vector cassette sites sit too close to an end for a 4 bp overhang');
    if (!ggJunctionOk(y, new Set([zPrime])) || !ggJunctionOk(zPrime, new Set([y]))) {
      throw new MolbioInputError(`the vector cassette junctions (${y} / ${zPrime}) are unusable: palindromic, identical, or complementary — choose a different cassette or pass replace_region so the tool designs them`);
    }
  }

  // Uniform presentation: linearize at the reverse cassette cut (c2), so the
  // backbone piece is presented[0 .. c1p) and the removed stuffer is the tail
  // [c1p .. len). Features rotate with the sequence; seam-crossers are dropped
  // with a note. The plasmid is circular, so this only sets the display origin.
  const presented = workingVector.slice(c2) + workingVector.slice(0, c2);
  const c1p = c2 < c1 ? c1 - c2 : c1 - c2 + workingVector.length;
  const rotatedFeatures = [];
  const rotationDropped = [];
  for (const feature of workingFeatures) {
    const start = ((feature.start - 1 - c2 + workingVector.length) % workingVector.length) + 1;
    const end = ((feature.end - 1 - c2 + workingVector.length) % workingVector.length) + 1;
    if (start > end) {
      rotationDropped.push({ ...feature, note: 'crosses the vector display origin; dropped during Golden Gate rotation' });
    } else {
      rotatedFeatures.push({ ...feature, start, end });
    }
  }
  workingFeatures = rotatedFeatures;
  notes.push(`final sequence, feature coordinates, and junction positions are linearized at bp ${c2 + 1} of the input vector (the reverse cassette cut); the plasmid is circular, so this only sets the display origin.`);
  if (rotationDropped.length > 0) {
    notes.push(`${rotationDropped.length} feature(s) crossed the vector display origin and were dropped during rotation: ${rotationDropped.map((f) => f.label).join(', ')}`);
  }

  const backboneTop = presented.slice(0, c1p);
  const backboneLength = backboneTop.length;
  const stufferLength = presented.length - backboneLength;

  // Interior junctions (backtracking over the deterministic pool).
  const chosenInteriors = genes.length > 1
    ? ggSearchInteriors([y, zPrime], genes, backboneTop, enzyme)
    : [];
  if (chosenInteriors === null) {
    throw new MolbioInputError(`no junction combination for ${genes.length} fragments avoids recreating ${enzyme} sites at a seam; try different fragment boundaries`);
  }
  const junctions = [y, ...chosenInteriors, zPrime];

  const insertBlock = genes.reduce((acc, gene, index) => acc + junctions[index] + gene, '');
  const finalSeq = backboneTop + insertBlock;
  const insertBlockLength = insertBlock.length;
  const delta = insertBlockLength - stufferLength;
  const insertStart = backboneLength + 1;
  const { kept, dropped } = remapFeatures(workingFeatures, backboneLength + 1, presented.length, delta, insertStart, insertBlockLength, 'GG insert');

  const junctionReport = junctions.map((seq, index) => {
    let position = backboneLength + 1;
    for (let k = 0; k < index; k++) position += 4 + genes[k].length;
    return { position, sequence: seq };
  });

  const residual = enzymeCuts(finalSeq, enzyme);
  if (residual.length !== 2) {
    throw new MolbioInputError(`the assembled plasmid has ${residual.length} ${enzyme} site(s) (expected exactly the 2 retained vector cassette sites; extra sites at bp ${residual.map((c) => c.cut_position + 1).join(', ')}) — this should not happen; report it`);
  }
  notes.push(`the vector cassette ${site}/${reverseComplement(site)} sites remain in the backbone (standard destination-vector behavior); assemble the next Golden Gate level with a different type IIS enzyme.`);

  const verify = digestComparison(finalSeq, vectorSeq, circular, ENZYME_NAMES);
  const fragmentsToOrder = genes.map((gene, index) => {
    const left = junctions[index];
    const right = junctions[index + 1];
    const ordered = site + 'A'.repeat(filler) + left + gene + right + 'A'.repeat(filler) + reverseComplement(site);
    return { index: index + 1, sequence: ordered, length: ordered.length, left_overhang: left, right_overhang: right, insert_length: gene.length };
  });

  return {
    method: 'golden_gate',
    enzyme,
    enzyme_site: resolved.display,
    overhang_length: overhangLength,
    fragments_to_order: fragmentsToOrder,
    junctions: junctionReport,
    final_sequence: finalSeq,
    delta,
    features: kept,
    dropped_features: dropped,
    verify,
    notes,
  };
}

// ── cloning primers ─────────────────────────────────────────────────────────

/**
 * Design primers that amplify `template` with cloning tails.
 * restriction mode: 5' protection bases + enzyme site(s).
 * gibson mode: vector homology arms flanking the replaced region.
 */
export function designClonePrimers({ template, mode, enzymes, protectBases = true, extraBases = 0, bindingLength = 20, vectorSeq, region, overhang = 20 }) {
  const seq = normalizeSequence(template, 'template');
  if (!Number.isInteger(bindingLength) || bindingLength < 12 || bindingLength > 40) throw new MolbioInputError('binding_length must be an integer between 12 and 40');
  if (seq.length < bindingLength) throw new MolbioInputError(`template is shorter than the binding length (${seq.length} < ${bindingLength})`);
  const bind5 = seq.slice(0, bindingLength);
  const bind3 = seq.slice(-bindingLength);
  const warnings = [];
  let forward;
  let reverse;

  if (mode === 'restriction') {
    if (!Array.isArray(enzymes) || enzymes.length < 1 || enzymes.length > 2) throw new MolbioInputError('restriction mode needs 1 or 2 enzyme names');
    const names = [...new Set(enzymes)];
    const tailFor = (name) => {
      const site = enzymeSite(name);
      let protect = '';
      if (protectBases === true) protect = PROTECTION_BASES[name] ?? 'GGC';
      else if (typeof protectBases === 'string') protect = protectBases;
      const extra = 'C'.repeat(extraBases);
      return protect + extra + site;
    };
    forward = tailFor(names[0]) + bind5;
    reverse = tailFor(names.length === 2 ? names[1] : names[0]) + reverseComplement(bind3);
    for (const name of names) {
      const internal = digest(seq, [name], false)[0];
      if (internal.cut_positions.length > 0) {
        warnings.push(`${name} also cuts INSIDE the template at position(s) ${internal.cut_positions.map((c) => c + 1).join(', ')} — the amplicon would be digested; mutate the internal site or choose another enzyme`);
      }
    }
  } else if (mode === 'gibson') {
    if (vectorSeq === undefined || region === undefined) throw new MolbioInputError('gibson mode needs the vector sequence and the region being replaced');
    const rs0 = region.start - 1;
    const re0 = region.end - 1;
    const arm5 = vectorSeq.slice(Math.max(0, rs0 - overhang), rs0);
    const arm3 = vectorSeq.slice(re0 + 1, re0 + 1 + overhang);
    if (arm5.length < overhang || arm3.length < overhang) throw new MolbioInputError('vector region too close to an end for the requested overhang');
    forward = arm5 + bind5;
    reverse = reverseComplement(arm3) + reverseComplement(bind3);
  } else {
    throw new MolbioInputError(`unknown mode ${JSON.stringify(mode)}; expected "restriction" or "gibson"`);
  }

  const tmOf = (primer) => {
    try {
      return primerTm(primer, PCR_TM_OPTS).tm_celsius;
    } catch {
      return 0;
    }
  };
  const gcOf = (primer) => {
    const { gc, at } = baseCounts(primer);
    return gc + at === 0 ? 0 : Math.round((gc / (gc + at)) * 1000) / 10;
  };
  const dimer = dimerScore(forward, reverse);
  const selfF = selfComplementarity(forward).bestScore;
  const selfR = selfComplementarity(reverse).bestScore;

  return {
    mode,
    forward,
    reverse,
    forward_binding: bind5,
    reverse_binding: bind3,
    checks: {
      forward_tm: round1(tmOf(forward)),
      reverse_tm: round1(tmOf(reverse)),
      binding_tm_forward: round1(tmOf(bind5)),
      binding_tm_reverse: round1(tmOf(bind3)),
      gc_forward: gcOf(forward),
      gc_reverse: gcOf(reverse),
      dimer_score: dimer.score,
      forward_self_score: selfF,
      reverse_self_score: selfR,
      warnings,
    },
  };
}

// ── mutagenesis primers ─────────────────────────────────────────────────────

/** Parse one mutation description. */
export function parseMutation(text) {
  const sub = /^([A-Za-z])(\d+)([A-Za-z])$/.exec(text);
  if (sub !== null) return { kind: 'sub', pos: Number(sub[2]), from: sub[1].toUpperCase(), to: sub[3].toUpperCase() };
  const sub2 = /^(\d+)([A-Za-z])>([A-Za-z])$/.exec(text);
  if (sub2 !== null) return { kind: 'sub', pos: Number(sub2[1]), from: sub2[2].toUpperCase(), to: sub2[3].toUpperCase() };
  const del = /^(\d+)_(\d+)del$/.exec(text);
  if (del !== null) {
    const a = Number(del[1]);
    const b = Number(del[2]);
    if (b < a) throw new MolbioInputError(`deletion range ${text} is reversed`);
    return { kind: 'del', pos: a, end: b };
  }
  const ins = /^(?:after\s*)?(\d+)\s*ins\s*([A-Za-z]+)$/.exec(text);
  if (ins !== null) return { kind: 'ins', pos: Number(ins[1]), seq: ins[2].toUpperCase() };
  throw new MolbioInputError(`cannot parse mutation ${JSON.stringify(text)}; use forms like A123G, 123A>G, 123_125del, or after123insGCT`);
}

/** Apply mutations (coordinates refer to the original template) and record spans. */
export function applyMutations(template, parsed) {
  let seq = template;
  let delta = 0;
  const spans = [];
  for (const mutation of parsed) {
    if (mutation.kind === 'sub') {
      const p = mutation.pos + delta;
      if (p < 1 || p > seq.length) throw new MolbioInputError(`mutation position ${mutation.pos} is outside the template (length ${template.length})`);
      const actual = seq[p - 1];
      if (mutation.from !== undefined && actual !== mutation.from) {
        throw new MolbioInputError(`mutation ${mutation.from}${mutation.pos}${mutation.to}: the template has ${actual} at position ${mutation.pos}, not ${mutation.from}`);
      }
      seq = seq.slice(0, p - 1) + mutation.to + seq.slice(p);
      spans.push({ start: p, end: p });
    } else if (mutation.kind === 'del') {
      const a = mutation.pos + delta;
      const b = mutation.end + delta;
      if (a < 1 || b > seq.length) throw new MolbioInputError(`deletion ${mutation.pos}_${mutation.end} is outside the template`);
      seq = seq.slice(0, a - 1) + seq.slice(b);
      spans.push({ start: a, end: a });
      delta -= mutation.end - mutation.pos + 1;
    } else {
      const after = mutation.pos + delta;
      if (after < 0 || after > seq.length) throw new MolbioInputError(`insertion position ${mutation.pos} is outside the template`);
      seq = seq.slice(0, after) + mutation.seq + seq.slice(after);
      spans.push({ start: after + 1, end: after + mutation.seq.length });
      delta += mutation.seq.length;
    }
  }
  return { mutated: seq, spans };
}

/** Translate the codon window covering the mutation span in both sequences. */
function aminoAcidChange(template, mutated, spanStart, spanEnd) {
  const cs = Math.floor((spanStart - 1) / 3) * 3;
  const ce = Math.min(template.length, mutated.length, Math.ceil(spanEnd / 3) * 3);
  if (ce - cs < 3) return { before: '', after: '', silent: false };
  const beforeFrames = translateFrames(template, '1', 'standard', 0).results[0].protein;
  const afterFrames = translateFrames(mutated, '1', 'standard', 0).results[0].protein;
  const before = beforeFrames.slice(cs / 3, ce / 3);
  const after = afterFrames.slice(cs / 3, ce / 3);
  return { before, after, silent: before === after };
}

/** Design QuickChange-style mutagenesis primer pairs. */
export function designMutagenesisPrimers(template, mutationTexts, opts = {}) {
  const seq = normalizeSequence(template, 'template');
  const parsed = mutationTexts.map(parseMutation);
  const { mutated, spans } = applyMutations(seq, parsed);
  const spanStart = Math.min(...spans.map((span) => span.start));
  const spanEnd = Math.max(...spans.map((span) => span.end));
  const lenMin = opts.lenMin ?? 25;
  const lenMax = opts.lenMax ?? 45;
  const tmMin = opts.tmMin ?? 75;
  const tmMax = opts.tmMax ?? 85;
  const tmCenter = (tmMin + tmMax) / 2;

  const candidates = [];
  for (let len = lenMin; len <= lenMax; len++) {
    const center = (spanStart + spanEnd) / 2;
    let start = Math.round(center - len / 2);
    start = Math.max(1, Math.min(start, mutated.length - len + 1));
    const end = start + len - 1;
    if (spanStart - start < 6 || end - spanEnd < 6) continue;
    const primer = mutated.slice(start - 1, end);
    if (findRuns(primer, 4).length > 0) continue;
    const { gc, at } = baseCounts(primer);
    const gcPercent = gc + at === 0 ? 0 : (100 * gc) / (gc + at);
    if (gcPercent < 40 || gcPercent > 60) continue;
    if (primer[0] !== 'G' && primer[0] !== 'C') continue;
    if (primer[len - 1] !== 'G' && primer[len - 1] !== 'C') continue;
    let tm;
    try {
      tm = primerTm(primer, PCR_TM_OPTS).tm_celsius;
    } catch {
      continue;
    }
    if (tm < tmMin || tm > tmMax) continue;
    if (selfComplementarity(primer).bestScore > 10) continue;
    candidates.push({
      forward: primer,
      reverse: reverseComplement(primer),
      length: len,
      tm: round1(tm),
      gc_percent: round1(gcPercent),
      start,
      penalty: Math.abs(tm - tmCenter),
    });
  }
  candidates.sort((a, b) => a.penalty - b.penalty || a.length - b.length);
  const seen = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.forward)) continue;
    seen.add(candidate.forward);
    pairs.push(candidate);
  }
  return {
    mutated_sequence: mutated,
    mutation_span: { start: spanStart, end: spanEnd },
    amino_acid_change: aminoAcidChange(seq, mutated, spanStart, spanEnd),
    pairs: pairs.slice(0, opts.maxResults ?? 2),
  };
}

/** Small inter-primer dimer score: longest complementary run between primers. */
function dimerScore(p1, p2) {
  const rc = reverseComplement(p2);
  let best = 0;
  for (let offset = 0; offset < p1.length; offset++) {
    let run = 0;
    for (let i = 0; i + offset < p1.length && i < rc.length; i++) {
      run = p1[i + offset] === rc[i] ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  return { score: best, maxConsecutive: best };
}

/** Minimal validity check for a primer string (unambiguous bases only). */
export function isUnambiguous(seq) {
  for (const base of seq) if (!DNA_BASES.has(base)) return false;
  return true;
}
