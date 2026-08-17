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
