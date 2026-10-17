/**
 * dsh-molbio-tools/silent-site.mjs
 *
 * Silent restriction-site mutagenesis: add or remove a recognition site by
 * changing codons only to synonyms, so the protein sequence is unchanged.
 *
 * The search is over CODONS, not nucleotides: for every codon that overlaps the
 * site window we enumerate the synonymous codons from the SAME genetic code the
 * translation tools use, rebuild only those codons, and keep the variants that
 * create/destroy the site. A variant is therefore silent by construction, and
 * the result lists every base change explicitly so it can be fed to
 * molbio_mutagenesis_primers.
 *
 * Limits, stated rather than hidden: only enzymes with an unambiguous A/C/G/T
 * recognition site are supported (a degenerate site such as GGTNACC would need
 * its IUPAC expansion enumerated), and the search is bounded by
 * SILENT_LIMITS. A silent change is silent for the protein, not necessarily for
 * mRNA structure, splicing or codon usage — the notes say so.
 */

import {
  CODON_TABLE,
  MolbioInputError,
  enzymePattern,
  normalizeSequence,
  reverseComplement,
} from './lib.mjs';
import { CODON_USAGE, CODON_HOSTS } from './protein.mjs';

export const SILENT_LIMITS = {
  maxSequenceLength: 100_000,
  maxSolutions: 20,
  maxCodonCombinations: 100_000,
  maxPositions: 50_000,
};

const BASES = new Set(['A', 'C', 'G', 'T']);

/** All codons that translate to the same amino acid as \`codon\`. */
export function synonymousCodons(codon, code = 'standard') {
  const table = CODON_TABLE[code];
  if (table === undefined) throw new MolbioInputError('unknown codon table ' + JSON.stringify(code));
  const aa = table[codon];
  if (aa === undefined) return [];
  return Object.keys(table).filter((candidate) => table[candidate] === aa);
}

/** Unambiguous recognition site for an enzyme, or a clear refusal. */
export function silentSitePattern(enzyme) {
  const spec = enzymePattern(enzyme);
  if (spec === undefined) throw new MolbioInputError('unknown enzyme ' + JSON.stringify(enzyme));
  if (![...spec.pattern].every((base) => BASES.has(base))) {
    throw new MolbioInputError('silent-site design needs an enzyme with an unambiguous A/C/G/T recognition site; ' + enzyme + ' has ' + spec.pattern);
  }
  return { site: spec.pattern, display: spec.display, reverse: reverseComplement(spec.pattern) };
}

function findOccurrences(sequence, site) {
  const reverse = reverseComplement(site);
  const palindromic = reverse === site;
  const found = [];
  for (const [pattern, strand] of [[site, 'forward'], [reverse, 'reverse']]) {
    // A palindromic site is ONE physical site, not two: the reverse-strand scan
    // finds the same bases. Counting both would report "remaining_sites: 2"
    // after adding a single BamHI site.
    if (palindromic && strand === 'reverse') continue;
    for (let start = 0; start + pattern.length <= sequence.length; start++) {
      if (sequence.slice(start, start + pattern.length) === pattern) {
        found.push({ start, end: start + pattern.length - 1, strand });
      }
    }
  }
  found.sort((a, b) => a.start - b.start || a.strand.localeCompare(b.strand));
  return found;
}

function siteSpans(start0, end0, frame, sequenceLength) {
  const offset = frame - 1;
  if (start0 < offset) return undefined;
  const first = Math.floor((start0 - offset) / 3);
  const last = Math.floor((end0 - offset) / 3);
  const spans = [];
  for (let index = first; index <= last; index++) {
    const start = offset + index * 3;
    if (start + 3 <= sequenceLength) spans.push({ index, start, end: start + 2 });
  }
  if (spans.length !== last - first + 1) return undefined;
  return { first, spans };
}

function codonChoices(sequence, spans, code) {
  const options = [];
  for (const span of spans) {
    const codon = sequence.slice(span.start, span.end + 1);
    if (![...codon].every((base) => BASES.has(base))) return undefined;
    const candidates = synonymousCodons(codon, code);
    if (candidates.length === 0) return undefined;
    options.push({ ...span, codon, candidates });
  }
  return options;
}

function cartesianChoices(options) {
  let combinations = [{ codons: [], choices: [] }];
  for (const option of options) {
    const next = [];
    for (const prefix of combinations) {
      for (const candidate of option.candidates) {
        next.push({ codons: [...prefix.codons, candidate], choices: [...prefix.choices, { ...option, chosen: candidate }] });
        if (next.length > SILENT_LIMITS.maxCodonCombinations) return undefined;
      }
    }
    combinations = next;
  }
  return combinations;
}

function replaceCodons(sequence, choices) {
  let out = sequence;
  for (const choice of choices) out = out.slice(0, choice.start) + choice.chosen + out.slice(choice.end + 1);
  return out;
}

function describeChanges(sequence, mutated, choices, code) {
  const table = CODON_TABLE[code];
  const changes = [];
  for (const choice of choices) {
    if (choice.chosen === choice.codon) continue;
    for (let offset = 0; offset < 3; offset++) {
      const before = choice.codon[offset];
      const after = choice.chosen[offset];
      if (before === after) continue;
      changes.push({
        position: choice.start + offset + 1,
        from: before,
        to: after,
        codon_index: choice.index + 1,
        codon_before: choice.codon,
        codon_after: choice.chosen,
        amino_acid: table[choice.codon],
      });
    }
  }
  changes.sort((a, b) => a.position - b.position);
  return changes;
}

function mutationTexts(changes) {
  return changes.map((change) => change.from + change.position + change.to);
}

function codonPreference(host, choices, code) {
  if (host === undefined || host === null || host === '') return 0;
  const usage = CODON_USAGE[host];
  if (usage === undefined) throw new MolbioInputError('unknown host ' + JSON.stringify(host) + '; known: ' + CODON_HOSTS.join(', '));
  let score = 0;
  for (const choice of choices) {
    if (choice.chosen === choice.codon) continue;
    const preferred = usage[changeAminoAcid(choice.codon, code)] ?? [];
    const rank = preferred.indexOf(choice.chosen);
    score += rank === -1 ? preferred.length : rank;
  }
  return score;
}

function changeAminoAcid(codon, code) {
  return CODON_TABLE[code][codon];
}

/**
 * Design silent site changes.
 * @param {string} rawSequence coding sequence (frame 1 unless frame is given).
 * @param {{enzyme: string, action: 'remove'|'add', frame?: number,
 *   codonTable?: string, host?: string, regionStart?: number, regionEnd?: number,
 *   maxSolutions?: number}} rawOptions
 */
export function designSilentSite(rawSequence, rawOptions = {}) {
  const sequence = normalizeSequence(rawSequence, 'sequence');
  if (sequence.length > SILENT_LIMITS.maxSequenceLength) {
    throw new MolbioInputError('sequence is ' + sequence.length + ' bp; the silent-site search limit is ' + SILENT_LIMITS.maxSequenceLength);
  }
  const action = rawOptions.action ?? 'remove';
  if (action !== 'remove' && action !== 'add') throw new MolbioInputError('action must be "remove" or "add"');
  const frame = rawOptions.frame ?? 1;
  if (!Number.isInteger(frame) || frame < 1 || frame > 3) throw new MolbioInputError('frame must be 1, 2 or 3');
  const code = rawOptions.codonTable ?? 'standard';
  if (CODON_TABLE[code] === undefined) throw new MolbioInputError('unknown codon_table ' + JSON.stringify(code));
  const host = rawOptions.host;
  if (host !== undefined && host !== '' && CODON_USAGE[host] === undefined) throw new MolbioInputError('unknown host ' + JSON.stringify(host));
  const pattern = silentSitePattern(rawOptions.enzyme);
  const maxSolutions = Math.min(Math.max(rawOptions.maxSolutions ?? 5, 1), SILENT_LIMITS.maxSolutions);
  const regionStart = rawOptions.regionStart ?? 1;
  const regionEnd = rawOptions.regionEnd ?? sequence.length;
  const before = findOccurrences(sequence, pattern.site);
  const notes = [];
  if (before.length === 0 && action === 'remove') notes.push('no ' + rawOptions.enzyme + ' recognition site was found; nothing to remove');
  const solutions = [];
  const seen = new Set();

  const consider = (siteStart0, siteEnd0, topSite, strand) => {
    if (siteStart0 + 1 < regionStart || siteEnd0 + 1 > regionEnd) return;
    const spansInfo = siteSpans(siteStart0, siteEnd0, frame, sequence.length);
    if (spansInfo === undefined || spansInfo.spans.length === 0) return;
    const choices = codonChoices(sequence, spansInfo.spans, code);
    if (choices === undefined) return;
    const combinations = cartesianChoices(choices);
    if (combinations === undefined) return;
    for (const combination of combinations) {
      // The site is at a known offset inside the first codon's span. Check the
      // variant window BEFORE building the whole molecule; a full-string scan
      // per codon combination is what would make an 8-cutter slow.
      const firstSpan = spansInfo.spans[0];
      const concat = combination.codons.join('');
      const offset = siteStart0 - firstSpan.start;
      const candidateSite = concat.slice(offset, offset + topSite.length);
      if (action === 'remove' && candidateSite === topSite) continue;
      if (action === 'add' && candidateSite !== topSite) continue;
      const mutated = replaceCodons(sequence, combination.choices);
      const after = findOccurrences(mutated, pattern.site);
      if (action === 'remove') {
        const removed = after.length < before.length;
        if (!removed) continue;
        if (after.some((entry) => entry.start === siteStart0 && entry.strand === strand)) continue;
      } else {
        const present = after.some((entry) => entry.start === siteStart0 && entry.strand === strand);
        if (!present) continue;
        if (before.some((entry) => entry.start === siteStart0 && entry.strand === strand)) continue;
      }
      const changes = describeChanges(sequence, mutated, combination.choices, code);
      if (changes.length === 0) continue;
      if (seen.has(mutated)) continue;
      seen.add(mutated);
      const preference = codonPreference(host, combination.choices, code);
      solutions.push({
        site_start: siteStart0 + 1,
        site_end: siteEnd0 + 1,
        strand,
        site: topSite,
        change_count: changes.length,
        codon_usage_penalty: preference,
        changes,
        mutation_texts: mutationTexts(changes),
        mutated_sequence: mutated,
        remaining_sites: after.length,
      });
    }
  };

  if (action === 'remove') {
    for (const occurrence of before) {
      const topSite = sequence.slice(occurrence.start, occurrence.end + 1);
      consider(occurrence.start, occurrence.end, topSite, occurrence.strand);
      if (solutions.length >= maxSolutions * 50) break;
    }
  } else {
    const positions = Math.min(sequence.length - pattern.site.length + 1, SILENT_LIMITS.maxPositions);
    if (positions < sequence.length - pattern.site.length + 1) notes.push('the sequence is long enough that only the first ' + positions + ' positions were searched; pass region_start/region_end to narrow it');
    for (const [topSite, strand] of [[pattern.site, 'forward'], [pattern.reverse, 'reverse']]) {
      for (let start = 0; start < positions; start++) {
        if (start + 1 < regionStart || start + topSite.length > regionEnd) continue;
        if (sequence.slice(start, start + topSite.length) === topSite) continue;
        consider(start, start + topSite.length - 1, topSite, strand);
      }
    }
    if (before.some((entry) => entry.strand === 'forward')) notes.push('the site already exists on the forward strand; the solutions add another copy');
    if (before.some((entry) => entry.strand === 'reverse')) notes.push('the site already exists on the reverse strand; the solutions add another copy');
  }

  solutions.sort((a, b) => a.change_count - b.change_count || a.codon_usage_penalty - b.codon_usage_penalty || a.site_start - b.site_start);
  const best = solutions.slice(0, maxSolutions);
  if (best.length === 0) notes.push(action === 'remove' ? 'no silent codon change could remove the site in this frame/region' : 'no silent codon change could add the site in this frame/region; widen the region or check the frame');
  notes.push('A silent change preserves the protein sequence; it can still change codon usage, mRNA structure or splicing — review before ordering.');
  notes.push('The site may also be blocked by Dam/Dcm methylation; check molbio_methylation_check before concluding a digest failed.');
  return {
    enzyme: rawOptions.enzyme,
    site: pattern.site,
    display: pattern.display,
    action,
    frame,
    codon_table: code,
    host: host ?? '',
    sites_before: before.length,
    solutions: best,
    notes,
  };
}
