/**
 * dsh-molbio-tools/index.mjs
 *
 * DeepSeek Harness Cordis plugin: molecular-biology computation tools for the
 * model. Zero runtime dependencies — the only import is the sibling lib.mjs —
 * so the package is a pair of files that travel with an agent preset and can
 * be referenced by a relative plugin row (see README.md).
 *
 * Every tool is pure computation: deterministic, no network, no filesystem.
 * The plugin publishes no service, so the preset row needs no isolate realm.
 */

import {
  MolbioInputError,
  GENETIC_CODES,
  ENZYME_NAMES,
  analyzeQpcr,
  baseCounts,
  complement,
  digest,
  dimerPotential,
  findHairpins,
  findRepeats,
  findRuns,
  labMath,
  normalizeSequence,
  primerTm,
  reverseComplement,
  selfComplementarity,
  translateFrames,
} from './lib.mjs';
import { designIntronPrimers, designPrimers } from './design.mjs';
import { parseGenBank } from './genbank.mjs';
import { renderPlasmidMap } from './plasmid.mjs';
import { parseSnapGeneBytes } from './snapgene.mjs';
import {
  designClonePrimers,
  designMutagenesisPrimers,
  simulateClone,
  uniqueCutters,
} from './cloning.mjs';
import { readTraceFromBytes, verifySanger } from './sanger.mjs';
import { CODON_HOSTS, codonOptimize, peptideDigest, proteinProperties } from './protein.mjs';
import { linearFit, renderBarChart, renderScatterChart } from './plot.mjs';
import { entryStats, parseFasta, parseFastq, toFasta } from './seqio.mjs';
import { addExperiment, addProtocol, loadRecords, recordPath, saveRecords, updateProtocol } from './records.mjs';
import { toBibtex } from './papers.mjs';
import { parseXml } from './snapgene.mjs';
import { smithWaterman } from './align.mjs';
import {
  addPapers,
  libraryPath,
  loadLibrary,
  pmidFromUrl,
  removePaper,
  saveLibrary,
  updatePaper,
  workspaceFilePath,
  writeWorkspaceFile,
} from './papers.mjs';

export const name = 'dsh-molbio-tools';
export const inject = ['tools', 'systemPrompt'];

/**
 * Generic argument validation against a raw JSON-Schema parameter object.
 * This plugin registers RAW tool definitions (it is zero-dependency and cannot
 * import defineTool), so it mirrors defineTool's execute-time argument
 * validation itself: required presence, per-property types, enums, and nested
 * object/array shapes.
 */
function validateArgsAgainstSchema(schema, args, label = '') {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new MolbioInputError('tool arguments must be an object');
  }
  if (schema.type !== 'object') return;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const violations = [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) violations.push(`missing required argument "${key}"`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) violations.push(`unknown argument "${key}"`);
    }
  }
  if (violations.length > 0) throw new MolbioInputError(`invalid arguments: ${violations.join('; ')}`);
  const check = (node, value, key) => {
    const type = node.type;
    if (type === undefined) return;
    if (type === 'string' && typeof value !== 'string') throw new MolbioInputError(`invalid argument "${key}": expected a string`);
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new MolbioInputError(`invalid argument "${key}": expected a finite number`);
    if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) throw new MolbioInputError(`invalid argument "${key}": expected an integer`);
    if (type === 'boolean' && typeof value !== 'boolean') throw new MolbioInputError(`invalid argument "${key}": expected a boolean`);
    if (type === 'array' && !Array.isArray(value)) throw new MolbioInputError(`invalid argument "${key}": expected an array`);
    if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new MolbioInputError(`invalid argument "${key}": expected an object`);
    if (type === 'string' && node.enum !== undefined && !node.enum.includes(value)) throw new MolbioInputError(`invalid argument "${key}": must be one of ${node.enum.join(', ')}`);
    if (type === 'object' && node.properties !== undefined) {
      for (const childKey of node.required ?? []) {
        if (value[childKey] === undefined || value[childKey] === null) throw new MolbioInputError(`invalid argument "${key}.${childKey}": missing`);
      }
      for (const [childKey, child] of Object.entries(node.properties)) {
        if (value[childKey] !== undefined) check(child, value[childKey], `${key}.${childKey}`);
      }
    }
    if (type === 'array' && node.items !== undefined) {
      for (let i = 0; i < value.length; i++) check(node.items, value[i], `${key}[${i}]`);
    }
  };
  for (const [key, value] of Object.entries(args)) {
    const node = properties[key];
    if (node !== undefined && value !== undefined) check(node, value, key);
  }
}

/**
 * Build one registry-ready raw tool definition.
 * `safe` declares concurrency safety: true for pure/read-only tools, false for
 * tools that write files (the registry may run safe tools in parallel), or a
 * function of the arguments for tools that write only conditionally.
 */
function define({ name: toolName, description, parameters, outputSchema, render, execute, safe = true }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render(_args, value) {
        return [{ type: 'text', text: render(value) }];
      },
    },
    async execute(args, exec) {
      validateArgsAgainstSchema(parameters, args);
      return execute(args, exec);
    },
    isConcurrencySafe: typeof safe === 'function' ? safe : () => safe,
  };
}

// NOTE: in raw JSON Schema the `required` keyword is an ARRAY on the object
// level (see each tool's parameters.required), never `required: true` inside a
// property schema.
function requiredString(description) {
  return { type: 'string', description };
}
function optionalNumber(description) {
  return { type: 'number', description };
}

// ── shared output fragments ─────────────────────────────────────────────────

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['base', 'count', 'start'],
  properties: {
    base: { type: 'string' },
    count: { type: 'integer' },
    start: { type: 'integer' },
  },
};

const REPEAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['motif', 'count', 'start'],
  properties: {
    motif: { type: 'string' },
    count: { type: 'integer' },
    start: { type: 'integer' },
  },
};

const HAIRPIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'stem', 'loop', 'pairs', 'score'],
  properties: {
    start: { type: 'integer' },
    stem: { type: 'integer' },
    loop: { type: 'integer' },
    pairs: { type: 'integer' },
    score: { type: 'integer' },
  },
};

const PRIMER_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['length', 'gc_percent', 'runs', 'repeats', 'self_complement_score', 'self_consecutive', 'self_3prime_pairs', 'hairpins'],
  properties: {
    length: { type: 'integer' },
    gc_percent: { type: 'number' },
    runs: { type: 'array', items: RUN_SCHEMA },
    repeats: { type: 'array', items: REPEAT_SCHEMA },
    self_complement_score: { type: 'integer' },
    self_consecutive: { type: 'integer' },
    self_3prime_pairs: { type: 'integer' },
    hairpins: { type: 'array', items: HAIRPIN_SCHEMA },
  },
};

// ── tools ───────────────────────────────────────────────────────────────────

const reverseComplementTool = define({
  name: 'molbio_reverse_complement',
  description: 'Compute the complement and reverse complement of a DNA/RNA sequence (IUPAC codes supported; whitespace and digits are ignored). The reverse complement of the bottom strand is the top strand — use it to convert between strand conventions or to orient an insert.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('DNA or RNA sequence (IUPAC: A C G T U R Y S W K M B D H V N).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['original', 'complement', 'reverse_complement', 'length', 'gc_percent'],
    properties: {
      original: { type: 'string' },
      complement: { type: 'string' },
      reverse_complement: { type: 'string' },
      length: { type: 'integer' },
      gc_percent: { type: 'number' },
    },
  },
  render(value) {
    return [
      `original (${value.length} bp): ${value.original}`,
      `complement:            ${value.complement}`,
      `reverse complement:    ${value.reverse_complement}`,
      `GC content: ${value.gc_percent}%`,
    ].join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    const rev = reverseComplement(seq);
    const { gc, at } = baseCounts(seq);
    const gcPercent = gc + at === 0 ? 0 : Math.round((gc / (gc + at)) * 10000) / 100;
    return {
      original: seq,
      complement: complement(seq),
      reverse_complement: rev,
      length: seq.length,
      gc_percent: gcPercent,
    };
  },
});

const gcTool = define({
  name: 'molbio_gc_content',
  description: 'Compute overall GC content of a sequence and, optionally, per-window GC percentages for non-overlapping windows. Useful for checking amplicons, probes, and sequencing-library inserts.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('DNA/RNA sequence (IUPAC).'),
      window: { type: 'integer', description: 'Optional window size in bp (10–100000) for per-window GC percentages; omit for overall GC only.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length', 'gc_count', 'at_count', 'ambiguous_count', 'gc_percent', 'gc_percent_excluding_ambiguous', 'windows'],
    properties: {
      length: { type: 'integer' },
      gc_count: { type: 'integer' },
      at_count: { type: 'integer' },
      ambiguous_count: { type: 'integer' },
      gc_percent: { type: 'number' },
      gc_percent_excluding_ambiguous: { type: 'number' },
      windows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end', 'gc_percent'],
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
            gc_percent: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `length: ${value.length} bp`,
      `GC: ${value.gc_count}  AT: ${value.at_count}  ambiguous: ${value.ambiguous_count}`,
      `GC content: ${value.gc_percent}% (${value.gc_percent_excluding_ambiguous}% excluding ambiguous bases)`,
    ];
    if (value.windows.length > 0) {
      lines.push('per-window GC:');
      for (const w of value.windows) lines.push(`  ${w.start}-${w.end}: ${w.gc_percent}%`);
    }
    return lines.join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    const { gc, at, n } = baseCounts(seq);
    const windows = [];
    const window = args.window;
    if (window !== undefined) {
      if (!Number.isInteger(window) || window < 10 || window > 100000) {
        throw new MolbioInputError('window must be an integer between 10 and 100000');
      }
      for (let start = 0; start < seq.length; start += window) {
        const end = Math.min(start + window, seq.length);
        const slice = seq.slice(start, end);
        const counts = baseCounts(slice);
        const unambiguous = counts.gc + counts.at;
        windows.push({
          start: start + 1,
          end,
          gc_percent: unambiguous === 0 ? 0 : Math.round((counts.gc / unambiguous) * 10000) / 100,
        });
      }
    }
    const unambiguous = gc + at;
    return {
      length: seq.length,
      gc_count: gc,
      at_count: at,
      ambiguous_count: n,
      gc_percent: seq.length === 0 ? 0 : Math.round((gc / seq.length) * 10000) / 100,
      gc_percent_excluding_ambiguous: unambiguous === 0 ? 0 : Math.round((gc / unambiguous) * 10000) / 100,
      windows,
    };
  },
});

const translateTool = define({
  name: 'molbio_translate',
  description: 'Translate a DNA/RNA sequence in one or more frames and report open reading frames. Choose frames 1/2/3 (forward), -1/-2/-3 (reverse), or all six. Stop codons appear as "*"; with min_orf_aa > 0 the tool also lists ORFs of at least that many amino acids.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Coding DNA/RNA sequence (IUPAC).'),
      frames: { type: 'string', enum: ['1', '2', '3', '-1', '-2', '-3', 'all'], description: 'Frame(s) to translate; default "all".' },
      code: { type: 'string', enum: GENETIC_CODES, description: 'Genetic code; default "standard".' },
      min_orf_aa: { type: 'integer', description: 'Minimum ORF length in amino acids to report (default 30; 0 disables ORF listing).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['frames', 'orfs'],
    properties: {
      frames: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['frame', 'protein', 'length', 'stops', 'first_stop'],
          properties: {
            frame: { type: 'string' },
            protein: { type: 'string' },
            length: { type: 'integer' },
            stops: { type: 'integer' },
            first_stop: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
      },
      orfs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['frame', 'start', 'end', 'length_aa', 'sequence'],
          properties: {
            frame: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            length_aa: { type: 'integer' },
            sequence: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [];
    for (const f of value.frames) {
      const first = f.first_stop === null ? 'no stop' : `first stop at template position ${f.first_stop + 1}`;
      lines.push(`frame ${f.frame} (${f.length} aa, ${f.stops} stop(s), ${first}):`);
      lines.push(`  ${f.protein}`);
    }
    if (value.orfs.length > 0) {
      lines.push(`ORFs (>= min_orf_aa):`);
      for (const orf of value.orfs) {
        lines.push(`  frame ${orf.frame}, bases ${orf.start + 1}-${orf.end + 1}, ${orf.length_aa} aa: ${orf.sequence}`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    const frames = args.frames ?? 'all';
    const validFrames = ['1', '2', '3', '-1', '-2', '-3', 'all'];
    if (!validFrames.includes(frames)) throw new MolbioInputError(`frames must be one of ${validFrames.join(', ')}`);
    const code = args.code ?? 'standard';
    if (!GENETIC_CODES.includes(code)) throw new MolbioInputError(`code must be one of ${GENETIC_CODES.join(', ')}`);
    let minOrf = args.min_orf_aa ?? 30;
    if (!Number.isInteger(minOrf) || minOrf < 0) throw new MolbioInputError('min_orf_aa must be a non-negative integer');
    if (minOrf > 100000) minOrf = 100000;
    const { results, orfs } = translateFrames(seq, frames, code, minOrf);
    return { frames: results, orfs };
  },
});

const restrictionTool = define({
  name: 'molbio_restriction_sites',
  description: 'Find restriction enzyme recognition sites in a sequence and compute the expected digestion fragments (linear or circular). Pass the enzyme names you care about, or ["common"] to scan every enzyme in the built-in table. Cut positions use the standard cut notation of each site (e.g. EcoRI G^AATTC).',
  parameters: {
    type: 'object',
    required: ['sequence', 'enzymes'],
    properties: {
      sequence: requiredString('DNA sequence to digest (IUPAC; ambiguous bases in the sequence are treated as no-match).'),
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzyme names, or ["common"] for all built-in enzymes.' },
      circular: { type: 'boolean', description: 'True for circular DNA (plasmids): fragments wrap around the origin. Default false (linear).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['circular', 'enzymes'],
    properties: {
      circular: { type: 'boolean' },
      enzymes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'site', 'matches', 'cut_positions', 'fragments'],
          properties: {
            name: { type: 'string' },
            site: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end', 'sequence'],
                properties: {
                  start: { type: 'integer' },
                  end: { type: 'integer' },
                  sequence: { type: 'string' },
                },
              },
            },
            cut_positions: { type: 'array', items: { type: 'integer' } },
            fragments: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [`digest of ${value.circular ? 'circular' : 'linear'} DNA:`];
    for (const enzyme of value.enzymes) {
      lines.push(`- ${enzyme.name} (${enzyme.site}):`);
      if (enzyme.matches.length === 0) {
        lines.push('    no sites; uncut: 1 fragment');
      } else {
        for (const m of enzyme.matches) lines.push(`    site at ${m.start + 1}-${m.end + 1} (${m.sequence}), cut at ${m.start + 1 + enzyme.site.indexOf('^')}`);
        lines.push(`    ${enzyme.fragments.length} fragment(s): ${enzyme.fragments.join(', ')} bp`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence);
    let enzymes = args.enzymes;
    if (!Array.isArray(enzymes) || enzymes.length === 0) throw new MolbioInputError('enzymes must be a non-empty array of enzyme names');
    if (enzymes.length === 1 && enzymes[0] === 'common') enzymes = ENZYME_NAMES;
    const circular = args.circular === true;
    const results = digest(seq, enzymes, circular);
    return { circular, enzymes: results };
  },
});

const primerTmTool = define({
  name: 'molbio_primer_tm',
  description: 'Estimate primer melting temperature with the SantaLucia (1998) nearest-neighbour model, salt-corrected for monovalent cations and magnesium (von Ahsen 2001). Defaults: 50 mM Na+, 0 mM Mg2+, 0.8 mM dNTP, 500 nM primer. Treat the result as a design estimate (rounded to 0.01 °C), not a replacement for an instrument calibration.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Primer sequence (5\'→3\', IUPAC; ≥4 bases).'),
      na_mm: optionalNumber('Monovalent cation concentration in mM (default 50).'),
      mg_mm: optionalNumber('Magnesium concentration in mM (default 0).'),
      dntp_mm: optionalNumber('Total dNTP concentration in mM (default 0.8; only affects the Mg equivalence term when Mg > dNTP).'),
      primer_nm: optionalNumber('Primer concentration in nM (default 500).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['tm_celsius', 'length', 'gc_percent', 'na_equivalent_mm'],
    properties: {
      tm_celsius: { type: 'number' },
      length: { type: 'integer' },
      gc_percent: { type: 'number' },
      na_equivalent_mm: { type: 'number' },
    },
  },
  render(value) {
    return `Tm ≈ ${value.tm_celsius} °C (${value.length} bp, GC ${value.gc_percent}%, Na+ equivalent ${value.na_equivalent_mm} mM) — SantaLucia 1998 NN estimate, salt-corrected.`;
  },
  execute(args) {
    const seq = normalizeSequence(args.sequence, 'primer sequence');
    const { tm_celsius, na_equivalent_mm } = primerTm(seq, {
      naMm: args.na_mm ?? 50,
      mgMm: args.mg_mm ?? 0,
      dntpMm: args.dntp_mm ?? 0.8,
      primerNm: args.primer_nm ?? 500,
    });
    const { gc, at } = baseCounts(seq);
    const unambiguous = gc + at;
    return {
      tm_celsius,
      length: seq.length,
      gc_percent: unambiguous === 0 ? 0 : Math.round((gc / unambiguous) * 10000) / 100,
      na_equivalent_mm,
    };
  },
});

function primerReport(seq) {
  const { gc, at } = baseCounts(seq);
  const unambiguous = gc + at;
  const sc = selfComplementarity(seq);
  return {
    length: seq.length,
    gc_percent: unambiguous === 0 ? 0 : Math.round((gc / unambiguous) * 10000) / 100,
    runs: findRuns(seq),
    repeats: findRepeats(seq),
    self_complement_score: sc.bestScore,
    self_consecutive: sc.bestConsecutive,
    self_3prime_pairs: sc.threePrimePairs,
    hairpins: findHairpins(seq),
  };
}

const primerCheckTool = define({
  name: 'molbio_primer_check',
  description: 'Screen one primer (or a primer pair) for PCR design red flags: mononucleotide runs, short tandem repeats, self-complementarity (3\' end weighted), hairpins, and — for a pair — dimer potential via complementary alignment of the two primers. Interpret scores relatively: higher 3\'-weighted scores are riskier.',
  parameters: {
    type: 'object',
    required: ['primer1'],
    properties: {
      primer1: requiredString('First primer sequence (5\'→3\').'),
      primer2: { type: 'string', description: 'Optional second primer (5\'→3\') for dimer analysis.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['primer1'],
    properties: {
      primer1: PRIMER_REPORT_SCHEMA,
      primer2: PRIMER_REPORT_SCHEMA,
      pair: {
        type: 'object',
        additionalProperties: false,
        required: ['score', 'max_consecutive', 'three_prime_pairs'],
        properties: {
          score: { type: 'integer' },
          max_consecutive: { type: 'integer' },
          three_prime_pairs: { type: 'integer' },
        },
      },
    },
  },
  render(value) {
    const lines = [];
    const fmt = (label, report) => {
      lines.push(`${label}: ${report.length} bp, GC ${report.gc_percent}%`);
      if (report.runs.length > 0) lines.push(`  runs: ${report.runs.map((r) => `${r.base}x${r.count}@${r.start}`).join(', ')}`);
      if (report.repeats.length > 0) lines.push(`  repeats: ${report.repeats.map((r) => `(${r.motif})x${r.count}@${r.start}`).join(', ')}`);
      lines.push(`  self-complementarity: score ${report.self_complement_score}, max consecutive ${report.self_consecutive}, 3\' pairs ${report.self_3prime_pairs}/6`);
      if (report.hairpins.length > 0) lines.push(`  hairpins: ${report.hairpins.map((h) => `stem ${h.stem}/loop ${h.loop}@${h.start} (score ${h.score})`).join(', ')}`);
    };
    fmt('primer1', value.primer1);
    if (value.primer2 !== undefined) fmt('primer2', value.primer2);
    if (value.pair !== undefined) {
      lines.push(`pair (dimer): score ${value.pair.score}, max consecutive ${value.pair.max_consecutive}, 3\' pairs ${value.pair.three_prime_pairs}/6`);
    }
    return lines.join('\n');
  },
  execute(args) {
    const p1 = normalizeSequence(args.primer1, 'primer1');
    const out = { primer1: primerReport(p1) };
    if (args.primer2 !== undefined && args.primer2 !== null) {
      const p2 = normalizeSequence(args.primer2, 'primer2');
      out.primer2 = primerReport(p2);
      const d = dimerPotential(p1, p2);
      out.pair = { score: d.score, max_consecutive: d.maxConsecutive, three_prime_pairs: d.threePrimePairs };
    }
    return out;
  },
});

const qpcrTool = define({
  name: 'molbio_qpcr_analysis',
  description: 'Analyse qPCR Ct values with the ΔΔCt method: means and SDs per group, ΔCt, ΔΔCt, and fold change (efficiency^-ΔΔCt). Pass four lists: target Ct in treated and control samples, and reference (housekeeping) Ct in the same samples. Ct values must be positive numbers.',
  parameters: {
    type: 'object',
    required: ['target_treated', 'target_control', 'reference_treated', 'reference_control'],
    properties: {
      target_treated: { type: 'array', items: { type: 'number' }, description: 'Ct values of the target gene in treated samples.' },
      target_control: { type: 'array', items: { type: 'number' }, description: 'Ct values of the target gene in control samples.' },
      reference_treated: { type: 'array', items: { type: 'number' }, description: 'Ct values of the reference gene in treated samples.' },
      reference_control: { type: 'array', items: { type: 'number' }, description: 'Ct values of the reference gene in control samples.' },
      efficiency: optionalNumber('Amplification efficiency as the per-cycle factor (1.5–2.5); default 2.0 (perfect 100% doubling).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'target_treated_mean', 'target_treated_sd', 'target_control_mean', 'target_control_sd',
      'reference_treated_mean', 'reference_treated_sd', 'reference_control_mean', 'reference_control_sd',
      'delta_ct_treated', 'delta_ct_control', 'delta_delta_ct', 'fold_change',
    ],
    properties: {
      target_treated_mean: { type: 'number' },
      target_treated_sd: { type: 'number' },
      target_control_mean: { type: 'number' },
      target_control_sd: { type: 'number' },
      reference_treated_mean: { type: 'number' },
      reference_treated_sd: { type: 'number' },
      reference_control_mean: { type: 'number' },
      reference_control_sd: { type: 'number' },
      delta_ct_treated: { type: 'number' },
      delta_ct_control: { type: 'number' },
      delta_delta_ct: { type: 'number' },
      fold_change: { type: 'number' },
    },
  },
  render(value) {
    return [
      `ΔCt treated  = ${value.delta_ct_treated} (target ${value.target_treated_mean} ± ${value.target_treated_sd} − reference ${value.reference_treated_mean} ± ${value.reference_treated_sd})`,
      `ΔCt control  = ${value.delta_ct_control} (target ${value.target_control_mean} ± ${value.target_control_sd} − reference ${value.reference_control_mean} ± ${value.reference_control_sd})`,
      `ΔΔCt = ${value.delta_delta_ct}`,
      `fold change (efficiency^-ΔΔCt) = ${value.fold_change}`,
    ].join('\n');
  },
  execute(args) {
    const efficiency = args.efficiency ?? 2.0;
    if (typeof efficiency !== 'number' || efficiency < 1.5 || efficiency > 2.5) {
      throw new MolbioInputError('efficiency must be a per-cycle factor between 1.5 and 2.5 (2.0 = perfect doubling)');
    }
    return analyzeQpcr({
      targetTreated: args.target_treated,
      targetControl: args.target_control,
      referenceTreated: args.reference_treated,
      referenceControl: args.reference_control,
      efficiency,
    });
  },
});

const labMathTool = define({
  name: 'molbio_lab_math',
  description: 'Everyday bench calculations. dilution: give exactly 3 of {c1, v1, c2, v2} and the fourth is solved (C1·V1 = C2·V2). molarity: mass_mg, mw_g_per_mol, volume_ml → mM. copy_number: mass_ng and length_bp → template copies.',
  parameters: {
    type: 'object',
    required: ['operation'],
    properties: {
      operation: { type: 'string', enum: ['dilution', 'molarity', 'copy_number'], description: 'Which calculation to run.' },
      c1: optionalNumber('Starting concentration (dilution).'),
      v1: optionalNumber('Starting volume (dilution).'),
      c2: optionalNumber('Final concentration (dilution).'),
      v2: optionalNumber('Final volume (dilution).'),
      mass_mg: optionalNumber('Solute mass in mg (molarity).'),
      mw_g_per_mol: optionalNumber('Molecular weight in g/mol (molarity).'),
      volume_ml: optionalNumber('Final volume in mL (molarity).'),
      mass_ng: optionalNumber('DNA mass in ng (copy_number).'),
      length_bp: optionalNumber('DNA length in bp (copy_number).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'result', 'unit', 'detail'],
    properties: {
      operation: { type: 'string' },
      result: { type: 'number' },
      unit: { type: 'string' },
      detail: { type: 'string' },
    },
  },
  render(value) {
    return `${value.operation}: result = ${value.result} ${value.unit} (${value.detail})`;
  },
  execute(args) {
    return { operation: args.operation, ...labMath(args.operation, args) };
  },
});

// ── primer design ───────────────────────────────────────────────────────────

const MISMATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'template_base', 'primer_base', 'template_position', 'distance_from_3prime'],
  properties: {
    position: { type: 'integer', description: '1-based position of the mismatch in the primer (5\'→3\').' },
    template_base: { type: 'string', description: 'The base a perfectly matching primer would carry at this position (forward primers: the template base; reverse primers: its complement).' },
    primer_base: { type: 'string', description: 'The base the reported primer actually carries (' + '"primer_base !== template_base"' + ' marks a real mismatch).' },
    template_position: { type: 'integer', description: '1-based position on the template (forward strand) where the primer binds.' },
    distance_from_3prime: { type: 'integer', description: 'Number of bases between this mismatch and the primer 3\' end (0 = terminal base).' },
  },
};

const PRIMER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'start', 'end', 'length', 'tm', 'gc_percent'],
  properties: {
    sequence: { type: 'string' },
    start: { type: 'integer' },
    end: { type: 'integer' },
    length: { type: 'integer' },
    tm: { type: 'number' },
    gc_percent: { type: 'number' },
    mismatch_count: { type: 'integer', description: 'Number of primer-template mismatches this primer carries (0 = exact match; v12).' },
    mismatches: { type: 'array', items: MISMATCH_SCHEMA },
  },
};

const designPrimersTool = define({
  name: 'molbio_design_primers',
  description: 'Design PCR primer pairs on a template sequence. Scans for forward and reverse primers that satisfy Tm (SantaLucia 1998 NN, 50 mM Na+, 1.5 mM Mg2+, 200 nM), GC content, length, GC clamp, run, hairpin, self-complementarity and dimer constraints, then ranks pairs inside the amplicon window. Returns up to max_results pairs ordered by quality (lower penalty is better). v12: pass max_mismatches > 0 to also allow primers that carry a few positional mismatches against the template — used when no exact primer satisfies every constraint in a region. Mismatches are never placed on the 3\'-terminal base and avoid the 3\'-terminal critical zone by default; each mismatch is reported per primer in `mismatches` and adds a ranking penalty, so exact primers always win when available.',
  parameters: {
    type: 'object',
    required: ['template'],
    properties: {
      template: requiredString('Template sequence to design primers on (IUPAC).'),
      region_start: { type: 'integer', description: '1-based start of the region the amplicon must lie in (default 1).' },
      region_end: { type: 'integer', description: '1-based end of the region (default template end).' },
      primer_len_min: { type: 'integer', description: 'Minimum primer length (default 18).' },
      primer_len_max: { type: 'integer', description: 'Maximum primer length (default 28, max 40).' },
      tm_min: { type: 'number', description: 'Minimum primer Tm °C (default 55).' },
      tm_max: { type: 'number', description: 'Maximum primer Tm °C (default 65).' },
      gc_min: { type: 'number', description: 'Minimum primer GC% (default 40).' },
      gc_max: { type: 'number', description: 'Maximum primer GC% (default 60).' },
      amplicon_min: { type: 'integer', description: 'Minimum amplicon length bp (default 80).' },
      amplicon_max: { type: 'integer', description: 'Maximum amplicon length bp (default 1000).' },
      require_gc_clamp: { type: 'boolean', description: 'Require a G/C at the primer 3\' end (default true).' },
      max_run: { type: 'integer', description: 'Maximum allowed run of identical bases (default 3).' },
      max_self_score: { type: 'integer', description: 'Maximum self-complementarity score (default 8).' },
      max_self_consecutive: { type: 'integer', description: 'Maximum consecutive self-complementary pairs (default 4).' },
      max_hairpin_score: { type: 'integer', description: 'Maximum hairpin score (default 10).' },
      max_dimer_score: { type: 'integer', description: 'Maximum primer-pair dimer score (default 12).' },
      max_tm_delta: { type: 'number', description: 'Maximum |Tm(forward) - Tm(reverse)| in °C (default 3).' },
      max_mismatches: { type: 'integer', description: 'Maximum primer-template mismatches the designer may introduce (0-5, default 0 = exact match required). Only used when no exact primer passes the constraints in a window; mismatches are never placed on the 3\'-terminal base.' },
      max_3prime_mismatches: { type: 'integer', description: 'Maximum mismatches tolerated inside the 3\'-terminal critical zone (mismatch_3prime_zone bases before the terminal base); default 0 (none).' },
      mismatch_3prime_zone: { type: 'integer', description: 'Length of the 3\'-terminal critical zone in bases (1-10, default 5); mismatches inside it require max_3prime_mismatches > 0.' },
      max_results: { type: 'integer', description: 'Maximum pairs to return (default 5).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['pairs'],
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'amplicon', 'penalty'],
          properties: {
            forward: PRIMER_SCHEMA,
            reverse: PRIMER_SCHEMA,
            amplicon: {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end', 'length'],
              properties: {
                start: { type: 'integer' },
                end: { type: 'integer' },
                length: { type: 'integer' },
              },
            },
            penalty: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    if (value.pairs.length === 0) {
      return 'no primer pair satisfied all constraints — relax Tm/GC/amplicon windows or disable the GC clamp and retry.';
    }
    const lines = [`${value.pairs.length} candidate primer pair(s), best first:`];
    const mismatchLine = (label, primer) => {
      if (primer.mismatch_count > 0) {
        const details = primer.mismatches
          .map((m) => `5'-pos ${m.position} ${m.template_base}→${m.primer_base} (template bp ${m.template_position}, ${m.distance_from_3prime} bp from 3')`)
          .join('; ');
        lines.push(`  ${label} carries ${primer.mismatch_count} mismatch(es) vs template: ${details}`);
      }
    };
    for (const [index, pair] of value.pairs.entries()) {
      lines.push(`#${index + 1} amplicon ${pair.amplicon.start}-${pair.amplicon.end} (${pair.amplicon.length} bp), penalty ${pair.penalty}`);
      lines.push(`  F ${pair.forward.sequence}  (${pair.forward.start}-${pair.forward.end}, Tm ${pair.forward.tm} °C, GC ${pair.forward.gc_percent}%)`);
      lines.push(`  R ${pair.reverse.sequence}  (${pair.reverse.start}-${pair.reverse.end}, Tm ${pair.reverse.tm} °C, GC ${pair.reverse.gc_percent}%)`);
      mismatchLine('F', pair.forward);
      mismatchLine('R', pair.reverse);
    }
    return lines.join('\n');
  },
  execute(args) {
    const { pairs } = designPrimers(args.template, {
      regionStart: args.region_start,
      regionEnd: args.region_end,
      lenMin: args.primer_len_min,
      lenMax: args.primer_len_max,
      tmMin: args.tm_min,
      tmMax: args.tm_max,
      gcMin: args.gc_min,
      gcMax: args.gc_max,
      ampliconMin: args.amplicon_min,
      ampliconMax: args.amplicon_max,
      requireGcClamp: args.require_gc_clamp,
      maxRun: args.max_run,
      maxSelfScore: args.max_self_score,
      maxSelfConsecutive: args.max_self_consecutive,
      maxHairpinScore: args.max_hairpin_score,
      maxDimerScore: args.max_dimer_score,
      maxTmDelta: args.max_tm_delta,
      maxMismatches: args.max_mismatches,
      max3PrimeMismatches: args.max_3prime_mismatches,
      mismatch3PrimeZone: args.mismatch_3prime_zone,
      maxResults: args.max_results,
    });
    return { pairs };
  },
});

// ── GenBank parsing and plasmid maps ────────────────────────────────────────

const FEATURE_IN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'start', 'end'],
  properties: {
    label: { type: 'string' },
    type: { type: 'string', description: 'Feature type used for the color: CDS, gene, rep_origin, promoter, terminator, misc_feature, ...' },
    start: { type: 'integer', description: '1-based start position.' },
    end: { type: 'integer', description: '1-based end position (inclusive).' },
    strand: { type: 'integer', enum: [1, -1], description: '1 = forward, -1 = reverse complement (default 1).' },
  },
};

const parseGenbankTool = define({
  name: 'molbio_parse_genbank',
  description: 'Parse a GenBank flatfile record into structured data: locus name, accession, definition, topology (circular/linear), features (type, 1-based span, strand, label from /product or /gene), and the origin sequence. Feed the returned features to molbio_plasmid_map to draw the map.',
  parameters: {
    type: 'object',
    required: ['genbank'],
    properties: {
      genbank: requiredString('Complete GenBank record text (LOCUS ... //).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'length', 'features', 'sequence'],
    properties: {
      name: { type: 'string' },
      accession: { type: 'string' },
      definition: { type: 'string' },
      topology: { type: 'string', enum: ['circular', 'linear'] },
      length: { type: 'integer' },
      features: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'start', 'end', 'strand', 'label'],
          properties: {
            type: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            strand: { type: 'integer', enum: [1, -1] },
            label: { type: 'string' },
            gene: { type: 'string' },
            product: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      sequence: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.name}${value.accession !== undefined ? ' (' + value.accession + ')' : ''}: ${value.length} bp${value.topology !== undefined ? ', ' + value.topology : ''}`,
      `${value.features.length} feature(s):`,
    ];
    for (const feature of value.features) {
      lines.push(`  ${feature.type} ${feature.start}-${feature.end} (${feature.strand === -1 ? 'complement' : 'forward'}): ${feature.label}`);
    }
    return lines.join('\n');
  },
  execute(args) {
    return parseGenBank(args.genbank);
  },
});

/** Safe default file name for a map. */
function svgFileName(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 60);
  return (cleaned === '' ? 'plasmid' : cleaned) + '.svg';
}

/** Write an SVG map into the session workspace through the sandboxed fs seam. */
async function writeSvgFile(ctx, exec, args, svg, defaultName) {
  const fs = fsService(ctx);
  const sandboxPolicyService = ctx.get('sandboxPolicy');
  const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
  const file = workspaceFilePath(args.output_path ?? svgFileName(defaultName), exec, policy?.workspaceRoot);
  await writeWorkspaceFile(fs, file, svg, policy);
  return file;
}

const plasmidMapTool = (ctx) => define({
  safe: false,
  name: 'molbio_plasmid_map',
  description: 'Render a plasmid map (circular by default, or linear) from a sequence plus features (from molbio_parse_genbank / molbio_parse_snapgene or hand-written) and WRITE it as a standalone SVG file in the session workspace. The tool writes the file itself — the SVG text never reaches the conversation, so do not try to re-render or copy it. Tell the user the returned svg_path and that they can open it in a browser.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Full plasmid sequence (IUPAC).'),
      name: { type: 'string', description: 'Plasmid name shown in the map center (default "plasmid").' },
      circular: { type: 'boolean', description: 'Circular map (default true); false renders a linear track.' },
      features: { type: 'array', items: FEATURE_IN_SCHEMA, description: 'Features to draw with 1-based spans.' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction enzymes to mark (names from the built-in table).' },
      gc_skew: { type: 'boolean', description: 'Draw the GC skew ring (default false).' },
      show_unique_cutters: { type: 'boolean', description: 'Mark enzymes that cut this sequence exactly once (green labels, default false).' },
      output_path: { type: 'string', description: 'Optional SVG file path; default: <name>.svg in the session workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['svg_path', 'name', 'length', 'circular', 'feature_count', 'enzyme_count'],
    properties: {
      svg_path: { type: 'string' },
      name: { type: 'string' },
      length: { type: 'integer' },
      circular: { type: 'boolean' },
      feature_count: { type: 'integer' },
      enzyme_count: { type: 'integer' },
    },
  },
  render(value) {
    const enzymeNote = value.enzyme_count > 0
      ? `${value.enzyme_count} restriction enzyme cut site(s) marked.`
      : 'no restriction enzymes requested; pass `enzymes` to mark cut sites.';
    return `SVG plasmid map saved to ${value.svg_path} (${value.name}, ${value.length} bp, ${value.circular ? 'circular' : 'linear'}, ${value.feature_count} feature(s)). ${enzymeNote} Tell the user to open the file in a browser.`;
  },
  async execute(args, exec) {
    const sequence = normalizeSequence(args.sequence, 'plasmid sequence');
    const features = (args.features ?? []).map((feature) => {
      if (!Number.isInteger(feature.start) || !Number.isInteger(feature.end) || feature.start < 1 || feature.end > sequence.length || feature.start > feature.end) {
        throw new MolbioInputError(`feature ${JSON.stringify(feature.label)} has invalid span ${feature.start}-${feature.end} (sequence length ${sequence.length})`);
      }
      return {
        label: feature.label,
        type: feature.type,
        start: feature.start,
        end: feature.end,
        strand: feature.strand ?? 1,
      };
    });
    const enzymes = [];
    if (args.enzymes !== undefined) {
      const enzymeNames = args.enzymes.length === 1 && args.enzymes[0] === 'common' ? ENZYME_NAMES : args.enzymes;
      for (const result of digest(sequence, enzymeNames, args.circular !== false)) {
        enzymes.push({ name: result.name, cut_offsets: result.cut_positions });
      }
    }
    const circular = args.circular !== false;
    const marks = [];
    if (args.show_unique_cutters === true) {
      for (const entry of uniqueCutters(sequence, '', undefined, circular).ideal.slice(0, 20)) {
        marks.push({ label: entry.name, positions: [entry.cut_position - 1], color: '#1f883d' });
      }
    }
    const name = args.name ?? 'plasmid';
    const svg = renderPlasmidMap({
      name,
      length: sequence.length,
      circular,
      features,
      enzymes,
      marks,
      sequence,
      gc_skew: args.gc_skew === true,
    });
    const file = await writeSvgFile(ctx, exec, args, svg, name);
    return {
      svg_path: file,
      name,
      length: sequence.length,
      circular,
      feature_count: features.length,
      enzyme_count: enzymes.reduce((sum, enzyme) => sum + enzyme.cut_offsets.length, 0),
    };
  },
});

// ── SnapGene .dna files ─────────────────────────────────────────────────────

const MAX_DNA_BYTES = 50 * 1024 * 1024;

function fsService(ctx) {
  const fs = ctx.get('fs');
  if (fs === undefined) throw new MolbioInputError('the filesystem service is not available in this composition; reading .dna/.gb files needs ctx.fs');
  return fs;
}

async function readFileBytes(ctx, exec, path) {
  const fs = fsService(ctx);
  const target = await fs.resolve(path);
  return await fs.readBytes(target, exec?.signal, MAX_DNA_BYTES);
}

const parseSnapgeneTool = (ctx) => define({
  name: 'molbio_parse_snapgene',
  description: 'Parse a SnapGene .dna file (binary) into structured data: map label, length, topology (circular/linear), annotated features (type, 1-based span, strand from SnapGene directionality, label), the full sequence, optional description/accession and any saved primers. Feed the returned features to molbio_plasmid_map to draw the map, or use molbio_plasmid_map_file to read a file and draw it in one call.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: requiredString('Path to the .dna file on disk.'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'length', 'topology', 'features', 'sequence'],
    properties: {
      name: { type: 'string' },
      length: { type: 'integer' },
      topology: { type: 'string', enum: ['circular', 'linear'] },
      description: { type: 'string' },
      accession: { type: 'string' },
      features: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'start', 'end', 'strand', 'label'],
          properties: {
            type: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            strand: { type: 'integer', enum: [1, -1] },
            label: { type: 'string' },
            gene: { type: 'string' },
            product: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      sequence: { type: 'string' },
      primers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string' },
            location: { type: 'string' },
            bound_strand: { type: 'string' },
            sequence: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `${value.name}${value.accession !== undefined ? ' (' + value.accession + ')' : ''}: ${value.length} bp, ${value.topology}`,
      ...value.description !== undefined ? [value.description] : [],
      `${value.features.length} feature(s):`,
    ];
    for (const feature of value.features) {
      lines.push(`  ${feature.type} ${feature.start}-${feature.end} (${feature.strand === -1 ? 'reverse' : 'forward'}): ${feature.label}`);
    }
    if (value.primers !== undefined && value.primers.length > 0) {
      lines.push(`${value.primers.length} saved primer(s):`);
      for (const primer of value.primers) lines.push(`  ${primer.name}${primer.sequence !== undefined ? ': ' + primer.sequence : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const bytes = await readFileBytes(ctx, exec, args.path);
    return parseSnapGeneBytes(bytes);
  },
});

const plasmidMapFileTool = (ctx) => define({
  safe: false,
  name: 'molbio_plasmid_map_file',
  description: 'Read a plasmid file (.dna SnapGene, or .gb/.gbk GenBank) from disk and render its map, WRITING it as a standalone SVG file in the session workspace in one call. Features come from the file\'s annotations; optionally mark restriction enzyme cut sites. The tool writes the file itself — the SVG text never reaches the conversation, so do not try to re-render or copy it. Tell the user the returned svg_path and that they can open it in a browser.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: requiredString('Path to the .dna / .gb / .gbk file on disk.'),
      name: { type: 'string', description: 'Override the map title (default: the file\'s own name).' },
      circular: { type: 'boolean', description: 'Override topology: true = circular map, false = linear (default: the file\'s topology).' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction enzymes to mark (names from the built-in table).' },
      gc_skew: { type: 'boolean', description: 'Draw the GC skew ring (default false).' },
      show_unique_cutters: { type: 'boolean', description: 'Mark enzymes that cut this plasmid exactly once (green labels, default false).' },
      output_path: { type: 'string', description: 'Optional SVG file path; default: <name>.svg in the session workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['svg_path', 'name', 'length', 'circular', 'feature_count', 'enzyme_count'],
    properties: {
      svg_path: { type: 'string' },
      name: { type: 'string' },
      length: { type: 'integer' },
      circular: { type: 'boolean' },
      feature_count: { type: 'integer' },
      enzyme_count: { type: 'integer' },
    },
  },
  render(value) {
    return `SVG plasmid map saved to ${value.svg_path} (${value.name}, ${value.length} bp, ${value.circular ? 'circular' : 'linear'}, ${value.feature_count} feature(s), ${value.enzyme_count} enzyme cut mark(s)). Tell the user to open the file in a browser.`;
  },
  async execute(args, exec) {
    const lower = args.path.toLowerCase();
    const isDna = lower.endsWith('.dna');
    const isGenbank = lower.endsWith('.gb') || lower.endsWith('.gbk') || lower.endsWith('.genbank');
    if (!isDna && !isGenbank) {
      throw new MolbioInputError('unsupported file type; expected a .dna (SnapGene) or .gb/.gbk (GenBank) file');
    }
    const bytes = await readFileBytes(ctx, exec, args.path);
    const parsed = isDna
      ? parseSnapGeneBytes(bytes)
      : parseGenBank(new TextDecoder().decode(bytes));
    if (parsed.sequence === '') throw new MolbioInputError('the file contains no sequence');
    const circular = args.circular ?? parsed.topology !== 'linear';
    const enzymes = [];
    if (args.enzymes !== undefined) {
      const enzymeNames = args.enzymes.length === 1 && args.enzymes[0] === 'common' ? ENZYME_NAMES : args.enzymes;
      for (const result of digest(parsed.sequence, enzymeNames, circular)) {
        enzymes.push({ name: result.name, cut_offsets: result.cut_positions });
      }
    }
    const name = args.name ?? parsed.name;
    const marks = [];
    if (args.show_unique_cutters === true) {
      for (const entry of uniqueCutters(parsed.sequence, '', undefined, circular).ideal.slice(0, 20)) {
        marks.push({ label: entry.name, positions: [entry.cut_position - 1], color: '#1f883d' });
      }
    }
    const svg = renderPlasmidMap({
      name,
      length: parsed.length,
      circular,
      features: parsed.features,
      enzymes,
      marks,
      sequence: parsed.sequence,
      gc_skew: args.gc_skew === true,
    });
    const file = await writeSvgFile(ctx, exec, args, svg, name);
    return {
      svg_path: file,
      name,
      length: parsed.length,
      circular,
      feature_count: parsed.features.length,
      enzyme_count: enzymes.reduce((sum, enzyme) => sum + enzyme.cut_offsets.length, 0),
    };
  },
});

// ── cross-intron primer design ──────────────────────────────────────────────

const INTRON_MISMATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'template_base', 'primer_base', 'spliced_position', 'genomic_position', 'distance_from_3prime'],
  properties: {
    position: { type: 'integer', description: '1-based position of the mismatch in the primer (5\'→3\').' },
    template_base: { type: 'string', description: 'The base a perfectly matching primer would carry at this position on the spliced transcript.' },
    primer_base: { type: 'string', description: 'The base the reported primer actually carries (primer_base !== template_base marks a real mismatch).' },
    spliced_position: { type: 'integer', description: '1-based position on the spliced transcript.' },
    genomic_position: { type: 'integer', description: '1-based position on the genomic sequence.' },
    distance_from_3prime: { type: 'integer', description: 'Number of bases between this mismatch and the primer 3\' end (0 = terminal base).' },
  },
};

const INTRON_PRIMER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'length', 'tm', 'gc_percent', 'spliced_start', 'spliced_end', 'genomic_start', 'genomic_end'],
  properties: {
    sequence: { type: 'string' },
    length: { type: 'integer' },
    tm: { type: 'number' },
    gc_percent: { type: 'number' },
    spliced_start: { type: 'integer' },
    spliced_end: { type: 'integer' },
    genomic_start: { type: 'integer' },
    genomic_end: { type: 'integer' },
    exons: { type: 'array', items: { type: 'string' } },
    exon: { type: 'integer' },
    junction_left: { type: 'integer' },
    junction_right: { type: 'integer' },
    mismatch_count: { type: 'integer', description: 'Number of primer-template mismatches this primer carries (0 = exact match; v12).' },
    mismatches: { type: 'array', items: INTRON_MISMATCH_SCHEMA },
  },
};

const intronPrimersTool = (ctx) => define({
  name: 'molbio_design_intron_primers',
  description: 'Design qPCR primer pairs where the forward primer spans an exon-exon junction (>= min_junction_bases on each side) so genomic DNA cannot be amplified, and the reverse primer sits in a different exon. Provide the genomic sequence and the exon spans (1-based, inclusive). min_genomic_span enforces a minimal genomic distance between the primers (making gDNA amplification impossible or easily detectable). Coordinates come back both on the spliced transcript and on the genomic sequence. v12: pass max_mismatches > 0 to also allow mismatched primers (never on the 3\'-terminal base, avoided in the 3\'-terminal critical zone by default); each mismatch is reported per primer in `mismatches` with spliced and genomic positions.',
  parameters: {
    type: 'object',
    required: ['exons'],
    properties: {
      genomic: { type: 'string', description: 'Genomic sequence containing the exons (alternative to genomic_path).' },
      genomic_path: { type: 'string', description: 'Path to a .fa/.fasta/.txt genomic sequence file (alternative to genomic).' },
      exons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end'],
          properties: {
            start: { type: 'integer', description: '1-based exon start on the genomic sequence.' },
            end: { type: 'integer', description: '1-based inclusive exon end.' },
          },
        },
        description: 'Exon spans, in genomic order.',
      },
      amplicon_min: { type: 'integer', description: 'Minimum spliced amplicon length (default 80).' },
      amplicon_max: { type: 'integer', description: 'Maximum spliced amplicon length (default 200).' },
      primer_len_min: { type: 'integer', description: 'Minimum primer length (default 18).' },
      primer_len_max: { type: 'integer', description: 'Maximum primer length (default 28).' },
      tm_min: { type: 'number', description: 'Minimum primer Tm (default 55).' },
      tm_max: { type: 'number', description: 'Maximum primer Tm (default 65).' },
      gc_min: { type: 'number', description: 'Minimum primer GC% (default 40).' },
      gc_max: { type: 'number', description: 'Maximum primer GC% (default 60).' },
      min_junction_bases: { type: 'integer', description: 'Bases required on each side of the junction (default 6).' },
      min_genomic_span: { type: 'integer', description: 'Minimum genomic distance between the primers (default 0).' },
      require_gc_clamp: { type: 'boolean', description: 'Require a G/C at the primer 3\' end (default true).' },
      max_run: { type: 'integer', description: 'Maximum allowed run of identical bases (default 3).' },
      max_self_score: { type: 'integer', description: 'Maximum self-complementarity score (default 8).' },
      max_self_consecutive: { type: 'integer', description: 'Maximum consecutive self-complementary pairs (default 4).' },
      max_hairpin_score: { type: 'integer', description: 'Maximum hairpin score (default 10).' },
      max_dimer_score: { type: 'integer', description: 'Maximum primer-pair dimer score (default 12).' },
      max_tm_delta: { type: 'number', description: 'Maximum |Tm(forward) - Tm(reverse)| in °C (default 3).' },
      max_mismatches: { type: 'integer', description: 'Maximum primer-template mismatches the designer may introduce (0-5, default 0 = exact match required). Never placed on the 3\'-terminal base.' },
      max_3prime_mismatches: { type: 'integer', description: 'Maximum mismatches tolerated inside the 3\'-terminal critical zone (mismatch_3prime_zone bases before the terminal base); default 0 (none).' },
      mismatch_3prime_zone: { type: 'integer', description: 'Length of the 3\'-terminal critical zone in bases (1-10, default 5); mismatches inside it require max_3prime_mismatches > 0.' },
      max_results: { type: 'integer', description: 'Maximum pairs to return (default 5).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['spliced_length', 'genomic_length', 'exons', 'pairs'],
    properties: {
      spliced_length: { type: 'integer' },
      genomic_length: { type: 'integer' },
      exons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end'],
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
          },
        },
      },
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'spliced_amplicon', 'genomic_amplicon_length', 'penalty'],
          properties: {
            forward: INTRON_PRIMER_SCHEMA,
            reverse: INTRON_PRIMER_SCHEMA,
            spliced_amplicon: {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end', 'length'],
              properties: {
                start: { type: 'integer' },
                end: { type: 'integer' },
                length: { type: 'integer' },
              },
            },
            genomic_amplicon_length: { type: 'integer' },
            penalty: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    if (value.pairs.length === 0) {
      return 'no primer pair satisfied the constraints — relax Tm/GC/amplicon windows or reduce min_junction_bases/min_genomic_span and retry.';
    }
    const lines = [`${value.pairs.length} candidate pair(s); the forward primer spans an exon-exon junction (genomic DNA will not amplify):`];
    const mismatchLine = (label, primer) => {
      if (primer.mismatch_count > 0) {
        const details = primer.mismatches
          .map((m) => `5'-pos ${m.position} ${m.template_base}→${m.primer_base} (spliced bp ${m.spliced_position}, genomic bp ${m.genomic_position}, ${m.distance_from_3prime} bp from 3')`)
          .join('; ');
        lines.push(`  ${label} carries ${primer.mismatch_count} mismatch(es) vs transcript: ${details}`);
      }
    };
    for (const [index, pair] of value.pairs.entries()) {
      lines.push(`#${index + 1} spliced amplicon ${pair.spliced_amplicon.start}-${pair.spliced_amplicon.end} (${pair.spliced_amplicon.length} bp), genomic span ${pair.genomic_amplicon_length} bp, penalty ${pair.penalty}`);
      lines.push(`  F ${pair.forward.sequence}  (spliced ${pair.forward.spliced_start}-${pair.forward.spliced_end}; genomic ${pair.forward.genomic_start}-${pair.forward.genomic_end}; exons ${pair.forward.exons.join('/')}, junction ${pair.forward.junction_left}+${pair.forward.junction_right} bp; Tm ${pair.forward.tm} °C)`);
      lines.push(`  R ${pair.reverse.sequence}  (spliced ${pair.reverse.spliced_start}-${pair.reverse.spliced_end}; genomic ${pair.reverse.genomic_start}-${pair.reverse.genomic_end}; exon ${pair.reverse.exon}; Tm ${pair.reverse.tm} °C)`);
      mismatchLine('F', pair.forward);
      mismatchLine('R', pair.reverse);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    let genomic;
    if (args.genomic !== undefined && args.genomic !== '') {
      genomic = normalizeSequence(args.genomic, 'genomic');
    } else if (args.genomic_path !== undefined && args.genomic_path !== '') {
      const bytes = await readFileBytes(ctx, exec, args.genomic_path);
      const text = new TextDecoder().decode(bytes);
      genomic = normalizeSequence(text.replace(/^>.*$/gm, ''), 'genomic');
    } else {
      throw new MolbioInputError('provide either `genomic` (a sequence) or `genomic_path` (a .fa/.fasta/.txt file)');
    }
    const exons = args.exons.map((exon) => ({ start: exon.start, end: exon.end }));
    const { pairs } = designIntronPrimers(genomic, exons, {
      ampliconMin: args.amplicon_min,
      ampliconMax: args.amplicon_max,
      lenMin: args.primer_len_min,
      lenMax: args.primer_len_max,
      tmMin: args.tm_min,
      tmMax: args.tm_max,
      gcMin: args.gc_min,
      gcMax: args.gc_max,
      minJunctionBases: args.min_junction_bases,
      minGenomicSpan: args.min_genomic_span,
      requireGcClamp: args.require_gc_clamp,
      maxRun: args.max_run,
      maxSelfScore: args.max_self_score,
      maxSelfConsecutive: args.max_self_consecutive,
      maxHairpinScore: args.max_hairpin_score,
      maxDimerScore: args.max_dimer_score,
      maxTmDelta: args.max_tm_delta,
      maxMismatches: args.max_mismatches,
      max3PrimeMismatches: args.max_3prime_mismatches,
      mismatch3PrimeZone: args.mismatch_3prime_zone,
      maxResults: args.max_results,
    });
    return {
      spliced_length: exons.reduce((sum, exon) => sum + (exon.end - exon.start + 1), 0),
      genomic_length: genomic.length,
      exons,
      pairs,
    };
  },
});

// ── cloning (batch 1) ───────────────────────────────────────────────────────

const CLONE_FEATURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'start', 'end', 'strand', 'label'],
  properties: {
    type: { type: 'string' },
    start: { type: 'integer' },
    end: { type: 'integer' },
    strand: { type: 'integer', enum: [1, -1] },
    label: { type: 'string' },
    gene: { type: 'string' },
    product: { type: 'string' },
    note: { type: 'string' },
    spans_insertion: { type: 'boolean' },
  },
};

/** Resolve a vector from either a raw sequence or a .dna/.gb file. */
async function resolveVector(ctx, exec, args, pathKey = 'vector_path') {
  if (args.vector !== undefined && args.vector !== null && args.vector !== '') {
    const sequence = normalizeSequence(args.vector, 'vector');
    return { sequence, features: [], name: 'vector', circular: true };
  }
  const path = args[pathKey];
  if (path === undefined || path === '') throw new MolbioInputError('provide either `vector` (a sequence) or `vector_path` (a .dna/.gb file)');
  const bytes = await readFileBytes(ctx, exec, path);
  const lower = path.toLowerCase();
  if (lower.endsWith('.dna')) {
    const parsed = parseSnapGeneBytes(bytes);
    return { sequence: parsed.sequence, features: parsed.features, name: parsed.name, circular: parsed.topology !== 'linear' };
  }
  if (lower.endsWith('.gb') || lower.endsWith('.gbk') || lower.endsWith('.genbank')) {
    const parsed = parseGenBank(new TextDecoder().decode(bytes));
    return { sequence: parsed.sequence, features: parsed.features, name: parsed.name, circular: parsed.topology !== 'linear' };
  }
  if (lower.endsWith('.fa') || lower.endsWith('.fasta') || lower.endsWith('.txt')) {
    const text = new TextDecoder().decode(bytes);
    const sequence = normalizeSequence(text.replace(/^>.*$/gm, ''), 'reference');
    return { sequence, features: [], name: 'reference', circular: true };
  }
  throw new MolbioInputError('unsupported vector file type; expected .dna / .gb / .gbk / .fa');
}

const uniqueCuttersTool = (ctx) => define({
  name: 'molbio_unique_cutters',
  description: 'Pick restriction enzymes for cloning: list enzymes that cut the vector exactly once (optionally inside a region such as the MCS) and NEVER cut the insert, plus enzymes that cut a vector region twice (fragment excision). Give the vector as a sequence or a .dna/.gb file path.',
  parameters: {
    type: 'object',
    properties: {
      vector: { type: 'string', description: 'Vector sequence (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Path to a .dna/.gb vector file (alternative to vector).' },
      insert: { type: 'string', description: 'Insert sequence; enzymes cutting it are excluded.' },
      region_start: { type: 'integer', description: '1-based start of the region (e.g. MCS) to prefer cuts in.' },
      region_end: { type: 'integer', description: '1-based end of the region.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['vector_length', 'insert_length', 'circular', 'ideal', 'region_double', 'insert_cutters', 'multi_cutters'],
    properties: {
      vector_length: { type: 'integer' },
      insert_length: { type: 'integer' },
      circular: { type: 'boolean' },
      ideal: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'site', 'cut_position', 'in_region'],
          properties: {
            name: { type: 'string' },
            site: { type: 'string' },
            cut_position: { type: 'integer' },
            in_region: { type: 'boolean' },
          },
        },
      },
      region_double: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'site', 'cut_positions', 'excised_fragment', 'backbone_fragment'],
          properties: {
            name: { type: 'string' },
            site: { type: 'string' },
            cut_positions: { type: 'array', items: { type: 'integer' } },
            excised_fragment: { type: 'integer' },
            backbone_fragment: { type: 'integer' },
          },
        },
      },
      insert_cutters: { type: 'array', items: { type: 'string' } },
      multi_cutters: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const inRegion = value.ideal.filter((entry) => entry.in_region);
    const outside = value.ideal.filter((entry) => !entry.in_region);
    const lines = [`vector ${value.vector_length} bp (${value.circular ? 'circular' : 'linear'}), insert ${value.insert_length} bp.`];
    lines.push(`ideal single cutters (cut vector once, never cut insert): ${value.ideal.length}`);
    for (const entry of [...inRegion, ...outside]) lines.push(`  ${entry.name} (${entry.site}) at ${entry.cut_position}${entry.in_region ? ' [in region]' : ''}`);
    if (value.region_double.length > 0) {
      lines.push('region double cutters (excise a fragment from the region):');
      for (const entry of value.region_double) lines.push(`  ${entry.name} at ${entry.cut_positions.join('/')}: fragment ${entry.excised_fragment} bp, backbone ${entry.backbone_fragment} bp`);
    }
    if (value.insert_cutters.length > 0) lines.push(`${value.insert_cutters.length} enzyme(s) also cut the insert and were excluded: ${value.insert_cutters.join(', ')}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args);
    const insert = args.insert !== undefined && args.insert !== '' ? normalizeSequence(args.insert, 'insert') : '';
    const region = args.region_start !== undefined && args.region_end !== undefined
      ? { start: args.region_start, end: args.region_end }
      : undefined;
    const result = uniqueCutters(vector.sequence, insert, region, vector.circular);
    return {
      vector_length: vector.sequence.length,
      insert_length: insert.length,
      circular: vector.circular,
      ideal: result.ideal,
      region_double: result.region_double,
      insert_cutters: result.summary.insert_cutters,
      multi_cutters: result.summary.multi_cutters,
    };
  },
});

const cloneSimulateTool = (ctx) => define({
  safe: (args) => args.save_path === undefined && args.map_path === undefined,
  name: 'molbio_clone_simulate',
  description: 'Simulate a cloning reaction in silico and return the final plasmid sequence with its remapped features. method=restriction: the tool itself checks that each enzyme cuts the vector exactly once (do not pre-verify by thinking), digests the insert with the same enzymes, ligates, remaps feature coordinates, and predicts verification digests; add_flanks: true lets the tool add the enzyme sites to a bare insert; orientation=auto (default) reverse-complements an inverted insert automatically. method=gibson: replace the vector region (region_start..region_end) with the insert and report the insert-to-order with homology arms. Save the final plasmid with save_path (FASTA) and/or draw the new plasmid map directly with map_path (SVG).',
  parameters: {
    type: 'object',
    required: ['insert'],
    properties: {
      vector: { type: 'string', description: 'Vector sequence (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Path to a .dna/.gb vector file (alternative to vector).' },
      insert: requiredString('Insert sequence (with enzyme sites on the flanks for restriction mode).'),
      method: { type: 'string', enum: ['restriction', 'gibson'], description: 'Cloning method; default "restriction".' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction enzymes (1 or 2); required for method=restriction. The tool itself checks that each enzyme cuts the vector exactly once — no need to pre-verify.' },
      add_flanks: { type: 'boolean', description: 'Restriction mode: pass the BARE insert and let the tool add the enzyme recognition sites to its flanks (upstream enzyme 5\', downstream enzyme 3\'). Default false.' },
      orientation: { type: 'string', enum: ['auto', 'forward', 'reverse'], description: 'Insert orientation for restriction mode: auto (default) reverse-complements the insert if its enzyme sites are in the opposite order to the vector; forward forces the insert as written; reverse forces the reverse complement.' },
      region_start: { type: 'integer', description: '1-based start of the vector region being replaced; required for method=gibson.' },
      region_end: { type: 'integer', description: '1-based end of the replaced region; required for method=gibson.' },
      overhang: { type: 'integer', description: 'Gibson homology arm length in bp (default 20).' },
      verify_enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzymes for the verification digest (default: automatically chosen diagnostic enzymes).' },
      save_path: { type: 'string', description: 'Optional path to save the final plasmid as FASTA in the workspace.' },
      map_path: { type: 'string', description: 'Optional path to also draw the new plasmid map (SVG) with the remapped features and the top verification enzymes marked.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'final_sequence', 'length', 'delta', 'junctions', 'features', 'dropped_features', 'verify', 'notes'],
    properties: {
      method: { type: 'string', enum: ['restriction', 'gibson'] },
      final_sequence: { type: 'string' },
      length: { type: 'integer' },
      delta: { type: 'integer' },
      insert_to_order: { type: 'string' },
      junctions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['position', 'sequence'],
          properties: {
            position: { type: 'integer' },
            sequence: { type: 'string' },
          },
        },
      },
      features: { type: 'array', items: CLONE_FEATURE_SCHEMA },
      dropped_features: { type: 'array', items: CLONE_FEATURE_SCHEMA },
      verify: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'final_fragments', 'vector_fragments'],
          properties: {
            name: { type: 'string' },
            final_fragments: { type: 'array', items: { type: 'integer' } },
            vector_fragments: { type: 'array', items: { type: 'integer' } },
            reverse_orientation_fragments: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      save_path: { type: 'string' },
      map_path: { type: 'string' },
      insert_reverse_complemented: { type: 'boolean' },
      insert_with_flanks: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `${value.method} clone simulated: final plasmid ${value.length} bp (Δ ${value.delta > 0 ? '+' : ''}${value.delta} bp).`,
      `${value.features.length} feature(s) after coordinate remapping; ${value.dropped_features.length} dropped inside the replaced region.`,
    ];
    if (value.insert_reverse_complemented === true) lines.push('the insert was reverse-complemented to match the vector orientation.');
    if (value.insert_with_flanks !== undefined) lines.push(`insert with enzyme flanks added by the tool: ${value.insert_with_flanks}`);
    if (value.insert_to_order !== undefined) lines.push(`insert to order (with homology arms, ${value.insert_to_order.length} bp): ${value.insert_to_order}`);
    for (const junction of value.junctions) lines.push(`junction @${junction.position}: …${junction.sequence}…`);
    lines.push('verification digests (final vs original vector):');
    for (const entry of value.verify.slice(0, 5)) {
      lines.push(`  ${entry.name}: final ${entry.final_fragments.join('+')} bp vs vector ${entry.vector_fragments.join('+')} bp${entry.reverse_orientation_fragments !== undefined ? `; reverse orientation ${entry.reverse_orientation_fragments.join('+')} bp` : ''}`);
    }
    for (const note of value.notes) lines.push(`note: ${note}`);
    if (value.save_path !== undefined) lines.push(`final plasmid saved to ${value.save_path}`);
    if (value.map_path !== undefined) lines.push(`plasmid map SVG written to ${value.map_path}`);
    lines.push('The remapped `features` and `final_sequence` in the output value are ready for molbio_plasmid_map — do not recompute coordinates by hand.');
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args);
    const insert = normalizeSequence(args.insert, 'insert');
    const method = args.method ?? 'restriction';
    if (method === 'restriction') {
      if (!Array.isArray(args.enzymes) || args.enzymes.length < 1 || args.enzymes.length > 2) {
        throw new MolbioInputError('method=restriction needs 1 or 2 enzymes');
      }
    } else if (method === 'gibson') {
      if (args.region_start === undefined || args.region_end === undefined) {
        throw new MolbioInputError('method=gibson needs region_start and region_end (the vector region being replaced)');
      }
    } else {
      throw new MolbioInputError('method must be "restriction" or "gibson"');
    }
    const result = simulateClone({
      vectorSeq: vector.sequence,
      vectorFeatures: vector.features,
      insert,
      method,
      enzymes: args.enzymes,
      orientation: args.orientation ?? 'auto',
      addFlanks: args.add_flanks === true,
      region: args.region_start !== undefined ? { start: args.region_start, end: args.region_end } : undefined,
      overhang: args.overhang ?? 20,
      circular: vector.circular,
      verifyEnzymes: args.verify_enzymes,
    });
    const out = {
      method: result.method,
      final_sequence: result.final_sequence,
      length: result.final_sequence.length,
      delta: result.delta,
      ...result.insert_to_order !== undefined ? { insert_to_order: result.insert_to_order } : {},
      ...result.insert_with_flanks !== undefined ? { insert_with_flanks: result.insert_with_flanks } : {},
      junctions: result.junctions,
      features: result.features,
      dropped_features: result.dropped_features,
      verify: result.verify,
      notes: result.notes,
      ...result.insert_reverse_complemented !== undefined ? { insert_reverse_complemented: result.insert_reverse_complemented } : {},
    };
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    if (args.save_path !== undefined && args.save_path !== '') {
      const file = workspaceFilePath(args.save_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, `>${vector.name}_clone ${method}\n${result.final_sequence}\n`, policy);
      out.save_path = file;
    }
    if (args.map_path !== undefined && args.map_path !== '') {
      const marks = result.verify.slice(0, 3).map((entry) => ({
        name: entry.name,
        cut_offsets: digest(result.final_sequence, [entry.name], vector.circular)[0].cut_positions,
      }));
      const svg = renderPlasmidMap({
        name: `${vector.name}_clone`,
        length: result.final_sequence.length,
        circular: vector.circular,
        features: result.features,
        enzymes: marks,
      });
      const file = workspaceFilePath(args.map_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, svg, policy);
      out.map_path = file;
    }
    return out;
  },
});

const clonePrimersTool = (ctx) => define({
  name: 'molbio_clone_primers',
  description: 'Design primers that amplify a template with cloning tails. mode=restriction: adds 5\' protection bases and restriction site(s) (1 or 2 enzymes) to the primer ends and re-checks Tm/GC/dimers; warns when an enzyme also cuts inside the template. mode=gibson: adds the vector homology arms flanking the replaced region to the primer ends.',
  parameters: {
    type: 'object',
    required: ['template'],
    properties: {
      template: requiredString('The sequence to amplify (the insert, with any template context you want copied).'),
      mode: { type: 'string', enum: ['restriction', 'gibson'], description: 'Tail type; default "restriction".' },
      enzymes: { type: 'array', items: { type: 'string' }, description: 'Enzyme(s) for restriction mode (1 or 2).' },
      protect_bases: { type: 'boolean', description: 'Add recommended 5\' protection bases (default true).' },
      extra_bases: { type: 'integer', description: 'Extra C bases beyond the protection bases (default 0).' },
      binding_length: { type: 'integer', description: 'Template-binding length per primer (default 20 bp, 12-40).' },
      vector: { type: 'string', description: 'Vector sequence for gibson arms (alternative to vector_path).' },
      vector_path: { type: 'string', description: 'Vector file for gibson arms (alternative to vector).' },
      region_start: { type: 'integer', description: '1-based start of the vector region being replaced (gibson).' },
      region_end: { type: 'integer', description: '1-based end of the replaced region (gibson).' },
      overhang: { type: 'integer', description: 'Gibson homology arm length (default 20 bp).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'forward', 'reverse', 'forward_binding', 'reverse_binding', 'checks'],
    properties: {
      mode: { type: 'string', enum: ['restriction', 'gibson'] },
      forward: { type: 'string' },
      reverse: { type: 'string' },
      forward_binding: { type: 'string' },
      reverse_binding: { type: 'string' },
      checks: {
        type: 'object',
        additionalProperties: false,
        required: ['forward_tm', 'reverse_tm', 'binding_tm_forward', 'binding_tm_reverse', 'gc_forward', 'gc_reverse', 'dimer_score', 'forward_self_score', 'reverse_self_score', 'warnings'],
        properties: {
          forward_tm: { type: 'number' },
          reverse_tm: { type: 'number' },
          binding_tm_forward: { type: 'number' },
          binding_tm_reverse: { type: 'number' },
          gc_forward: { type: 'number' },
          gc_reverse: { type: 'number' },
          dimer_score: { type: 'integer' },
          forward_self_score: { type: 'integer' },
          reverse_self_score: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  render(value) {
    const c = value.checks;
    const lines = [
      `cloning primers (${value.mode}):`,
      `  forward: ${value.forward}  (binding ${value.forward_binding})`,
      `  reverse: ${value.reverse}  (binding ${value.reverse_binding})`,
      `Tm: forward ${c.forward_tm} °C / reverse ${c.reverse_tm} °C (binding parts: ${c.binding_tm_forward} / ${c.binding_tm_reverse} °C)`,
      `GC: ${c.gc_forward}% / ${c.gc_reverse}% · dimer score ${c.dimer_score} · self scores ${c.forward_self_score}/${c.reverse_self_score}`,
    ];
    for (const warning of c.warnings) lines.push(`WARNING: ${warning}`);
    lines.push('Tm values are SantaLucia-1998 NN estimates of the FULL primer; the tail does not anneal in the first cycles.');
    return lines.join('\n');
  },
  async execute(args, exec) {
    const mode = args.mode ?? 'restriction';
    let vectorSeq;
    if (mode === 'gibson') {
      const vector = await resolveVector(ctx, exec, args);
      vectorSeq = vector.sequence;
    }
    return designClonePrimers({
      template: args.template,
      mode,
      enzymes: args.enzymes,
      protectBases: args.protect_bases ?? true,
      extraBases: args.extra_bases ?? 0,
      bindingLength: args.binding_length ?? 20,
      vectorSeq,
      region: args.region_start !== undefined ? { start: args.region_start, end: args.region_end } : undefined,
      overhang: args.overhang ?? 20,
    });
  },
});

const mutagenesisTool = define({
  name: 'molbio_mutagenesis_primers',
  description: 'Design QuickChange-style site-directed mutagenesis primer pairs. Mutations are given as strings on the original template coordinates: substitutions "A123G" or "123A>G", deletions "123_125del", insertions "after123insGCT". The mutation is centered in the primers, which are checked for Tm (NN estimate), GC, G/C ends, runs and self-complementarity. The amino-acid change is reported assuming the template reads in frame 1.',
  parameters: {
    type: 'object',
    required: ['template', 'mutations'],
    properties: {
      template: requiredString('Template sequence to mutate.'),
      mutations: { type: 'array', items: { type: 'string' }, description: 'Mutation descriptions, e.g. ["A123G"], ["123_125del"], ["after123insGCT"].' },
      primer_len_min: { type: 'integer', description: 'Minimum primer length (default 25).' },
      primer_len_max: { type: 'integer', description: 'Maximum primer length (default 45).' },
      tm_min: { type: 'number', description: 'Minimum primer Tm °C (default 75).' },
      tm_max: { type: 'number', description: 'Maximum primer Tm °C (default 85).' },
      max_results: { type: 'integer', description: 'Maximum pairs to return (default 2).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mutated_sequence', 'mutation_span', 'amino_acid_change', 'pairs'],
    properties: {
      mutated_sequence: { type: 'string' },
      mutation_span: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'integer' },
          end: { type: 'integer' },
        },
      },
      amino_acid_change: {
        type: 'object',
        additionalProperties: false,
        required: ['before', 'after', 'silent'],
        properties: {
          before: { type: 'string' },
          after: { type: 'string' },
          silent: { type: 'boolean' },
        },
      },
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['forward', 'reverse', 'length', 'tm', 'gc_percent', 'start', 'penalty'],
          properties: {
            forward: { type: 'string' },
            reverse: { type: 'string' },
            length: { type: 'integer' },
            tm: { type: 'number' },
            gc_percent: { type: 'number' },
            start: { type: 'integer' },
            penalty: { type: 'number' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `mutation span ${value.mutation_span.start}-${value.mutation_span.end} on the mutated template (${value.mutated_sequence.length} bp).`,
      `amino-acid change (frame 1 assumption): ${value.amino_acid_change.before || '(none)'} → ${value.amino_acid_change.after || '(none)'}${value.amino_acid_change.silent ? ' (silent)' : ''}`,
    ];
    if (value.pairs.length === 0) {
      lines.push('no primer pair satisfied the constraints — widen the length/Tm ranges and retry.');
    } else {
      lines.push(`${value.pairs.length} candidate pair(s):`);
      for (const [index, pair] of value.pairs.entries()) {
        lines.push(`#${index + 1} (${pair.length} bp, starts at ${pair.start}, Tm ${pair.tm} °C, GC ${pair.gc_percent}%)`);
        lines.push(`  F ${pair.forward}`);
        lines.push(`  R ${pair.reverse}`);
      }
    }
    return lines.join('\n');
  },
  execute(args) {
    return designMutagenesisPrimers(args.template, args.mutations, {
      lenMin: args.primer_len_min,
      lenMax: args.primer_len_max,
      tmMin: args.tm_min,
      tmMax: args.tm_max,
      maxResults: args.max_results,
    });
  },
});

const verifySangerTool = (ctx) => define({
  name: 'molbio_verify_sanger',
  description: 'Verify a clone by Sanger sequencing: read a trace file (.ab1 with quality values, or .seq/.txt/.fasta plain text), align it against a reference (sequence or .dna/.gb plasmid file, circular-aware), and report mismatches, deletions, insertions, coverage, identity, and amino-acid consequences inside a CDS window. Low-quality (<20) positions are flagged and excluded from a "differences found" verdict.',
  parameters: {
    type: 'object',
    required: ['trace_path'],
    properties: {
      trace_path: requiredString('Path to the .ab1 / .seq / .txt / .fasta trace file.'),
      reference: { type: 'string', description: 'Reference sequence (alternative to reference_path).' },
      reference_path: { type: 'string', description: 'Reference as a .dna/.gb/.fa file (alternative to reference).' },
      cds_start: { type: 'integer', description: '1-based start of the CDS on the reference for amino-acid reporting.' },
      cds_end: { type: 'integer', description: '1-based end of the CDS.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'trace_length', 'reference_length', 'aligned_span', 'identity_percent', 'differences'],
    properties: {
      verdict: { type: 'string', enum: ['match', 'match_with_low_quality_positions', 'differences_found'] },
      trace_length: { type: 'integer' },
      reference_length: { type: 'integer' },
      aligned_span: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'integer' },
          end: { type: 'integer' },
        },
      },
      identity_percent: { type: 'number' },
      quality_mean: { type: 'number' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'ref_pos', 'ref_base', 'trace_base'],
          properties: {
            kind: { type: 'string', enum: ['mismatch', 'deletion', 'insertion'] },
            ref_pos: { type: 'integer' },
            ref_base: { type: 'string' },
            trace_base: { type: 'string' },
            trace_pos: { type: 'integer' },
            quality: { type: 'integer' },
          },
        },
      },
      aa_changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref_pos', 'kind'],
          properties: {
            ref_pos: { type: 'integer' },
            kind: { type: 'string', enum: ['silent', 'missense', 'stop_codon_change', 'frameshift'] },
            codon_before: { type: 'string' },
            codon_after: { type: 'string' },
            aa_before: { type: 'string' },
            aa_after: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [
      `verdict: ${value.verdict}`,
      `aligned ${value.aligned_span.start}-${value.aligned_span.end} of ${value.reference_length} bp reference; identity ${value.identity_percent}%`,
    ];
    if (value.quality_mean !== undefined) lines.push(`mean trace quality: ${value.quality_mean}`);
    const confident = value.differences.filter((d) => !(d.quality !== undefined && d.quality < 20));
    const low = value.differences.filter((d) => d.quality !== undefined && d.quality < 20);
    lines.push(`${confident.length} difference(s) at high confidence, ${low.length} at low quality:`);
    for (const d of [...confident, ...low].slice(0, 50)) {
      lines.push(`  ${d.kind} @ref ${d.ref_pos}: ${d.ref_base} → ${d.trace_base}${d.quality !== undefined ? ` (q${d.quality})` : ''}`);
    }
    if (value.aa_changes !== undefined && value.aa_changes.length > 0) {
      lines.push('amino-acid consequences in the CDS window:');
      for (const change of value.aa_changes) {
        if (change.kind === 'frameshift') lines.push(`  @${change.ref_pos}: frameshift (${change.note})`);
        else lines.push(`  @${change.ref_pos}: ${change.kind} ${change.aa_before}${change.aa_before === change.aa_after ? '' : '→' + change.aa_after} (${change.codon_before}→${change.codon_after})`);
      }
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const traceBytes = await readFileBytes(ctx, exec, args.trace_path);
    const trace = readTraceFromBytes(traceBytes, args.trace_path);
    let reference;
    let circular = true;
    if (args.reference !== undefined && args.reference !== '') {
      reference = normalizeSequence(args.reference, 'reference');
    } else if (args.reference_path !== undefined && args.reference_path !== '') {
      const vector = await resolveVector(ctx, exec, args, 'reference_path');
      reference = vector.sequence;
      circular = vector.circular;
    } else {
      throw new MolbioInputError('provide either `reference` (a sequence) or `reference_path` (a .dna/.gb/.fa file)');
    }
    return verifySanger({
      traceBases: trace.bases,
      traceQualities: trace.qualities,
      reference,
      circular,
      cdsStart: args.cds_start,
      cdsEnd: args.cds_end,
    });
  },
});

// ── protein and quantitative tools (batch 2) ────────────────────────────────

const proteinPropsTool = define({
  name: 'molbio_protein_props',
  description: 'Compute physicochemical properties of a protein sequence (one-letter codes): molecular weight (average residue masses + water), isoelectric point (Bjellqvist 1993 pK values), A280 extinction coefficients (reduced and with disulfides), A280(0.1%) absorbance, GRAVY hydropathy (Kyte-Doolittle) and the aliphatic index (Ikai 1980). All values are estimates.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence (one-letter amino acid codes).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['length', 'mw_da', 'pi', 'extinction_reduced_m1cm1', 'extinction_oxidized_m1cm1', 'absorbance_0_1_percent', 'gravy', 'aliphatic_index'],
    properties: {
      length: { type: 'integer' },
      mw_da: { type: 'number' },
      pi: { type: 'number' },
      extinction_reduced_m1cm1: { type: 'integer' },
      extinction_oxidized_m1cm1: { type: 'integer' },
      absorbance_0_1_percent: { type: 'number' },
      gravy: { type: 'number' },
      aliphatic_index: { type: 'number' },
    },
  },
  render(value) {
    return [
      `${value.length} aa · MW ${value.mw_da} Da · pI ${value.pi}`,
      `A280 extinction: ${value.extinction_reduced_m1cm1} M⁻¹cm⁻¹ (reduced), ${value.extinction_oxidized_m1cm1} M⁻¹cm⁻¹ (all Cys as disulfides); A280(0.1%) ≈ ${value.absorbance_0_1_percent}`,
      `GRAVY ${value.gravy} · aliphatic index ${value.aliphatic_index}`,
      'Estimates: Bjellqvist pK values, Kyte-Doolittle hydropathy, average residue masses.',
    ].join('\n');
  },
  execute(args) {
    return proteinProperties(args.sequence);
  },
});

const peptideDigestTool = define({
  name: 'molbio_peptide_digest',
  description: 'In silico protease digestion for mass spectrometry: trypsin, chymotrypsin, LysC or GluC cleavage rules (no cleavage before proline where applicable), optional missed cleavages (0-3), monoisotopic or average [M+H]+ peptide masses, and optional mass-range filtering.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence to digest.'),
      enzyme: { type: 'string', enum: ['trypsin', 'chymotrypsin', 'lysc', 'gluc'], description: 'Protease; default "trypsin".' },
      missed: { type: 'integer', description: 'Missed cleavages to include (0-3, default 0).' },
      mass_type: { type: 'string', enum: ['monoisotopic', 'average'], description: 'Mass type; default "monoisotopic".' },
      min_mass: { type: 'number', description: 'Optional minimum [M+H]+ mass filter (Da).' },
      max_mass: { type: 'number', description: 'Optional maximum [M+H]+ mass filter (Da).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['enzyme', 'missed_cleavages', 'mass_type', 'peptides'],
    properties: {
      enzyme: { type: 'string', enum: ['trypsin', 'chymotrypsin', 'lysc', 'gluc'] },
      missed_cleavages: { type: 'integer' },
      mass_type: { type: 'string', enum: ['monoisotopic', 'average'] },
      peptides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end', 'sequence', 'length', 'mh_mass', 'missed'],
          properties: {
            start: { type: 'integer' },
            end: { type: 'integer' },
            sequence: { type: 'string' },
            length: { type: 'integer' },
            mh_mass: { type: 'number' },
            missed: { type: 'integer' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [`${value.enzyme} digest, ${value.missed_cleavages} missed cleavage(s), ${value.mass_type} [M+H]+ masses: ${value.peptides.length} peptide(s)`];
    for (const peptide of value.peptides.slice(0, 80)) {
      lines.push(`  ${peptide.start}-${peptide.end} ${peptide.sequence}  [M+H]+ ${peptide.mh_mass}${peptide.missed > 0 ? ` (${peptide.missed} missed)` : ''}`);
    }
    if (value.peptides.length > 80) lines.push(`  … ${value.peptides.length - 80} more`);
    return lines.join('\n');
  },
  execute(args) {
    return peptideDigest(args.sequence, {
      enzyme: args.enzyme ?? 'trypsin',
      missed: args.missed ?? 0,
      massType: args.mass_type ?? 'monoisotopic',
      minMass: args.min_mass,
      maxMass: args.max_mass,
    });
  },
});

const codonOptimizeTool = define({
  name: 'molbio_codon_optimize',
  description: 'Codon-optimize a protein sequence for a host (E. coli, yeast, or human) using published high-frequency codon tables (heuristic). Optionally avoid introducing restriction sites (avoid_enzymes): synonymous swaps remove them where possible, deterministically.',
  parameters: {
    type: 'object',
    required: ['sequence'],
    properties: {
      sequence: requiredString('Protein sequence to back-translate (one-letter codes).'),
      host: { type: 'string', enum: CODON_HOSTS, description: 'Expression host; default "e_coli".' },
      avoid_enzymes: { type: 'array', items: { type: 'string' }, description: 'Restriction sites to avoid introducing (enzyme names from the built-in table).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['host', 'dna_sequence', 'length', 'gc_percent', 'avoided_sites_remaining', 'notes'],
    properties: {
      host: { type: 'string', enum: CODON_HOSTS },
      dna_sequence: { type: 'string' },
      length: { type: 'integer' },
      gc_percent: { type: 'number' },
      avoided_sites_remaining: { type: 'integer' },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  render(value) {
    const lines = [
      `${value.host} codon-optimized DNA: ${value.length} bp, GC ${value.gc_percent}%`,
      value.dna_sequence,
    ];
    for (const note of value.notes) lines.push(`note: ${note}`);
    if (value.avoided_sites_remaining > 0) lines.push(`WARNING: ${value.avoided_sites_remaining} avoided site(s) could not be removed by synonymous codons`);
    lines.push('Optimization uses published high-frequency codon tables — heuristic, not a guarantee of expression level.');
    return lines.join('\n');
  },
  execute(args) {
    return codonOptimize(args.sequence, {
      host: args.host ?? 'e_coli',
      avoidEnzymes: args.avoid_enzymes ?? [],
    });
  },
});

const qpcrEfficiencyTool = (ctx) => define({
  safe: (args) => args.plot_path === undefined || args.plot_path === '',
  name: 'molbio_qpcr_efficiency',
  description: 'Fit a qPCR standard curve from a dilution series: dilution_factors (e.g. [1, 10, 100, 1000]) with the matching ct_values. Fits Ct vs log10(relative quantity), reports slope, intercept, R², and amplification efficiency E = 10^(−1/slope) − 1. Pass plot_path to write the scatter + fit line as an SVG file in the workspace.',
  parameters: {
    type: 'object',
    required: ['dilution_factors', 'ct_values'],
    properties: {
      dilution_factors: { type: 'array', items: { type: 'number' }, description: 'Dilution factors, e.g. [1, 10, 100, 1000].' },
      ct_values: { type: 'array', items: { type: 'number' }, description: 'Ct values matching the dilution factors.' },
      plot_path: { type: 'string', description: 'Optional path to write the standard-curve SVG plot.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['n', 'slope', 'intercept', 'r_squared', 'efficiency', 'efficiency_percent', 'points'],
    properties: {
      n: { type: 'integer' },
      slope: { type: 'number' },
      intercept: { type: 'number' },
      r_squared: { type: 'number' },
      efficiency: { type: 'number' },
      efficiency_percent: { type: 'number' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
      },
      plot_path: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `standard curve from ${value.n} points: Ct = ${value.intercept} + ${value.slope}·log10(relative quantity)`,
      `R² = ${value.r_squared} · efficiency = ${value.efficiency_percent}%`,
    ];
    if (value.plot_path !== undefined) lines.push(`plot written to ${value.plot_path}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const factors = args.dilution_factors;
    const cts = args.ct_values;
    if (!Array.isArray(factors) || !Array.isArray(cts) || factors.length !== cts.length || factors.length < 3) {
      throw new MolbioInputError('dilution_factors and ct_values must be arrays of the same length (>= 3)');
    }
    const xs = factors.map((f) => {
      if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) throw new MolbioInputError('dilution_factors must be positive numbers');
      return Math.log10(1 / f);
    });
    for (const ct of cts) {
      if (typeof ct !== 'number' || !Number.isFinite(ct)) throw new MolbioInputError('ct_values must be finite numbers');
    }
    const fit = linearFit(xs, cts);
    const efficiency = Math.pow(10, -1 / fit.slope) - 1;
    const out = {
      n: factors.length,
      slope: Math.round(fit.slope * 10000) / 10000,
      intercept: Math.round(fit.intercept * 10000) / 10000,
      r_squared: Math.round(fit.r_squared * 10000) / 10000,
      efficiency: Math.round(efficiency * 10000) / 10000,
      efficiency_percent: Math.round(efficiency * 10000) / 100,
      points: xs.map((x, i) => ({ x: Math.round(x * 10000) / 10000, y: cts[i] })),
    };
    if (args.plot_path !== undefined && args.plot_path !== '') {
      const fs = fsService(ctx);
      const sandboxPolicyService = ctx.get('sandboxPolicy');
      const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
      const file = workspaceFilePath(args.plot_path, exec, policy?.workspaceRoot);
      const svg = renderScatterChart({
        title: 'qPCR standard curve',
        x_label: 'log10(relative quantity)',
        y_label: 'Ct',
        x: xs,
        y: cts,
        fit,
      });
      await writeWorkspaceFile(fs, file, svg, policy);
      out.plot_path = file;
    }
    return out;
  },
});

const plotTool = (ctx) => define({
  safe: false,
  name: 'molbio_plot',
  description: 'Draw a chart as a standalone SVG file in the workspace. kind=bar: labels/values with optional error bars (e.g. qPCR fold change mean ± SD). kind=scatter: x/y series, with fit=true adding a least-squares line. output_path is required — the SVG is written by the tool.',
  parameters: {
    type: 'object',
    required: ['kind', 'output_path'],
    properties: {
      kind: { type: 'string', enum: ['bar', 'scatter'], description: 'Chart type.' },
      output_path: requiredString('SVG file path in the workspace.'),
      title: { type: 'string' },
      x_label: { type: 'string' },
      y_label: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Bar labels.' },
      values: { type: 'array', items: { type: 'number' }, description: 'Bar values.' },
      errors: { type: 'array', items: { type: 'number' }, description: 'Optional error-bar half-widths (SD).' },
      x: { type: 'array', items: { type: 'number' }, description: 'Scatter x values.' },
      y: { type: 'array', items: { type: 'number' }, description: 'Scatter y values.' },
      fit: { type: 'boolean', description: 'Scatter: draw the least-squares line (default false).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['plot_path', 'kind', 'points'],
    properties: {
      plot_path: { type: 'string' },
      kind: { type: 'string', enum: ['bar', 'scatter'] },
      points: { type: 'integer' },
    },
  },
  render(value) {
    return `chart written to ${value.plot_path} (${value.kind}, ${value.points} points) — tell the user to open it in a browser.`;
  },
  async execute(args, exec) {
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
    let svg;
    let points;
    if (args.kind === 'bar') {
      if (!Array.isArray(args.labels) || !Array.isArray(args.values) || args.labels.length !== args.values.length) {
        throw new MolbioInputError('kind=bar needs labels and values arrays of the same length');
      }
      svg = renderBarChart({
        title: args.title,
        x_label: args.x_label,
        y_label: args.y_label,
        labels: args.labels,
        values: args.values,
        errors: args.errors,
      });
      points = args.values.length;
    } else if (args.kind === 'scatter') {
      if (!Array.isArray(args.x) || !Array.isArray(args.y) || args.x.length !== args.y.length) {
        throw new MolbioInputError('kind=scatter needs x and y arrays of the same length');
      }
      const fit = args.fit === true ? linearFit(args.x, args.y) : undefined;
      svg = renderScatterChart({
        title: args.title,
        x_label: args.x_label,
        y_label: args.y_label,
        x: args.x,
        y: args.y,
        fit,
      });
      points = args.x.length;
    } else {
      throw new MolbioInputError('kind must be "bar" or "scatter"');
    }
    await writeWorkspaceFile(fs, file, svg, policy);
    return { plot_path: file, kind: args.kind, points };
  },
});

// ── sequence analysis and records (batch 3) ────────────────────────────────

const alignTool = define({
  name: 'molbio_align',
  description: 'Locally align two sequences (Smith-Waterman). Returns the aligned strings, aligned spans (1-based), identity %, and a list of mismatches/gaps. Use it to compare two sequences, check a primer against a template, or verify an edited region.',
  parameters: {
    type: 'object',
    required: ['sequence1', 'sequence2'],
    properties: {
      sequence1: requiredString('First sequence (typically the query/read).'),
      sequence2: requiredString('Second sequence (typically the reference).'),
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['a_aligned', 'b_aligned', 'a_start', 'b_start', 'a_end', 'b_end', 'score', 'identity_percent', 'aligned_columns', 'differences'],
    properties: {
      a_aligned: { type: 'string' },
      b_aligned: { type: 'string' },
      a_start: { type: 'integer' },
      b_start: { type: 'integer' },
      a_end: { type: 'integer' },
      b_end: { type: 'integer' },
      score: { type: 'integer' },
      identity_percent: { type: 'number' },
      aligned_columns: { type: 'integer' },
      differences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'pos1', 'pos2', 'base1', 'base2'],
          properties: {
            kind: { type: 'string', enum: ['mismatch', 'deletion', 'insertion'] },
            pos1: { type: 'integer' },
            pos2: { type: 'integer' },
            base1: { type: 'string' },
            base2: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const show = (s) => (s.length > 240 ? s.slice(0, 120) + ` …[${s.length - 240} bp]… ` + s.slice(-120) : s);
    let matchLine = '';
    const a = value.a_aligned;
    const b = value.b_aligned;
    for (let i = 0; i < a.length; i++) matchLine += a[i] === b[i] ? '|' : ' ';
    const lines = [
      `identity ${value.identity_percent}% over ${value.aligned_columns} aligned columns; sequence1 ${value.a_start + 1}-${value.a_end}, sequence2 ${value.b_start + 1}-${value.b_end}`,
      `seq1 ${show(a)}`,
      `     ${show(matchLine)}`,
      `seq2 ${show(b)}`,
    ];
    const confident = value.differences.slice(0, 60);
    if (confident.length > 0) {
      lines.push(`${value.differences.length} difference(s):`);
      for (const d of confident) lines.push(`  ${d.kind} @seq1 ${d.pos1} / seq2 ${d.pos2}: ${d.base1} vs ${d.base2}`);
    }
    return lines.join('\n');
  },
  execute(args) {
    const a = normalizeSequence(args.sequence1, 'sequence1');
    const b = normalizeSequence(args.sequence2, 'sequence2');
    const result = smithWaterman(a, b);
    const differences = result.differences.map((d) => ({
      kind: d.kind,
      pos1: d.trace_pos ?? (d.kind === 'deletion' ? d.trace_pos + 1 : d.trace_pos),
      pos2: d.ref_pos,
      base1: d.trace_base,
      base2: d.ref_base,
    }));
    return {
      a_aligned: result.a_aligned,
      b_aligned: result.b_aligned,
      a_start: result.a_start,
      b_start: result.b_start,
      a_end: result.a_end,
      b_end: result.b_end,
      score: result.score,
      identity_percent: result.identity_percent,
      aligned_columns: result.aligned_columns,
      differences,
    };
  },
});

const fastaFastqTool = (ctx) => define({
  safe: (args) => args.action !== 'convert' && args.action !== 'extract',
  name: 'molbio_fasta_fastq',
  description: 'Work with FASTA/FASTQ files in the workspace. action=stats: per-entry and overall statistics (length/GC). action=extract: pull entries by id (exact or substring) and optionally write them to a FASTA file. action=convert: FASTQ → FASTA (output_path required). action=qc: FASTQ quality statistics (mean/min/max Phred, low-quality fraction, per-position means).',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: requiredString('Path to the .fasta/.fa/.fastq/.fq file.'),
      action: { type: 'string', enum: ['stats', 'extract', 'convert', 'qc'], description: 'What to do; default "stats".' },
      id: { type: 'string', description: 'Entry id (exact or substring) for action=extract.' },
      output_path: { type: 'string', description: 'FASTA output file for extract/convert.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'format', 'entries', 'stats', 'saved_to'],
    properties: {
      action: { type: 'string', enum: ['stats', 'extract', 'convert', 'qc'] },
      format: { type: 'string', enum: ['fasta', 'fastq'] },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'length', 'gc_percent'],
          properties: {
            id: { type: 'string' },
            length: { type: 'integer' },
            gc_percent: { type: 'number' },
            sequence: { type: 'string' },
          },
        },
      },
      stats: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'total_bases', 'min_length', 'max_length', 'mean_length', 'gc_percent'],
        properties: {
          entries: { type: 'integer' },
          total_bases: { type: 'integer' },
          min_length: { type: 'integer' },
          max_length: { type: 'integer' },
          mean_length: { type: 'number' },
          gc_percent: { type: 'number' },
          quality_mean: { type: 'number' },
          quality_min: { type: 'integer' },
          quality_max: { type: 'integer' },
          low_quality_fraction: { type: 'number' },
          quality_per_position_mean: { type: 'array', items: { type: 'number' } },
        },
      },
      saved_to: { type: 'string' },
    },
  },
  render(value) {
    const s = value.stats;
    const lines = [
      `${value.format} ${value.action}: ${s.entries} entries, ${s.total_bases} bases, lengths ${s.min_length}-${s.max_length} (mean ${s.mean_length}), GC ${s.gc_percent}%`,
    ];
    if (s.quality_mean !== undefined) lines.push(`quality: mean ${s.quality_mean}, min ${s.quality_min}, max ${s.quality_max}, low-quality (<20) fraction ${s.low_quality_fraction}`);
    if (value.action === 'extract') {
      for (const entry of value.entries) lines.push(`  ${entry.id} (${entry.length} bp, GC ${entry.gc_percent}%)${entry.sequence !== undefined ? ': ' + entry.sequence : ''}`);
    } else if (value.entries.length > 0 && value.entries.length <= 20) {
      for (const entry of value.entries) lines.push(`  ${entry.id} (${entry.length} bp, GC ${entry.gc_percent}%)`);
    }
    if (value.saved_to !== undefined && value.saved_to !== '') lines.push(`saved to ${value.saved_to}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const action = args.action ?? 'stats';
    const bytes = await readFileBytes(ctx, exec, args.path);
    const text = new TextDecoder().decode(bytes);
    const first = text.replace(/^\uFEFF/, '').trimStart();
    const isFasta = first.startsWith('>');
    const parsed = isFasta ? parseFasta(text) : parseFastq(text);
    const format = isFasta ? 'fasta' : 'fastq';
    if (action === 'qc' && format !== 'fastq') throw new MolbioInputError('action=qc needs a FASTQ file');
    let savedTo = '';
    const fs = fsService(ctx);
    const sandboxPolicyService = ctx.get('sandboxPolicy');
    const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
    if (action === 'extract') {
      if (args.id === undefined || args.id === '') throw new MolbioInputError('action=extract needs an id');
      const exact = parsed.filter((entry) => entry.id === args.id);
      const matches = exact.length > 0 ? exact : parsed.filter((entry) => entry.id.includes(args.id));
      const outEntries = matches.map((entry) => ({
        id: entry.id,
        length: entry.sequence.length,
        gc_percent: gcPercentOf(entry.sequence),
        sequence: entry.sequence,
      }));
      if (args.output_path !== undefined && args.output_path !== '') {
        const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
        await writeWorkspaceFile(fs, file, toFasta(matches), policy);
        savedTo = file;
      }
      return {
        action,
        format,
        entries: outEntries.slice(0, 100),
        stats: entryStats(parsed),
        saved_to: savedTo,
      };
    }
    if (action === 'convert') {
      if (args.output_path === undefined || args.output_path === '') throw new MolbioInputError('action=convert needs an output_path');
      const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, toFasta(parsed), policy);
      return {
        action,
        format,
        entries: parsed.slice(0, 100).map((entry) => ({
          id: entry.id,
          length: entry.sequence.length,
          gc_percent: gcPercentOf(entry.sequence),
        })),
        stats: entryStats(parsed),
        saved_to: file,
      };
    }
    return {
      action,
      format,
      entries: parsed.slice(0, 100).map((entry) => ({
        id: entry.id,
        length: entry.sequence.length,
        gc_percent: gcPercentOf(entry.sequence),
      })),
      stats: entryStats(parsed, action === 'qc'),
      saved_to: '',
    };
  },
});

function gcPercentOf(sequence) {
  let gc = 0;
  let at = 0;
  for (const base of sequence) {
    if (base === 'G' || base === 'C') gc++;
    else if (base === 'A' || base === 'T') at++;
  }
  return gc + at === 0 ? 0 : Math.round((gc / (gc + at)) * 1000) / 10;
}

const extractRegionTool = (ctx) => define({
  safe: (args) => args.output_path === undefined || args.output_path === '',
  name: 'molbio_extract_region',
  description: 'Extract a sub-sequence from a plasmid (a .dna/.gb file or a raw sequence) by coordinates and/or feature name — e.g. pull a CDS, a promoter, or the MCS for downstream cloning or design. Optionally return the reverse complement and save the region as FASTA.',
  parameters: {
    type: 'object',
    properties: {
      source_path: { type: 'string', description: 'Path to a .dna/.gb plasmid file (alternative to sequence).' },
      sequence: { type: 'string', description: 'Raw sequence (alternative to source_path).' },
      feature: { type: 'string', description: 'Feature label to extract (e.g. "AmpR", "MCS"); overrides start/end.' },
      start: { type: 'integer', description: '1-based start (used when feature is not given).' },
      end: { type: 'integer', description: '1-based inclusive end.' },
      complement: { type: 'boolean', description: 'Return the reverse complement (e.g. the coding strand of a reverse-strand feature).' },
      output_path: { type: 'string', description: 'Optional FASTA output file in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'start', 'end', 'length', 'sequence', 'complement', 'saved_to'],
    properties: {
      source: { type: 'string' },
      feature_label: { type: 'string' },
      start: { type: 'integer' },
      end: { type: 'integer' },
      length: { type: 'integer' },
      sequence: { type: 'string' },
      complement: { type: 'boolean' },
      saved_to: { type: 'string' },
    },
  },
  render(value) {
    const lines = [
      `extracted ${value.source}${value.feature_label !== undefined ? ' feature ' + JSON.stringify(value.feature_label) : ''} ${value.start}-${value.end} (${value.length} bp${value.complement ? ', reverse complement' : ''}):`,
      value.sequence,
    ];
    if (value.saved_to !== '') lines.push(`saved to ${value.saved_to}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const vector = await resolveVector(ctx, exec, args, 'source_path');
    let start;
    let end;
    let featureLabel;
    if (args.feature !== undefined && args.feature !== '') {
      const label = args.feature.toLowerCase();
      const matches = vector.features.filter((f) => f.label.toLowerCase().includes(label));
      if (matches.length === 0) throw new MolbioInputError(`no feature matches ${JSON.stringify(args.feature)}; available: ${vector.features.map((f) => f.label).join(', ') || '(none)'}`);
      const exact = matches.find((f) => f.label.toLowerCase() === label) ?? matches[0];
      start = exact.start;
      end = exact.end;
      featureLabel = exact.label;
    } else {
      if (args.start === undefined || args.end === undefined) throw new MolbioInputError('provide feature, or start and end');
      start = args.start;
      end = args.end;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > vector.sequence.length || start > end) {
      throw new MolbioInputError(`invalid span ${start}-${end} (source length ${vector.sequence.length})`);
    }
    let fragment = vector.sequence.slice(start - 1, end);
    if (args.complement === true) fragment = reverseComplement(fragment);
    let savedTo = '';
    if (args.output_path !== undefined && args.output_path !== '') {
      const fs = fsService(ctx);
      const sandboxPolicyService = ctx.get('sandboxPolicy');
      const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
      const file = workspaceFilePath(args.output_path, exec, policy?.workspaceRoot);
      await writeWorkspaceFile(fs, file, `>${vector.name}_${start}-${end}\n${fragment}\n`, policy);
      savedTo = file;
    }
    return {
      source: vector.name,
      ...featureLabel !== undefined ? { feature_label: featureLabel } : {},
      start,
      end,
      length: fragment.length,
      sequence: fragment,
      complement: args.complement === true,
      saved_to: savedTo,
    };
  },
});

const pubmedAbstractTool = (ctx) => define({
  name: 'molbio_pubmed_abstract',
  description: 'Fetch PubMed abstracts for PMIDs via NCBI E-utilities (efetch). Requires the deployment to provide the web fetch capability; otherwise it reports that clearly. Use it to pull abstracts for papers found by molbio_pubmed_search before adding them to the library.',
  parameters: {
    type: 'object',
    required: ['pmids'],
    properties: {
      pmids: { type: 'array', items: { type: 'string' }, description: 'PubMed IDs, e.g. ["37607951"].' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['pmids', 'abstracts'],
    properties: {
      pmids: { type: 'array', items: { type: 'string' } },
      abstracts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pmid', 'title', 'abstract', 'error'],
          properties: {
            pmid: { type: 'string' },
            title: { type: 'string' },
            abstract: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    const lines = [];
    for (const entry of value.abstracts) {
      if (entry.error !== '') {
        lines.push(`PMID ${entry.pmid}: ${entry.error}`);
        continue;
      }
      lines.push(`PMID ${entry.pmid}: ${entry.title}`);
      lines.push(entry.abstract.length > 1200 ? entry.abstract.slice(0, 1200) + ' …' : entry.abstract);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const pmids = args.pmids.filter((pmid) => /^\d+$/.test(String(pmid).trim()));
    if (pmids.length === 0) throw new MolbioInputError('pmids must contain numeric PubMed IDs');
    const web = ctx.get('web');
    if (web === undefined || typeof web.fetch !== 'function') {
      throw new MolbioInputError('this deployment provides no web fetch capability, so PubMed abstracts cannot be retrieved; molbio_pubmed_search still works for titles and snippets');
    }
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
    const result = await web.fetch({ url }, exec?.signal);
    const body = result?.body?.content;
    if (typeof body !== 'string' || body === '') {
      throw new MolbioInputError(`efetch returned no content (status ${result?.statusCode ?? 'unknown'})`);
    }
    const doc = parseXml(body);
    const set = doc.children.find((node) => node.tag === 'PubmedArticleSet');
    const records = set === undefined ? [] : set.children.filter((node) => node.tag === 'PubmedArticle');
    const byPmid = new Map();
    for (const article of records) {
      const citation = article.children.find((node) => node.tag === 'MedlineCitation');
      const pmidNode = citation === undefined ? undefined : citation.children.find((node) => node.tag === 'PMID');
      const pmid = pmidNode === undefined ? '' : pmidNode.text.trim();
      const articleInfo = citation === undefined ? undefined : citation.children.find((node) => node.tag === 'Article');
      const titleNode = articleInfo === undefined ? undefined : articleInfo.children.find((node) => node.tag === 'ArticleTitle');
      const title = titleNode === undefined ? '' : titleNode.text.trim();
      const abstractNode = articleInfo === undefined ? undefined : articleInfo.children.find((node) => node.tag === 'Abstract');
      let abstractText = '';
      if (abstractNode !== undefined) {
        abstractText = abstractNode.children.filter((node) => node.tag === 'AbstractText').map((node) => node.text.trim()).filter((t) => t !== '').join(' ');
      }
      if (pmid !== '') byPmid.set(pmid, { title, abstract: abstractText });
    }
    const abstracts = pmids.map((pmid) => {
      const found = byPmid.get(pmid);
      if (found === undefined) return { pmid, title: '', abstract: '', error: 'no record returned by efetch' };
      return { pmid, title: found.title, abstract: found.abstract, error: '' };
    });
    return { pmids, abstracts };
  },
});

const bibtexTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_export_bibtex',
  description: 'Export the literature library (papers.json) to a BibTeX .bib file in the workspace. Optional tag_filter exports only papers carrying one of the given tags.',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
      output_path: { type: 'string', description: 'Output .bib path; default: the library path with a .bib extension.' },
      tag_filter: { type: 'array', items: { type: 'string' }, description: 'Only export papers with at least one of these tags.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['output_path', 'count'],
    properties: {
      output_path: { type: 'string' },
      count: { type: 'integer' },
    },
  },
  render(value) {
    return `exported ${value.count} reference(s) to ${value.output_path}`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const bibtex = toBibtex(library.papers, args.tag_filter);
    const output = args.output_path !== undefined && args.output_path !== ''
      ? workspaceFilePath(args.output_path, exec, policy?.workspaceRoot)
      : path.replace(/\.json$/i, '.bib');
    await writeWorkspaceFile(fs, output, bibtex, policy);
    return { output_path: output, count: bibtex.trim() === '' ? 0 : library.papers.filter((paper) => args.tag_filter === undefined || args.tag_filter.length === 0 || (paper.tags !== undefined && args.tag_filter.some((tag) => paper.tags.includes(tag)))).length };
  },
});

const PROTOCOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'created_at'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    created_at: { type: 'string' },
    category: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    parameters: { type: 'object', additionalProperties: true },
    source_paper_id: { type: 'string' },
  },
};

const EXPERIMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'date', 'logged_at'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    date: { type: 'string' },
    logged_at: { type: 'string' },
    protocol_id: { type: 'string' },
    paper_ids: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    results: { type: 'string' },
  },
};

const protocolAddTool = (ctx) => define({
  safe: false,
  name: 'molbio_protocol_add',
  description: 'Save a protocol to the protocol library (protocols.json in the workspace): name, optional category, ordered steps, a free-form parameters object, and an optional source paper id from the literature library.',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: requiredString('Protocol name (unique in the library).'),
      category: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Ordered protocol steps.' },
      parameters: { type: 'object', additionalProperties: true, description: 'Free-form parameters (reagent volumes, temperatures, timings).' },
      source_paper_id: { type: 'string', description: 'Paper id from molbio_paper_list, when the protocol comes from a paper.' },
      file: { type: 'string', description: 'Protocols file; default protocols.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'protocol', 'total'],
    properties: {
      file: { type: 'string' },
      protocol: PROTOCOL_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    const lines = [`saved protocol ${value.protocol.id} "${value.protocol.name}" to ${value.file} (${value.total} total)`];
    if (value.protocol.steps !== undefined) {
      lines.push('steps:');
      value.protocol.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path, policy } = recordDeps(ctx, exec, args, 'protocols.json');
    const data = await loadRecords(fs, path, 'protocols');
    const protocol = addProtocol(data.protocols, args);
    await saveRecords(fs, path, data, policy);
    return { file: path, protocol, total: data.protocols.length };
  },
});

const protocolListTool = (ctx) => define({
  name: 'molbio_protocol_list',
  description: 'List the protocol library (protocols.json in the workspace).',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Protocols file; default protocols.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'protocols'],
    properties: {
      file: { type: 'string' },
      protocols: { type: 'array', items: PROTOCOL_SCHEMA },
    },
  },
  render(value) {
    if (value.protocols.length === 0) return `no protocols in ${value.file}`;
    const lines = [`${value.protocols.length} protocol(s) in ${value.file}:`];
    for (const protocol of value.protocols) {
      lines.push(`- ${protocol.id}: ${protocol.name}${protocol.category !== undefined ? ` [${protocol.category}]` : ''}${protocol.steps !== undefined ? ` (${protocol.steps.length} steps)` : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path } = recordDeps(ctx, exec, args, 'protocols.json');
    const data = await loadRecords(fs, path, 'protocols');
    return { file: path, protocols: data.protocols };
  },
});

const protocolUpdateTool = (ctx) => define({
  safe: false,
  name: 'molbio_protocol_update',
  description: 'Update a protocol by id (from molbio_protocol_list). Only supplied fields change; steps replace the whole step list.',
  parameters: {
    type: 'object',
    required: ['id'],
    properties: {
      id: requiredString('Protocol id to update.'),
      name: { type: 'string' },
      category: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
      parameters: { type: 'object', additionalProperties: true },
      source_paper_id: { type: 'string' },
      file: { type: 'string', description: 'Protocols file; default protocols.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'found', 'total'],
    properties: {
      file: { type: 'string' },
      found: { type: 'boolean' },
      protocol: PROTOCOL_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    return value.found
      ? `updated protocol "${value.protocol.name}" in ${value.file} (${value.total} total)`
      : `no protocol with that id in ${value.file} — list ids with molbio_protocol_list`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = recordDeps(ctx, exec, args, 'protocols.json');
    const data = await loadRecords(fs, path, 'protocols');
    const protocol = updateProtocol(data.protocols, args.id, args);
    if (protocol === undefined) return { file: path, found: false, total: data.protocols.length };
    await saveRecords(fs, path, data, policy);
    return { file: path, found: true, protocol, total: data.protocols.length };
  },
});

const experimentLogTool = (ctx) => define({
  safe: false,
  name: 'molbio_experiment_log',
  description: 'Append an entry to the experiment log (experiments.json in the workspace): title, date (default today), optional protocol id, related paper ids, free-text notes and results.',
  parameters: {
    type: 'object',
    required: ['title'],
    properties: {
      title: requiredString('Experiment title.'),
      date: { type: 'string', description: 'Experiment date (YYYY-MM-DD); default today.' },
      protocol_id: { type: 'string', description: 'Protocol id from molbio_protocol_list.' },
      paper_ids: { type: 'array', items: { type: 'string' }, description: 'Related paper ids from the literature library.' },
      notes: { type: 'string' },
      results: { type: 'string' },
      file: { type: 'string', description: 'Experiments file; default experiments.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'experiment', 'total'],
    properties: {
      file: { type: 'string' },
      experiment: EXPERIMENT_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    const e = value.experiment;
    const lines = [`logged experiment ${e.id} "${e.title}" (${e.date}) to ${value.file} (${value.total} total)`];
    if (e.protocol_id !== undefined) lines.push(`protocol: ${e.protocol_id}`);
    if (e.paper_ids !== undefined && e.paper_ids.length > 0) lines.push(`papers: ${e.paper_ids.join(', ')}`);
    if (e.results !== undefined) lines.push(`results: ${e.results}`);
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path, policy } = recordDeps(ctx, exec, args, 'experiments.json');
    const data = await loadRecords(fs, path, 'experiments');
    const experiment = addExperiment(data.experiments, args);
    await saveRecords(fs, path, data, policy);
    return { file: path, experiment, total: data.experiments.length };
  },
});

const experimentListTool = (ctx) => define({
  name: 'molbio_experiment_list',
  description: 'List the experiment log (experiments.json in the workspace).',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Experiments file; default experiments.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'experiments'],
    properties: {
      file: { type: 'string' },
      experiments: { type: 'array', items: EXPERIMENT_SCHEMA },
    },
  },
  render(value) {
    if (value.experiments.length === 0) return `no experiments logged in ${value.file}`;
    const lines = [`${value.experiments.length} experiment(s) in ${value.file}:`];
    for (const experiment of value.experiments) {
      lines.push(`- ${experiment.id}: ${experiment.date} ${experiment.title}${experiment.protocol_id !== undefined ? ` [protocol ${experiment.protocol_id}]` : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path } = recordDeps(ctx, exec, args, 'experiments.json');
    const data = await loadRecords(fs, path, 'experiments');
    return { file: path, experiments: data.experiments };
  },
});

function recordDeps(ctx, exec, args, defaultFile) {
  const fs = fsService(ctx);
  const sandboxPolicyService = ctx.get('sandboxPolicy');
  const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
  const path = recordPath(args, exec, policy?.workspaceRoot, defaultFile);
  return { fs, path, policy };
}

// ── literature assistant ────────────────────────────────────────────────────

const PAPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'added_at'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    added_at: { type: 'string' },
    pmid: { type: 'string' },
    url: { type: 'string' },
    authors: { type: 'string' },
    year: { type: 'string' },
    journal: { type: 'string' },
    note: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const PAPER_IN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string' },
    pmid: { type: 'string' },
    url: { type: 'string' },
    authors: { type: 'string' },
    year: { type: 'string' },
    journal: { type: 'string' },
    note: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

function paperServiceDeps(ctx, exec, args) {
  const fs = ctx.get('fs');
  if (fs === undefined) throw new MolbioInputError('the filesystem service is not available in this composition; the paper library needs ctx.fs');
  const sandboxPolicyService = ctx.get('sandboxPolicy');
  const policy = sandboxPolicyService?.resolve({ ...exec?.agent !== undefined ? { session: exec.agent.session } : {} });
  const path = libraryPath(args, exec, policy?.workspaceRoot);
  return { fs, path, policy };
}

const pubmedSearchTool = (ctx) => define({
  name: 'molbio_pubmed_search',
  description: 'Search the web for literature (PubMed results preferred). Uses the harness web-search service; returns up to max_results sources with titles, snippets, URLs and extracted PMIDs. Add the ones you keep to the reading library with molbio_paper_add.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: requiredString('Search query, e.g. "CRISPR base editing review 2024" or "site:pubmed.ncbi.nlm.nih.gov KRAS G12D".'),
      max_results: { type: 'integer', description: 'Maximum results (1-20, default 8).' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'sources'],
    properties: {
      query: { type: 'string' },
      answer: { type: 'string' },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'url'],
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
            pmid: { type: 'string' },
          },
        },
      },
    },
  },
  render(value) {
    if (value.sources.length === 0) return `no results for "${value.query}"`;
    const lines = [`results for "${value.query}":`];
    if (value.answer !== undefined) lines.push(value.answer);
    for (const source of value.sources) {
      const pmid = source.pmid !== undefined ? ` [PMID ${source.pmid}]` : '';
      lines.push(`- ${source.title}${pmid} — ${source.url}`);
      if (source.snippet !== undefined) lines.push(`  ${source.snippet}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const web = ctx.get('web');
    if (web === undefined) throw new MolbioInputError('the web search service is not available in this composition; molbio_pubmed_search needs ctx.web');
    const maxResults = args.max_results ?? 8;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
      throw new MolbioInputError('max_results must be an integer between 1 and 20');
    }
    const result = await web.search({ query: args.query, maxResults }, exec?.signal);
    const sources = result.sources.map((source) => {
      const pmid = pmidFromUrl(source.url ?? '');
      return {
        title: source.title ?? '',
        url: source.url ?? '',
        ...source.snippet !== undefined && source.snippet !== '' ? { snippet: source.snippet } : {},
        ...pmid !== undefined ? { pmid } : {},
      };
    });
    return {
      query: args.query,
      ...result.content !== undefined ? { answer: result.content } : {},
      sources,
    };
  },
});

const paperAddTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_add',
  description: 'Append papers to the literature library (a JSON file, default papers.json in the session workspace). Entries are deduplicated by PMID, then URL, then title+year. Takes an array of papers with at least a title; pmid/url/authors/year/journal/note/tags are optional.',
  parameters: {
    type: 'object',
    required: ['papers'],
    properties: {
      papers: { type: 'array', items: PAPER_IN_SCHEMA, description: 'Papers to add.' },
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'added', 'total'],
    properties: {
      file: { type: 'string' },
      added: { type: 'array', items: PAPER_SCHEMA },
      total: { type: 'integer' },
    },
  },
  render(value) {
    return `added ${value.added.length} paper(s); library now holds ${value.total} paper(s) in ${value.file}`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const added = addPapers(library, args.papers);
    await saveLibrary(fs, path, library, policy);
    return { file: path, added, total: library.papers.length };
  },
});

const paperListTool = (ctx) => define({
  name: 'molbio_paper_list',
  description: 'List the literature library (default papers.json in the session workspace).',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'papers'],
    properties: {
      file: { type: 'string' },
      papers: { type: 'array', items: PAPER_SCHEMA },
    },
  },
  render(value) {
    if (value.papers.length === 0) return `the library at ${value.file} is empty`;
    const lines = [`${value.papers.length} paper(s) in ${value.file}:`];
    for (const paper of value.papers) {
      lines.push(`- ${paper.id}: ${paper.title}${paper.year !== undefined ? ' (' + paper.year + ')' : ''}${paper.tags !== undefined && paper.tags.length > 0 ? ' [tags: ' + paper.tags.join(', ') + ']' : ''}`);
    }
    return lines.join('\n');
  },
  async execute(args, exec) {
    const { fs, path } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    return { file: path, papers: library.papers };
  },
});

const paperUpdateTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_update',
  description: 'Update one paper in the literature library by id (the id is the PMID, URL, or title:year key shown by molbio_paper_list). Only the supplied fields change; tags replace the whole tag list.',
  parameters: {
    type: 'object',
    required: ['id'],
    properties: {
      id: requiredString('The paper id to update.'),
      title: { type: 'string' },
      note: { type: 'string' },
      authors: { type: 'string' },
      year: { type: 'string' },
      journal: { type: 'string' },
      url: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'found', 'total'],
    properties: {
      file: { type: 'string' },
      found: { type: 'boolean' },
      paper: PAPER_SCHEMA,
      total: { type: 'integer' },
    },
  },
  render(value) {
    if (!value.found) return `no paper with id in ${value.file} — list ids with molbio_paper_list`;
    return `updated "${value.paper.title}" in ${value.file} (${value.total} paper(s) total)`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const paper = updatePaper(library, args.id, args);
    if (paper === undefined) return { file: path, found: false, total: library.papers.length };
    await saveLibrary(fs, path, library, policy);
    return { file: path, found: true, paper, total: library.papers.length };
  },
});

const paperRemoveTool = (ctx) => define({
  safe: false,
  name: 'molbio_paper_remove',
  description: 'Remove one paper from the literature library by id (use molbio_paper_list to see ids).',
  parameters: {
    type: 'object',
    required: ['id'],
    properties: {
      id: requiredString('The paper id to remove.'),
      file: { type: 'string', description: 'Library file path; default papers.json in the workspace.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'removed', 'total'],
    properties: {
      file: { type: 'string' },
      removed: { type: 'boolean' },
      total: { type: 'integer' },
    },
  },
  render(value) {
    return value.removed
      ? `removed the paper; ${value.total} paper(s) remain in ${value.file}`
      : `no paper with that id in ${value.file} — list ids with molbio_paper_list`;
  },
  async execute(args, exec) {
    const { fs, path, policy } = paperServiceDeps(ctx, exec, args);
    const library = await loadLibrary(fs, path);
    const removed = removePaper(library, args.id);
    if (removed) await saveLibrary(fs, path, library, policy);
    return { file: path, removed, total: library.papers.length };
  },
});

// ── plugin apply ────────────────────────────────────────────────────────────

const PROMPT_SECTION = `Molecular-biology tools (dsh-molbio-tools) are available with the molbio_* prefix:
- Sequence math: molbio_reverse_complement, molbio_gc_content, molbio_translate, molbio_restriction_sites.
- Primer work: molbio_design_primers (automatic pair design), molbio_design_intron_primers (qPCR primers spanning an exon-exon junction against a genomic sequence + exon list, so gDNA does not amplify), molbio_primer_tm, molbio_primer_check.
- qPCR and bench math: molbio_qpcr_analysis, molbio_lab_math.
- Plasmids: molbio_parse_genbank (GenBank text), molbio_parse_snapgene (SnapGene .dna files — researchers usually have .dna files, so when the user names a .dna path use this), molbio_plasmid_map_file (reads a .dna/.gb file and writes the map SVG directly into the workspace in one call), molbio_plasmid_map (same, from a sequence + features). Both map tools WRITE the .svg file themselves and return svg_path — never try to reproduce SVG text in the conversation; just tell the user the file path to open in a browser.
- Cloning: molbio_unique_cutters (pick enzymes that cut the vector once and never the insert), molbio_clone_simulate (restriction-ligation or Gibson assembly → final plasmid sequence + verification digests; pass save_path to write a FASTA), molbio_clone_primers (enzyme tails or Gibson arms on amplification primers, with re-checks), molbio_mutagenesis_primers (QuickChange-style mutation primers).
- Verification: molbio_verify_sanger (read .ab1/.seq traces, align to the reference plasmid — circular-aware — and report mismatches/indels/amino-acid changes).
- Proteins: molbio_protein_props (MW/pI/A280/GRAVY — estimates), molbio_peptide_digest (trypsin etc. for MS), molbio_codon_optimize (E. coli/yeast/human, can avoid restriction sites).
- Quantitation: molbio_qpcr_efficiency (standard curve + plot), molbio_plot (bar/scatter SVG charts written to files).
- Sequences & files: molbio_align (local alignment with a readable match line), molbio_fasta_fastq (FASTA/FASTQ stats/extract/convert/QC on workspace files), molbio_extract_region (pull a CDS/promoter/region from a plasmid file by feature label or coordinates).
- Map extras: pass gc_skew: true for the GC skew ring, show_unique_cutters: true to mark single-cutting enzymes on the map.
- Literature & records: molbio_pubmed_abstract (fetch abstracts by PMID — works only when the deployment provides web fetch), molbio_paper_export_bibtex (papers.json → .bib), molbio_protocol_add / molbio_protocol_list / molbio_protocol_update (protocols.json), molbio_experiment_log / molbio_experiment_list (experiments.json).
- Literature: molbio_pubmed_search (web search), and the reading library molbio_paper_add / molbio_paper_list / molbio_paper_update / molbio_paper_remove (papers.json in the workspace).

Cloning workflow rules (follow them to avoid slow re-derivation):
- To clone a sequence into a plasmid, call molbio_clone_simulate FIRST — pass the BARE insert with add_flanks: true and the tool adds the enzyme recognition sites itself. The tool also validates single cutting, insert orientation, and internal sites itself: never pre-verify enzymes, cutting counts, or flank construction by thinking. Its output already contains final_sequence AND the remapped feature coordinates (features field). NEVER recompute feature coordinates or insert positions by reasoning — always take them from the tool output.
- To draw the new plasmid, either pass map_path to molbio_clone_simulate (one call writes the SVG with remapped features and verification enzymes marked) or feed its features + final_sequence to molbio_plasmid_map. Never rebuild the feature list by hand.
- Insert orientation is the tool's job: orientation=auto (the default) reverse-complements an inverted insert automatically. If the tool still reports an inverted insert, pass orientation=reverse instead of re-deriving coordinates.
- Never parse tool outputs with regex, shell commands, or throwaway scripts — every tool returns structured data that feeds the next tool directly. Mutation descriptions (A123G etc.) are parsed by molbio_mutagenesis_primers, not by you.
- All tools are pure computations except the paper library, pubmed search, and file-backed outputs, which use the harness filesystem and web services under the usual sandbox policy. The Tm model is a SantaLucia-1998 nearest-neighbour estimate — always say it is an estimate.`;

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:molbio',
    order: 110,
    text: PROMPT_SECTION,
  });
  const tools = [
    reverseComplementTool,
    gcTool,
    translateTool,
    restrictionTool,
    primerTmTool,
    primerCheckTool,
    qpcrTool,
    labMathTool,
    designPrimersTool,
    intronPrimersTool(ctx),
    parseGenbankTool,
    plasmidMapTool(ctx),
    parseSnapgeneTool(ctx),
    plasmidMapFileTool(ctx),
    uniqueCuttersTool(ctx),
    cloneSimulateTool(ctx),
    clonePrimersTool(ctx),
    mutagenesisTool,
    verifySangerTool(ctx),
    proteinPropsTool,
    peptideDigestTool,
    codonOptimizeTool,
    qpcrEfficiencyTool(ctx),
    plotTool(ctx),
    alignTool,
    fastaFastqTool(ctx),
    extractRegionTool(ctx),
    pubmedAbstractTool(ctx),
    bibtexTool(ctx),
    protocolAddTool(ctx),
    protocolListTool(ctx),
    protocolUpdateTool(ctx),
    experimentLogTool(ctx),
    experimentListTool(ctx),
    pubmedSearchTool(ctx),
    paperAddTool(ctx),
    paperListTool(ctx),
    paperUpdateTool(ctx),
    paperRemoveTool(ctx),
  ];
  for (const tool of tools) ctx.tools.register(tool);
}
